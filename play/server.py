# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
# SPDX-License-Identifier: GPL-3.0-or-later
# Part of openmw-web.
import http.server, socketserver, os, re

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
# When set (e.g. OPENMW_LAUNCHER=1 in env or play/.env), the bare site root serves the
# data-chooser launcher instead of dropping straight into the game. Off = current behavior.
LAUNCHER = os.environ.get('OPENMW_LAUNCHER', '').strip().lower() not in ('', '0', 'false', 'no')

class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

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
print(f"openmw-web: serving http://{HOST}:{PORT}/  "
      f"(local only; set OPENMW_HOST=0.0.0.0 to expose on your network)")
socketserver.ThreadingTCPServer((HOST, PORT), H).serve_forever()
