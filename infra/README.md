<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Infrastructure — openmw-web as a container on a shared box

openmw-web ships as a **self-contained Docker image** (nginx + the built site) that plugs
into a **shared reverse proxy** on a VM you manage separately. The box is a shared resource,
so it is deliberately **not** provisioned by this repo — one app's IaC must never be able to
destroy the box other sites live on. This repo owns only the openmw container and how it's
built and published.

```
visitors ─HTTPS─▶ Cloudflare (free CDN + edge TLS, caches wasm/data)
                       ▼
      shared VM · reverse proxy (Traefik/nginx-proxy) on network "proxy"
        Host: play.example.com → openmw container :80   ← this repo
        Host: mycoolapp.com    → app container    :3000 ← another repo
```

- The openmw container serves the **COOP/COEP** headers itself, so it works behind any
  Host-routing proxy and needs no special proxy config (SharedArrayBuffer requires them).
- TLS is terminated upstream (the shared proxy and Cloudflare). The container speaks plain
  HTTP on `:80` inside the `proxy` network.
- "Mix of both" domains is fine: each registrable domain is its own Cloudflare zone; every
  hostname is a proxied record pointing at the box IP.

## Files

| Path | Purpose |
|------|---------|
| `Dockerfile` | nginx + the built site, COOP/COEP baked in |
| `nginx.conf` | the server config inside the image |
| `docker-compose.yml` | the openmw service + Traefik labels for the shared proxy |
| `SHARED-BOX-SETUP.md` | one-time **manual** setup of the shared VM + proxy + Cloudflare |
| `../.dockerignore` | keeps the build context to just what the image needs |
| `../.github/workflows/deploy-openmw.yml` | build the image → publish to GHCR |

## Build & publish (this repo)

The engine binaries are gitignored, so publish them to a GitHub Release after a local build,
then let CI build the image:

```bash
git tag -a v1.4.0 -m "openmw-web 1.4.0" && git push origin v1.4.0
```

The **release** workflow builds the engine, publishes `openmw-web-<tag>.zip` (the whole served
web root: `index.html`, `launcher.html`, the content-versioned engine under `e/<hash>/`, the demo
asset pack) and then dispatches **build-openmw-image**, which unzips that bundle, builds
`infra/Dockerfile` from it, and pushes `ghcr.io/<owner>/openmw-web:latest` (+ a `sha-…` tag). No
box access or long-lived keys are used — just the repo's `GITHUB_TOKEN`. (It is dispatched
explicitly because a release created with `GITHUB_TOKEN` raises no `release` event for other
workflows; `gh workflow run deploy-openmw.yml -f release_tag=<tag>` rebuilds any release by hand.)

Build it locally to test:

```bash
# from repo root: unpack a release bundle into dist/web first (that is the image's only input)
gh release download v1.3.0 --dir dist --pattern 'openmw-web-v1.3.0.zip'
unzip -q dist/openmw-web-v1.3.0.zip -d dist/web
docker build -f infra/Dockerfile -t openmw-web:test .
docker run --rm -p 8080:80 openmw-web:test
# then browse http://localhost:8080  (note: no cross-origin isolation over plain http on a
# non-localhost host — locally it's fine; in prod Cloudflare/proxy provide HTTPS)
```

## Deploy to the shared box

One-time: follow [`SHARED-BOX-SETUP.md`](SHARED-BOX-SETUP.md) (VM, proxy, `docker network create
proxy`, Cloudflare). Then add openmw:

```bash
# on the box — set the image OWNER and the Host() domain in docker-compose.yml first
docker compose pull openmw && docker compose up -d openmw
```

Roll out a new build by re-running those two commands (or run **Watchtower** to auto-pull).
**Purge the Cloudflare cache** for the openmw host after each engine update — the artifacts are
cached for a year on purpose.

## Adding another site to the box

Same pattern, no changes here: give the other app its own container + compose service with a
`Host()` label on the `proxy` network (and a proxied Cloudflare record → the box IP). Static
sites mirror this image; dynamic ones expose their app port instead of `:80`. Keep backends
lean — the `e2-micro` has 1 GB RAM (the swapfile is a safety net, not headroom).
