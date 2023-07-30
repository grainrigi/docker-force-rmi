# rmi.js : Force docker

## DISCLAIMER

:warning::warning: **This is an unofficial tool to remove docker images. There is no guarantee that this works properly, and might damage your docker system PERMANENTLY.**
**USE THIS AT YOUR OWN RISK!** :warning::warning:

## What's this?

Sometimes, you get `No such image:` error when you try to remove an imgage,
even if the image is listed on 

This occurs when an image exists with name `docker.io/[image-name]` in your docker daemon's image database,
but the plain `[image-name]` doesn't.

In this case, you cannot remove the image and its content using docker CLI.

This tool helps to remove such images.

## Usage

Note: Node.js 16+ is required.


```sh
chmod +x rmi.js
./rmi.js [image digest1] [image digest2] ...
```

**IMPORTANT!** Only image digest (partial should be fine) can be used to specify the image.


