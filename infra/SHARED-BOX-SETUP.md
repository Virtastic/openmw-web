<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Shared box setup (one-time, manual)

This box is a **shared resource** across several sites, so it is **not** managed by any one
app's IaC — you set it up by hand once, and each site (openmw-web included) ships as a
container that plugs into the shared reverse proxy. This doc is the reference for that
one-time box setup; adapt it to your preferences.

## 1. The VM (manual)

Create a GCP always-free `e2-micro` (free only in `us-west1` / `us-central1` / `us-east1`),
Ubuntu 24.04, 30 GB standard disk, and a static external IP:

```bash
gcloud compute instances create shared-web \
  --zone=us-central1-a --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard --tags=web
gcloud compute addresses create shared-web-ip --region=us-central1
# then assign the reserved IP to the instance's access config
```

Firewall — 80/443 **only from Cloudflare**, SSH only via IAP:

```bash
gcloud compute firewall-rules create allow-web-cloudflare --network=default \
  --allow=tcp:80,tcp:443 --target-tags=web \
  --source-ranges="$(curl -s https://www.cloudflare.com/ips-v4 | paste -sd, -),$(curl -s https://www.cloudflare.com/ips-v6 | paste -sd, -)"
gcloud compute firewall-rules create allow-ssh-iap --network=default \
  --allow=tcp:22 --target-tags=web --source-ranges=35.235.240.0/20
```

Then on the box: **2 GB swap** (1 GB RAM is tight) and **Docker**:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
curl -fsSL https://get.docker.com | sudo sh
sudo docker network create proxy      # the shared reverse-proxy network
```

## 2. The shared reverse proxy (Traefik example)

One proxy fronts every site and routes by `Host`. TLS: use Cloudflare **Full (strict)** with
a Traefik-managed cert (Let's Encrypt DNS-01 via Cloudflare, or a Cloudflare Origin cert).
Minimal Traefik compose on the box:

```yaml
services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      # --entrypoints.web.http.redirections.entryPoint.to=websecure
      # (add your ACME/Cloudflare cert resolver here)
    ports: ["80:80", "443:443"]
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
    networks: [proxy]
networks:
  proxy: { external: true }
```

Any site container with `traefik.enable=true` + a `Host()` rule on the `proxy` network is now
routed automatically. Adding a site = drop its compose service, `docker compose up -d`.

> Alternative proxies: **jwilder/nginx-proxy** (routes by `VIRTUAL_HOST` env) or **Caddy**.
> The openmw container works behind any of them — it only needs Host → container:80.

## 3. Cloudflare (per site)

For each domain/subdomain (mix of zones is fine — one zone per registrable domain):

- **DNS:** proxied (orange-cloud) `A`/`CNAME` → the box IP.
- **SSL/TLS:** Full (or Full strict if the proxy has a real/origin cert).
- **openmw host only:** turn **Rocket Loader OFF** and **Email Obfuscation OFF** (they inject
  cross-origin scripts that COEP `require-corp` blocks — the game won't boot otherwise).
- **Cache rule** on the openmw host: make `.wasm`/`.data`/`.js` eligible for cache with a long
  edge TTL, so origin egress stays inside the free tier. Enable **Tiered Cache**.

## 4. Add openmw-web to the box

Copy `infra/docker-compose.yml` onto the box (set the image `OWNER` and the `Host()` domain),
then:

```bash
docker compose pull openmw && docker compose up -d openmw
```

CI rebuilds and pushes the image on each release; re-run those two commands (or run Watchtower)
to roll it out, and **purge the Cloudflare cache** for the openmw host after an engine update.
