# Ways to install openmw-web

Every install runs the same server image, `ghcr.io/virtastic/openmw-web-server`. The options
below only differ in what sits around it. Pick the row that matches you:

| You want | Use | Support |
|---|---|---|
| The easy way: it sets up HTTPS for you | [`setup.sh`](#1-the-script-recommended) | **Supported** |
| No script, no git clone | [`docker-compose.yml`](#2-compose-without-the-script) | **Supported** |
| "I don't want SSL" / I already run nginx, Traefik, Caddy, a tunnel | [`docker-compose.simple.yml` behind your proxy](#3-behind-your-own-proxy) | Documented |
| Pterodactyl or Pelican panel | [the egg](#4-pterodactyl--pelican) | Documented |
| Unraid, Kubernetes, Portainer templates, bare metal… | the image, [`docs/ADVANCED.md`](docs/ADVANCED.md) | Community |
| Just play, no accounts or dashboard | [the static bundle](SELF_HOSTING.md#static-hosting-without-the-dashboard) | Supported |

What the support levels mean:

- **Supported:** we test it every release. If it breaks, it's our bug, so report it.
- **Documented:** this page has a working recipe. We fix our recipe, but we can't debug your
  proxy or panel config.
- **Community:** the image works there, but nobody here tests it. Recipes are welcome as PRs.

## The one rule: players need HTTPS

**Browsers only start the game on `https://` or on `http://localhost`.** This isn't our choice.
The engine needs browser features (cross-origin isolation, `SharedArrayBuffer`) that browsers
only turn on for a secure page.

So "no SSL" means one of two things:

- **You only play on the machine running the server.** Open `http://localhost:8080` and
  plain HTTP is fine.
- **Someone else handles HTTPS:** your own proxy, a Cloudflare Tunnel, or a panel's proxy. The
  server runs plain HTTP behind it. That's option 3.

A plain `http://192.168.x.x` or `http://your-ip:port` link that other players open **cannot
work**, whatever the server does. The dashboard (`/admin`) works over plain HTTP. The game does
not.

## 1. The script (recommended)

```bash
git clone https://github.com/Virtastic/openmw-web.git
cd openmw-web
./setup.sh        # Windows: .\setup.ps1
```

This sets up Caddy in front, which gets a real certificate once you give the setup wizard a
domain. It's the only option where the dashboard's **Update** button can update the server
itself. Details: [`SELF_HOSTING.md`](SELF_HOSTING.md).

## 2. Compose without the script

Save [`docker-compose.yml`](docker-compose.yml) in an empty folder, run `docker compose up -d`
and open `http://localhost/admin`. It's the same stack as the script. Update by hand with
`docker compose pull && docker compose up -d`.

## 3. Behind your own proxy

Run the server alone on plain HTTP:

```bash
docker compose -f docker-compose.simple.yml up -d     # listens on :8080
```

In the setup wizard's hosting step, choose **Internal or behind your own proxy**. Then point
your proxy at port 8080 and **forward everything**: the server serves the game, the dashboard
and the multiplayer WebSockets on one port. Do not split paths across hostnames: the game and
the server must share one origin.

Your proxy needs to do five things. Most support threads come from one of these:

1. **Pass WebSocket upgrades** (`/ws`, `/w/<world>`). Without this the game loads, then can't
   connect.
2. **Accept request bodies of at least 100 MB.** Uploads go up in parts of up to 96 MB.
   nginx's default is **1 MB**, so uploads fail with `413` until you raise it.
3. **Allow long-lived connections.** Use a read timeout of an hour or more, so a quiet
   WebSocket or a slow upload isn't cut off.
4. **Send `X-Forwarded-Proto: https`.** That tells the server players are on HTTPS, so sign-in
   cookies work.
5. **Append to `X-Forwarded-For`, and run on a private address** (same machine, Docker
   network or LAN). The server only trusts that header from a private address, and reads the
   last entry. If your proxy is on a public address, every player counts as one IP and the
   per-IP sign-in limits lock people out.

Don't add COOP/COEP headers yourself: the server already sends them. Just don't strip them.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name morrowind.example.com;
    # ssl_certificate / ssl_certificate_key: yours (certbot, etc.)

    client_max_body_size 100m;          # default is 1m: uploads fail with 413 without this

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_request_buffering off;    # stream uploads instead of spooling them to disk
    }
}

# In the http {} block, once:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

### Caddy (your own, not ours)

```caddy
morrowind.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy handles WebSockets, the forwarded headers and body size by default.

### Traefik (Docker labels on the `openmw-web` service)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.openmw.rule=Host(`morrowind.example.com`)
  - traefik.http.routers.openmw.entrypoints=websecure
  - traefik.http.routers.openmw.tls.certresolver=letsencrypt
  - traefik.http.services.openmw.loadbalancer.server.port=8080
```

Traefik passes WebSockets and has no body limit by default. If your entrypoint sets
`respondingTimeouts.readTimeout`, raise it to an hour or more.

### Cloudflare Tunnel

Point the tunnel's public hostname at `http://localhost:8080`. Cloudflare's own limit is
100 MB per request, which the uploader already stays under. If Cloudflare is also in front as
a proxy, set `[limits] trustCloudflareIp = true` so players get their real IPs.

### Check it

Open `https://morrowind.example.com/admin`. If the dashboard loads, routing works. Start a
game. If it gets stuck connecting, it's WebSockets (rule 1). If an upload fails with `413`,
it's the body limit (rule 2).

## 4. Pterodactyl / Pelican

Import [`pterodactyl/egg-openmw-web.json`](pterodactyl/egg-openmw-web.json). Full steps and
limits are in [`pterodactyl/README.md`](pterodactyl/README.md). The panel doesn't provide
HTTPS, so for other players put a proxy from option 3 in front of the allocation's port.

## Asking for help

Say which row above you picked and include:

- your proxy config, if you used option 3 or 4;
- the browser console output (F12 → Console) from the moment it fails;
- `docker compose logs --tail 100 openmw-web`.

Post it in [Discord](https://discord.gg/PzFfDkbSue) or an issue.
