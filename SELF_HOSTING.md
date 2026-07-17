# Self-hosting openmw-web

Grab `openmw-web-<tag>.zip` from
[Releases](https://github.com/Virtastic/openmw-web/releases) — it contains the
prebuilt engine and everything below. No compiler needed.

## Quick start (local)

```bash
unzip openmw-web-*.zip -d openmw-web && cd openmw-web
python3 server.py          # http://localhost:8795 (override with PORT=…)
```

Open the URL in **desktop Chrome/Chromium**. `?nomw` boots the bundled
free demo world; the launcher (`launcher.html`) lets players stream their own
legally-owned Morrowind data straight from disk.

## The serving contract

The engine is multi-threaded WASM, which requires **cross-origin isolation**.
Your server must send these headers on **every** response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Plus:

- **HTTPS** (or `http://localhost`) — isolation is only granted on secure origins.
- `application/wasm` MIME type for `.wasm`.
- Serve the precompressed `.br` siblings with `Content-Encoding: br` when the
  client accepts brotli — this turns the ~42 MB wasm into ~11 MB and the demo
  data into ~34 MB over the wire. (`server.py` does this automatically.)
- Support **Range requests** on `openmw.data` (used by the streaming loader).
- Long cache lifetimes are safe on `openmw.{js,wasm,data}` — purge or rename on
  redeploy.

### nginx

```nginx
server {
    listen 443 ssl http2;
    root /srv/openmw-web;
    types { application/wasm wasm; }

    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy require-corp  always;
    add_header Cross-Origin-Resource-Policy cross-origin  always;

    brotli_static on;   # serve the .br siblings (ngx_brotli)
}
```

### Caddy

```caddy
example.com {
    root * /srv/openmw-web
    header {
        Cross-Origin-Opener-Policy   same-origin
        Cross-Origin-Embedder-Policy require-corp
        Cross-Origin-Resource-Policy cross-origin
    }
    file_server {
        precompressed br
    }
}
```

Static hosts (Netlify, Cloudflare Pages, …) work too — set the same three
headers in the host's headers config.

## Browser support

Desktop Chrome/Chromium only (SharedArrayBuffer + WebGL2/ANGLE +
`EXT_clip_control` + File System Access API). Firefox/Safari/mobile are not
supported.

## Licensing notes for hosts

The bundle is GPLv3 (see `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`). If
you host it, link to the source (this repository or the matching
`openmw-web-src-<tag>.tar.gz`) somewhere reasonable — the included pages
already do this in their footers, so leaving them intact is enough. The demo
world is freely-licensed content (see `CREDITS-DEMO-DATA.txt`); Morrowind
game data is **not** included and must never be bundled by hosts either.

---
WASM port © 2025–2026 [Virtastic](https://virtastic.app) — GPL-3.0-or-later
