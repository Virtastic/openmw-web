# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# SPDX-License-Identifier: GPL-3.0-or-later
# Part of openmw-web.
import http.server, socketserver, os, re, io, json, socket, threading, webbrowser

# Load play/.env (KEY=VALUE, # comments) WITHOUT clobbering real env vars, so the launcher
# flag can live in a git-ignored file next to this server. Env always wins over .env.
def _load_dotenv(path):
    try:
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                os.environ.setdefault(k, v)
    except OSError:
        pass

_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

PORT = 8910
# Bind localhost by default. This is a LOCAL self-host dev server: it serves the current directory
# with directory listing and no auth, so it should not be exposed on a network. Set OPENMW_HOST=0.0.0.0
# (and firewall the port) only if you deliberately want it reachable from other machines.
HOST = os.environ.get('OPENMW_HOST', '127.0.0.1').strip() or '127.0.0.1'
# The bare site root serves the data-chooser launcher, matching the deployed site (deploy/Caddyfile
# rewrites "/" to launcher.html). ON by default: without it a fresh unzip drops the player straight
# into the game with no way to pick the demo or point at their own Morrowind.
# OPENMW_LAUNCHER=0 (env or play/.env) opts out and boots the game at "/".
LAUNCHER = os.environ.get('OPENMW_LAUNCHER', '1').strip().lower() not in ('0', 'false', 'no', '')

# --- Multiplayer gateway, on THIS origin ---------------------------------------------------
# The game page and the MP server MUST share an origin: index.html refuses to hand its session
# ticket to a gateway on a different hostname. In production the container's Caddy proxies
# these paths (deploy/Caddyfile); locally this dev server has to do the same job, or the
# launcher derives ws://127.0.0.1:8910/ws and finds nothing but a static file server.
#
# Relaying raw bytes rather than parsing and rebuilding a response handles plain HTTP and the
# WebSocket upgrade with ONE code path — and /w/<worldId> is an upgrade, so a response-parsing
# proxy would need the splice logic anyway.
MP_UPSTREAM = os.environ.get('OPENMW_MP_UPSTREAM', '127.0.0.1:8080').strip()

def _is_gateway_path(path):
    p = path.split('?', 1)[0]
    # /w/<id> is the gameplay socket, /ws is the launcher's origin base + local direct-dial
    # fallback. /admin, /metrics, /healthz and /status are deliberately NOT forwarded.
    return (p.startswith(('/w/', '/auth/', '/locker/', '/worlds/'))
            or p in ('/worlds', '/ws'))


class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _relay_to_gateway(self):
        """Splice this connection to the MP gateway, verbatim in both directions."""
        host, _, port = MP_UPSTREAM.partition(':')
        try:
            up = socket.create_connection((host, int(port or 8080)), timeout=10)
        except OSError as e:
            # Match what the real gateway does for a world that is down: fail the handshake
            # so the client's retry ladder can run, rather than hanging.
            self.send_error(502, 'multiplayer gateway unreachable at %s (%s)' % (MP_UPSTREAM, e))
            return
        self.close_connection = True
        try:
            head = '%s %s HTTP/1.1\r\n' % (self.command, self.path)
            for k, v in self.headers.items():
                head += '%s: %s\r\n' % (k, v)
            up.sendall((head + '\r\n').encode('latin-1'))
            n = int(self.headers.get('Content-Length') or 0)
            if n:
                up.sendall(self.rfile.read(n))

            down = self.connection

            def pump(src, dst):
                try:
                    while True:
                        b = src.recv(65536)
                        if not b:
                            break
                        dst.sendall(b)
                except OSError:
                    pass
                finally:
                    for s in (src, dst):
                        try:
                            s.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass

            t = threading.Thread(target=pump, args=(up, down), daemon=True)
            t.start()
            pump(down, up)
            t.join(timeout=5)
        finally:
            try:
                up.close()
            except OSError:
                pass

    # Every verb the gateway is reached with routes through the same relay. POST matters:
    # creating or joining a private world is POST /worlds.
    def do_GET(self):
        if _is_gateway_path(self.path):
            return self._relay_to_gateway()
        return super().do_GET()

    def do_HEAD(self):
        if _is_gateway_path(self.path):
            return self._relay_to_gateway()
        return super().do_HEAD()

    def do_POST(self):
        if _is_gateway_path(self.path):
            return self._relay_to_gateway()
        self.send_error(501, 'Unsupported method (POST)')

    def do_OPTIONS(self):
        if _is_gateway_path(self.path):
            return self._relay_to_gateway()
        self.send_error(501, 'Unsupported method (OPTIONS)')

    def send_head(self):
        # Launcher gate: ONLY the bare root serves the chooser, which is exactly what the
        # deployed edge does (infra/nginx.conf: `location = / { try_files /launcher.html; }`).
        #
        # /index.html used to be rewritten too, with a query string as the escape hatch. That
        # made the gate depend on a query existing: the moment the launcher moved its boot
        # params into the FRAGMENT (fragments never reach a server), the boot URL became a
        # bare /index.html, was rewritten back to the launcher, and multiplayer looped between
        # the two forever. Production was never affected, because nginx only ever matched `/`.
        # Asking for /index.html explicitly means asking for the game.
        if LAUNCHER and self.path == '/':
            self.path = '/launcher.html'
        # Self-host path: list whatever is actually in mwdata/ so the game page can load a real
        # "Data Files" folder copied there as-is. That lets a host ship the game data WITH the
        # server — the player just opens the page, nothing to upload and no launcher step — and
        # it removes the pre-packed .tar archives, which existed only in the maintainer's tree
        # and which no retail install could ever supply.
        if self.path.split('?', 1)[0] == '/mwdata-manifest.json':
            root = os.path.join(os.getcwd(), 'mwdata')
            out = []
            for dirpath, _, names in os.walk(root):
                for n in names:
                    if n.startswith('.') or n.endswith('.br'):
                        continue  # dotfiles and brotli siblings aren't game data
                    p = os.path.join(dirpath, n)
                    try:
                        out.append({'p': os.path.relpath(p, root).replace(os.sep, '/'),
                                    's': os.path.getsize(p)})
                    except OSError:
                        pass
            body = json.dumps(out).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        # HTTP Range support (python's SimpleHTTPRequestHandler has none) — required for the
        # ?stream lazy-BSA mode (emscripten FS.createLazyFile reads the archives in chunks).
        rng = self.headers.get('Range')
        path = self.translate_path(self.path.split('?', 1)[0])
        if rng and os.path.isfile(path):
            m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
            if m and (m.group(1) or m.group(2)):
                size = os.path.getsize(path)
                start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
                end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
                end = min(end, size - 1)
                if start <= end:
                    f = open(path, 'rb')
                    f.seek(start)
                    self.send_response(206)
                    self.send_header('Content-Type', self.guess_type(path))
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
                    self.send_header('Content-Length', str(end - start + 1))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.end_headers()
                    # SimpleHTTPRequestHandler.copyfile would send to EOF; wrap to the range length
                    class _Ranged:
                        def __init__(self, fp, n): self.fp, self.n = fp, n
                        def read(self, sz=-1):
                            if self.n <= 0: return b''
                            sz = self.n if sz < 0 else min(sz, self.n)
                            d = self.fp.read(sz); self.n -= len(d); return d
                        def close(self): self.fp.close()
                    return _Ranged(f, end - start + 1)
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % os.path.getsize(path))
                self.end_headers()
                return None
        # Serve a precompressed sibling (<file>.br) when present, fresh, and accepted —
        # roughly halves the first-visit download of the .esm/.wasm/.data payloads.
        # (wasm-build/make_br.sh generates them; the mtime check falls back to the raw
        # file if a redeploy left a stale .br behind.)
        path = self.translate_path(self.path.split('?', 1)[0])
        br = path + '.br'
        if (not path.endswith('.br') and os.path.isfile(path) and os.path.isfile(br)
                and os.path.getmtime(br) >= os.path.getmtime(path)
                and 'br' in self.headers.get('Accept-Encoding', '')):
            try:
                f = open(br, 'rb')
            except OSError:
                return super().send_head()
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(os.fstat(f.fileno()).st_size))
            self.send_header('Content-Encoding', 'br')
            self.end_headers()
            return f
        return super().send_head()

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
url = f"http://{HOST}:{PORT}/"
# Bind BEFORE announcing, so a failure never prints "serving …" and then dies. Constructing the
# server binds AND listens, so the browser can connect immediately afterwards — no sleep or
# background thread needed. OPENMW_OPEN=0 to stay put (headless/QA runs).
try:
    srv = socketserver.ThreadingTCPServer((HOST, PORT), H)
except OSError as e:
    # Non-technical users double-click this; a raw traceback tells them nothing. The common
    # case by far is a second copy already running, or the port taken by something else.
    print(f"\nCould not start on port {PORT}: {e.strerror or e}\n")
    print("Most likely openmw-web is already running — check your browser or")
    print(f"other terminal windows, or just open  http://{HOST}:{PORT}/")
    print(f"\nOtherwise, use a different port:   PORT=8911 python3 server.py")
    raise SystemExit(1)
print(f"openmw-web: serving {url}  "
      f"(local only; set OPENMW_HOST=0.0.0.0 to expose on your network)")
print(f"           multiplayer paths (/w/ /auth/ /locker/ /worlds /ws) -> {MP_UPSTREAM}  "
      f"(set OPENMW_MP_UPSTREAM to change)")
if os.environ.get('OPENMW_OPEN', '1').strip().lower() not in ('0', 'false', 'no', ''):
    print("opening your browser… (needs desktop Chrome/Chromium; OPENMW_OPEN=0 to skip)")
    webbrowser.open(url)
srv.serve_forever()
