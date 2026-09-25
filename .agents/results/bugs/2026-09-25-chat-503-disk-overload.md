# Agent chat blocked by disk-pressure guard

## User-visible failure

The Agent UI returned `system disk overloaded (current: 96.2%, threshold: 95%)` for a plain text chat turn. The API container remained healthy; the relay middleware rejected the request before inference.

## Root cause

The production root disk is a 40 GB `/dev/vda3` filesystem with about 1.3 GB free (97% rounded by `df`). The largest avoidable use is the deployed New API image history: its current image has 79 layers and repeated 126–130 MB copies of `/new-api`. Earlier deployment Dockerfiles used the previous `lain42/new-api` image as their base, then copied the new binary over it. Each rollout therefore retained another old binary layer. Docker reported 10.27 GB of images, including about 9.5 GB of shared historical layers.

The middleware's 95% disk threshold turns that capacity issue into a hard rejection for every relay request. Clearing `/root/.cache/uv` reclaimed only about 200 MB because its reported cache size overstated its physical disk use; it did not address the growing image chain.

Other large directories include `/opt/rembg-ui` (5.5 GB) and `/var/www/html/models` (3.8 GB). They contain active application/model assets and must be preserved.

## Resolution

- Build a clean runtime image from a pinned Debian base in GitHub Actions, packaging the already-tested Linux binary rather than using the previous production image as a base.
- CI rejects images over 1 GB or with more than 8 layers and uploads a compressed image artifact.
- Deployed `lain42/new-api:agent-flat-d8ed1b5`, a 225 MB, 5-layer image built from the tested GitHub Actions artifact. The old deployment chain was removed only after the new container was healthy and a clean rollback image for the previous production binary had been loaded.
- Kept the existing data, logs, database, model assets, and application mounts intact.

## Verification

- GitHub Actions run [36136594475](https://github.com/lilyco-42/new-api/actions/runs/36136594475) passed the frontend/backend tests and clean-image packaging; the image-size/layer guard passed (224,682,586 bytes, 5 layers).
- The production container is `running healthy`; `/api/status` returns HTTP 200.
- Authenticated website chat completed `say hi` with `你好！` in 1.12 seconds.
- After removing the obsolete image chain, `/dev/vda3` reports 29 GB used, 10 GB available (75%); Docker reports 1.057 GB across all images.
