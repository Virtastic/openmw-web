# Bringing multiplayer up on the OVH box

`morrowind.virtastic.app` has run single player since 1.0.x. Multiplayer has never been
provisioned there, so the first `ovhcloud` push needs the box prepared first. Verified on
2026-08-10:

| prereq | state |
|---|---|
| `/opt/openmw-mp/data` | absent |
| `/opt/openmw-mp/data/config.toml` | absent |
| `/opt/openmw-mp/gamedata` (note: NOT under data/) | absent |
| game data for the sim peer | absent |
| `/opt/edge/certs/virtastic.{crt,key}` | present (shared edge already running) |
| shared `edge-caddy` + `nostalgia` network | present |

There is **no** `mp.` subdomain and there never will be. The game page and the gateway are one
origin: `index.html` refuses to hand its session ticket to a gateway whose hostname differs from
the page's, so a separate origin can never receive it. The gateway is reached through the game's
own Caddy at `morrowind.virtastic.app/auth/*`, `/locker/*`, `/saves*`, `/worlds` and `/w/*`. See
AGENTS.md, "One origin".

Pushing `ovhcloud` before these exist runs both workflows. `deploy-mp` would fail its own
healthcheck, and `deploy-ovh` would meanwhile publish a launcher advertising multiplayer and a
cloud locker that cannot work. The order below avoids that.

## 1. OAuth redirect URIs

Each provider console needs the **production** callback added. The dev credentials will not work
against a new origin: providers match the redirect URI exactly.

```
https://morrowind.virtastic.app/auth/google/callback
https://morrowind.virtastic.app/auth/discord/callback
https://morrowind.virtastic.app/auth/microsoft/callback
```

Google Cloud console, Discord developer portal, Azure app registration. Use separate production
credentials rather than reusing the dev ones, so revoking one does not take the other down.

## 2. `/opt/openmw-mp/data/config.toml`

Create the directory and the file. The workflow creates the directory but never writes this
file, and never touches its contents on later deploys.

```toml
[server]
password = "<a long random string>"      # the sim peer authenticates with this

[auth]
requireSso = true                        # forces allowPasswordLogin off. Do not skip this.
returnUrl  = "https://morrowind.virtastic.app/launcher.html"

[auth.google]
enabled = true
clientId = "..."
clientSecret = "..."
redirectUri = "https://morrowind.virtastic.app/auth/google/callback"

# ...and the same three keys for [auth.discord] and [auth.microsoft].

[limits]
trustCloudflareIp = true                 # production IS behind Cloudflare. Do not skip this.

[locker]
endpoint = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
region   = "auto"
bucket   = "omw-lockers"

[dev]
bots = 0                                 # the default, stated so nobody wonders
```

The two settings called out above are the ones that are silently wrong if omitted:

- **`requireSso = true`**: without it, account and password login stays open beside SSO. It is
  invisible in the UI, because the launcher only draws SSO buttons. The server warns at boot
  (`frontdoor.password_login_open`).
- **`trustCloudflareIp = true`**: without it, every player resolves to the Cloudflare edge
  address, so `loginPerMinPerIp = 5` applies to the whole player base at once and the sixth
  person to sign in in a minute is refused. The server logs `net.client_ip_mode` at boot.

Mode `600`, owned by whoever the container runs as, or the container cannot read it and dies at
`loadConfig`.

## 3. S3 credentials

These go in the environment, never the config file. `server/docker-compose.prod.yml` expects an
env file beside it.

```
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

## 4. Game data for the sim peer

The sim peer is a headless OpenMW and needs real game data. Drop it in
`/opt/openmw-mp/gamedata` - NOT `/opt/openmw-mp/data/gamedata`. docker-compose.prod.yml mounts
`/opt/openmw-mp/data:/data` and then overlays `/opt/openmw-mp/gamedata:/data/gamedata:ro`, so
anything placed under `data/gamedata` is shadowed and the server reports the directory empty.
Without game data it refuses to boot, deliberately: a peer with no data silently simulates
nothing.

Also set, or the locker hands players presigned URLs pointing at 127.0.0.1:

```toml
[locker]
publicBase = "https://morrowind.virtastic.app"
```

## 5. Then deploy

```bash
git push origin main:ovhcloud
```

Watch both workflows. `deploy-mp` ends with a healthcheck that connects a bot over the real
WebSocket, so a green run means the server actually accepts a session rather than merely
starting.

## 6. Verify before announcing

```bash
ci/jenkins/verify-mp-hardening.sh https://morrowind.virtastic.app 10
```

Then confirm by hand, because nothing automated covers it: sign in with a real provider account,
upload a copy of Morrowind through the wizard, and play. That path uses SSO plus the locker, and
the browser harness authenticates with a password instead, so it is the one part of the funnel
that has never been exercised end to end.

Also check the boot log says what you expect:

```bash
docker logs openmw-mp 2>&1 | grep -E "client_ip_mode|password_login_open|devbots.enabled"
```

Expected: `trustCloudflareIp: true`, and no `password_login_open` or `devbots.enabled` lines.
