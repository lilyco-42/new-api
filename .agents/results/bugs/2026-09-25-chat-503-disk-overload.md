# Agent chat blocked by disk-pressure guard

## User-visible failure

The Agent UI returned `system disk overloaded (current: 96.2%, threshold: 95%)` for a plain text chat turn. The API container remained healthy; the relay middleware rejected the request before inference.

## Root cause

The production root disk is a 40 GB `/dev/vda3` filesystem with about 1.3 GB free (97% rounded by `df`). The largest avoidable use is the deployed New API image history: its current image has 79 layers and repeated 126–130 MB copies of `/new-api`. Earlier deployment Dockerfiles used the previous `lain42/new-api` image as their base, then copied the new binary over it. Each rollout therefore retained another old binary layer. Docker reported 10.27 GB of images, including about 9.5 GB of shared historical layers.

The middleware's 95% disk threshold turns that capacity issue into a hard rejection for every relay request. Clearing `/root/.cache/uv` reclaimed only about 200 MB because its reported cache size overstated its physical disk use; it did not address the growing image chain.

Other large directories include `/opt/rembg-ui` (5.5 GB) and `/var/www/html/models` (3.8 GB). They contain active application/model assets and must be preserved.

## Fix in progress

- Build a clean runtime image from a pinned Debian base in GitHub Actions, packaging the already-tested Linux binary rather than using the previous production image as a base.
- CI rejects images over 1 GB or with more than 8 layers and uploads a compressed image artifact.
- Deploy and health-check the clean image before removing any obsolete chained images. Keep the existing data and logs mounts; do not rebuild or touch the database/model data on the server.
- Preserve an old-version rollback image built from the current deployed source before pruning the 79-layer chain.

## Verification still required

- GitHub Actions frontend/backend tests and clean-image packaging pass.
- Production container reports healthy and `/api/status` succeeds after switching.
- Authenticated plain-text chat succeeds through the website.
- After old image references are pruned, verify the root filesystem has at least 2 GB free and the runtime image has at most 8 layers.
