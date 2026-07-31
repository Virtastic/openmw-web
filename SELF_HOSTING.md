# Self-hosting openmw-web

Grab `openmw-web-<tag>.zip` from
[Releases](https://github.com/Virtastic/openmw-web/releases) — it contains the
prebuilt engine and everything below. No compiler needed.

## Quick start (local)

```bash
unzip openmw-web-*.zip -d openmw-web && cd openmw-web
python3 server.py          # http://localhost:8910 (override with PORT=…)
```

Open the URL in **desktop Chrome/Chromium**. The root (`/`) serves the
data-chooser launcher, same as the live site: players pick either the bundled
free demo world or their own legally-owned Morrowind data, streamed straight
from disk. Set `OPENMW_LAUNCHER=0` to skip the chooser and boot the game
directly at `/` instead.

## Serving your own Morrowind with the site

If you own Morrowind and want the game to *come with* your server — so players
open the page and start, with nothing to pick and nothing to upload — copy the
contents of your `Data Files` folder into a `mwdata/` folder next to
`server.py`:

```
openmw-web/
├── server.py
├── index.html
└── mwdata/
    ├── Morrowind.esm
    ├── Morrowind.bsa
    ├── Fonts/  Music/  Sound/  Splash/  Video/
    └── …plus Tribunal/Bloodmoon and any mods, if you have them
```

Then start the server with the chooser turned off, so `/` boots straight into
the game:

```bash
OPENMW_LAUNCHER=0 python3 server.py
```

(Leave it on if you'd rather players still got the choice — the chooser's own
"bring your own copy" option keeps working either way.)

The server lists whatever is actually in `mwdata/` and the page loads exactly
that, so:

- **The base game on its own is enough.** Expansions are optional — nothing
  breaks if you don't own them.
- **Mods work.** Extra `.esm`/`.esp`/`.bsa` dropped in are picked up
  automatically (alphabetically; `?nomods=1` plays vanilla). A precise custom
  load order still needs a desktop mod manager.
- **Nothing is repacked.** Copy the folder as-is; there are no archives to
  build. Files are read in chunks over HTTP Range as the engine needs them, so
  the browser never downloads the whole 1.5 GB up front.

Your server needs **Range request** support for this (`server.py` has it; the
nginx and Caddy configs below are fine as written).

> **Do not put Morrowind data in a public release or a public web root you don't
> control.** You may serve your own copy to yourself; redistributing Bethesda's
> game data is a different thing entirely. See *Licensing notes for hosts*.

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
