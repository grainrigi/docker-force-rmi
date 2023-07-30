# rmi.js : docker image remover

## :warning::warning: DISCLAIMER :warning::warning:

**This is an unofficial tool to remove docker images. There is no guarantee that this works properly, and might damage your docker system PERMANENTLY.**
**USE THIS AT YOUR OWN RISK!**

## What's this?

Sometimes, you get `No such image:` error when you try to remove an image,
even if the image is listed in `docker image ls` result.

This occurs when the image exists with name `docker.io/[image-name]` in your docker daemon's image database,
but the plain `[image-name]` doesn't.
(You can check `/var/lib/docker/image/overlay2/repositories.json` to confirm if this is the case.)

In this case, you cannot remove the image and its content using docker CLI.

This tool helps to remove such images.

## Usage

Note: Node.js 16+ is required.


```sh
chmod +x rmi.js
./rmi.js [image digest1] [image digest2] ...
```

**IMPORTANT!** Only image digest (partial should be fine) can be used to specify the image.


