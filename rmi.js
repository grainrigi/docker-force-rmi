#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
const childProcess = require('child_process');

const digestRegex = /^[0-9a-f]{64}$/;
const digestPartRegex = /^[0-9a-f]{8}[0-9a-f]*$/;

class Repository {
  loadTree(tree) {
    this.tag2digest = new Map();
    this.digest2tags = new Map();

    for (const [_, images] of Object.entries(tree)) {
      for (const [tag, digest] of Object.entries(images)) {
        this.tag2digest.set(tag, digest);
        const tags = this.digest2tags.get(digest);
        if (tags) {
          tags.push(tag);
        } else {
          this.digest2tags.set(digest, [tag]);
        }
      }
    }

    return this;
  }

  byTag(tag) {
    return this.tag2digest.get(tag);
  }

  loadMap(map) {
    this.tag2digest = new Map(map);
    for (const [tag, digest] of Object.entries(map)) {
      const tags = this.digest2tags.get(digest);
      if (tags) {
        tags.push(tag);
      } else {
        this.digest2tags.set(digest, [tag]);
      }
    }
  }


  deleteImage(digest) {
    for (const tag of this.digest2tags.get(digest)) {
      console.log(`untag ${tag}`);
      this.tag2digest.delete(tag);
    }
    this.digest2tags.delete(digest);
  }
}

class Mutator {
  constructor(dockerDir = '/var/lib/docker') {
    this.dockerDir = dockerDir;
    const overlay2 = path.join(this.dockerDir, 'image/overlay2')
    this.repos = JSON.parse(fs.readFileSync(path.join(overlay2, 'repositories.json'), 'utf-8'));
    this.removeRepoPaths = [];
    this.removeDirs = [];
  }
  
  show() {
    console.log('Spliced Indices:');
    this.removeRepoPaths.forEach(r => console.log(r));
    console.log('Removed Dirs:');
    this.removeDirs.forEach(r => console.log(r));
  }

  commit() {
    const overlay2 = path.join(this.dockerDir, 'image/overlay2')
    fs.writeFileSync(path.join(overlay2, 'repositories.json'), JSON.stringify(this.repos));
    childProcess.execSync(`rm -rf ${this.removeDirs.map(v => `"${v}"`).join(' ')}`);
  }

  deleteImageFromRepo(digest) {
    // walk through repository
    for (const name in this.repos.Repositories) {
      const repo = this.repos.Repositories[name];
      for (const tag in repo) {
        if (repo[tag] === 'sha256:' + digest) {
          this.removeRepoPaths.push(`${name}.${tag}: ${repo[tag]}`);
          delete repo[tag];
        }
      }
    }
  }

  deleteImage(digest) {
    const overlay2 = path.join(this.dockerDir, 'image/overlay2')


    const imgdb = path.join(overlay2, 'imagedb/content/sha256');
    const imgmetadb = path.join(overlay2, 'imagedb/metadata/sha256');
    this.removeDirs.push(path.join(imgdb, digest));
    this.removeDirs.push(path.join(imgmetadb, digest));
  }

  deleteLayer(digest) {
    const overlay2 = path.join(this.dockerDir, 'image/overlay2')
    const layerdb = path.join(overlay2, 'layerdb/sha256');
    this.removeDirs.push(path.join(layerdb, digest));
  }

  deleteCache(digest) {
    const caches = path.join(this.dockerDir, 'overlay2');
    this.removeDirs.push(path.join(caches, digest));
  }
}

class Registry {
  constructor(dockerDir = '/var/lib/docker') {
    this.dockerDir = dockerDir;
  }

  collect() {
    const overlay2 = path.join(this.dockerDir, 'image/overlay2')
    const imgdb = path.join(overlay2, 'imagedb/content/sha256');
    const imgmetadb = path.join(overlay2, 'imagedb/metadata/sha256');
    const layerdb = path.join(overlay2, 'layerdb/sha256');
    const caches = path.join(this.dockerDir, 'overlay2');

    const repos = JSON.parse(fs.readFileSync(path.join(overlay2, 'repositories.json'), 'utf-8'));
    this.repos = new Repository().loadTree(repos.Repositories);

    const images = fs.readdirSync(imgdb);
    this.images = new Map(images.map((img) => {
      const content = JSON.parse(fs.readFileSync(path.join(imgdb, img), 'utf-8'));
      let parent = undefined;
      const parentPath = path.join(imgmetadb, img, 'parent');
      if (fs.existsSync(parentPath)) {
        parent = fs.readFileSync(parentPath, 'utf-8');
      }
      let lastDigest = "";
      return [img, {
        digest: img,
        parent,
        layers: content.rootfs.diff_ids.map(
          (diff) =>
            lastDigest = (lastDigest
              ?  'sha256:' + createHash('sha256').update(`${lastDigest} ${diff}`).digest('hex')
              : diff)
        ),
      }];
    }));

    // images which are already dangling seem to be used by some container, so exclude them
    for (const dangling of this.danglingImages()) {
      this.images.delete(dangling);
    }

    const layers = fs.readdirSync(layerdb);
    this.layers = new Map(layers.map((layer) => {
      const cacheId = fs.readFileSync(path.join(layerdb, layer, 'cache-id'), 'utf-8');
      return [layer, {
        digest: layer,
        cacheId,
      }];
    }));

    this.caches = new Set(fs.readdirSync(caches));
    const original = new Set(this.caches.values());
    for (const value of original.values()) {
      if (!value.match(digestRegex) || original.has(value + '-init')) {
        this.caches.delete(value);
      }
    }
  }

  dataPath = '/tmp/rmi.registry.json';

  save() {
    fs.writeFileSync(this.dataPath, JSON.stringify({
      repos: this.repos.tag2digest.entries(),
      images: this.images.entries(),
      layers: this.layers.entries(),
      caches: this.caches.values(),
    }));
  }

  load() {
    // disable cache
    this.collect();
    return;
    if (!fs.existsSync(this.dataPath)) {
      console.log('metadata cache not found. force collecting');
      this.collect();
      return;
    }
    const data = fs.readFileSync(this.dataPath, 'utf-8');
    this.repos = new Repository().loadMap(data.repos);
    this.images = new Map(data.images);
    this.layers = new Map(data.layers);
    this.caches = new Map(data.caches);
  }

  deleteImages(images, mutator) {
    const imgKeys = [...this.repos.digest2tags.keys()];
    for (const img of images) {
      // search image from repos
      let digest;
      let name;

      // search by digest part if possible
      if (!img.match(digestPartRegex)) {
        console.error('search criteria must be (part of) image digest');
        process.exit(1);
      }
      if (!digest) {
        digest = imgKeys.find(v => v.match(img));
      }

      if (digest) {
        this.repos.deleteImage(digest);
        mutator?.deleteImageFromRepo(digest.substring(7));
        console.log(`remove image: ${digest}`);
      } else {
        console.log('image not found', img);
      }
    }
  }

  garbageCollect(mutator) {
    for (const dangling of this.danglingImages()) {
      console.log(`unlink image: ${dangling}`);
      this.images.delete(dangling);
      mutator?.deleteImage(dangling);
    }
    for (const dangling of this.danglingLayers()) {
      console.log(`unlink layer: ${dangling}`);
      this.layers.delete(dangling);
      mutator?.deleteLayer(dangling);
    }
    for (const dangling of this.danglingCaches()) {
      console.log(`unlink cache: ${dangling}`);
      this.caches.delete(dangling);
      mutator?.deleteCache(dangling);
    }
  }

  danglingImages() {
    const unmarkedImages = new Set(this.images.keys());
    const markImage = (digest, depth = 0) => {
      const img = this.images.get(digest);
      if (!img) {
        if (depth > 0) {
          throw new Error('parent not found ' + digest);
        } else {
          // it is possible that the dockerd write back the original repository state to repository.json.
          // in such case, images which are in repository but not in content dir might be exist.
          // we are ignoring such image here.
          return;
        }
      }
      unmarkedImages.delete(digest);
      if (img.parent) {
        markImage(img.parent.substring(7), depth + 1);
      }
    }
    for (const repo of this.repos.digest2tags.keys()) {
      const digest = repo.substring(7);
      markImage(digest);
    }
    return [...unmarkedImages.values()];
  }

  danglingLayers() {
    const unmarkedLayers = new Set(this.layers.keys());
    for (const img of this.images.values()) {
      for (const layer of img.layers) {
        unmarkedLayers.delete(layer.substring(7));
      }
    }
    return [...unmarkedLayers.values()];
  }

  danglingCaches() {
    const unmarkedCaches = new Set(this.caches.values());
    for (const layer of this.layers.values()) {
      unmarkedCaches.delete(layer.cacheId);
    }
    return [...unmarkedCaches.values()];
  }
}

// first, try docker rmi
const deletionImages = process.argv.slice(2);
if (deletionImages.length === 0) {
  console.log('no image specified');
  process.exit(1);
}

let result;

try {
  result = childProcess.execSync(`docker rmi -f ${deletionImages.map(v => `"${v}"`).join(' ')} 2>&1`).toString();
} catch(e) {
  result = e.stdout.toString();
}
console.log('reply from docker rmi');
console.log(result);

if (!result) {
  process.exit(0);
}

// and detect No such image
const failedImages = [];
for (const l of result.split('\n')) {
  const m = l.match('^Error: No such image: (.*)$');
  if (m) {
    failedImages.push(m[1]);
  }
}

const registry = new Registry();
const mutator = new Mutator();

registry.collect();

// console.log([...registry.images.values()][100]);

registry.deleteImages(failedImages, mutator);
registry.garbageCollect(mutator);

mutator.show();
mutator.commit();
