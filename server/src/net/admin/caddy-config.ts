// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The reverse proxy's configuration, written BY the dashboard.
//
// It used to be a hand-edited .env file next to docker-compose.yml, and the wizard's hosting
// step ended with "here is the line, go and put it in a file we cannot reach". For an
// audience assumed never to have opened a shell, that is not a setup step, it is where setup
// stops. So the proxy now reads its whole config out of the data directory, which is the one
// place both containers share and the server already owns.
//
// Caddy runs with --watch, so writing this file IS applying it: no restart, no compose
// command, nothing for the operator to do. The domain arrives from the wizard, lands here,
// and a certificate is issued within seconds.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from '../../log';

export interface ProxySettings {
  /** Empty means no domain: localhost with a self-signed certificate. */
  domain: string;
  /** Upstream container name and port, as compose names them. */
  upstream?: string;
}

/**
 * Render the Caddyfile.
 *
 * The localhost block is ALWAYS present, whether or not a domain is set. Losing access to
 * the dashboard is the worst failure this file can cause, and the operator's own machine is
 * how they would fix it — a mistyped domain must not take the admin page down with it.
 */
export function renderCaddyfile({ domain, upstream = 'openmw-web:8080' }: ProxySettings): string {
  const site = (address: string, tls: string): string => `
${address} {
${tls}
	encode zstd gzip

	# WITHOUT THESE THREE HEADERS THERE IS NO GAME.
	#
	# The engine is a pthreads build: it needs SharedArrayBuffer, and a browser only hands that
	# out to a cross-origin-isolated page. Miss them and every browser on earth lands on
	# "Browser not supported" — which reads as a client bug and is not one. play/server.py sent
	# these from the start, so the game ran under the python dev server and not through this
	# proxy, and the difference looked like Docker being broken.
	#
	# Site-wide rather than on the client's paths only: the isolation applies to the DOCUMENT,
	# and the document at / is served by the server upstream, not from /srv/client.
	header {
		Cross-Origin-Opener-Policy "same-origin"
		Cross-Origin-Embedder-Policy "require-corp"
		# Lets our own assets be embedded by the isolated document. Same-origin would do here,
		# but this matches what play/server.py sends, and one of the two is not worth diverging.
		Cross-Origin-Resource-Policy "cross-origin"
	}

	root * /srv/client

	# NOT EVERYTHING IN THE CLIENT FOLDER IS FOR THE PUBLIC.
	#
	# The folder served here is the repo's play/, which is where the player app actually
	# lives, and it also carries development scaffolding: a local python server, the launcher
	# shortcuts, and mwdata/ — the operator's own copy of Morrowind, hundreds of megabytes of
	# a game they are not licensed to redistribute. Serving that to anyone who asked would be
	# the worst bug in this file, so it is refused by path before the file server ever runs.
	#
	# A deny list rather than an allow list, deliberately: the client's own filenames change
	# with every engine build (openmw.wasm, openmw.data, and their brotli siblings), and an
	# allow list would silently stop serving the game the first time one was renamed. What
	# must never leak is a short, stable set.
	@private path /server.py /__pycache__/* /.env* /START-HERE.txt /*.bat /*.command
	handle @private {
		respond "not found" 404
	}

	# /mwdata/* IS THE SERVER'S ANSWER TO GIVE, NOT THIS FILE'S.
	#
	# It used to be denied outright here, which was right when the only thing behind it was
	# play/mwdata — a developer's own copy of Morrowind sitting in the source tree, which must
	# never be served. But it is also the path the game page fetches when the operator answered
	# "this server hands out the files", so a flat 404 made that answer impossible to honour.
	#
	# Proxied BEFORE the static handler, so the folder in the source tree is still never
	# served: these requests reach the server, which publishes the library the DASHBOARD
	# uploaded into and refuses with 404 unless the stored answer says to serve it.
	@mwdata path /mwdata/* /mwdata-manifest.json
	handle @mwdata {
		reverse_proxy ${upstream}
	}

	# The ROOT path always goes to the server, even when client files are staged: the server
	# serves the sign-in landing page there, and the game (launcher.html and friends) is what
	# that page links into.
	@root path /
	handle @root {
		reverse_proxy ${upstream}
	}

	# ONE ORIGIN, AND WHY IT MATTERS.
	#
	# The game page hands the server a session ticket, and it refuses to hand that ticket to a
	# different hostname. So the client and the server cannot be split across two names. Both
	# are served from here.
	#
	# The rule is "a real file wins, everything else is the server". That needs no list of the
	# server's paths, so it cannot drift as the server grows new ones, and it degrades
	# correctly: with no client files staged, /srv/client is empty, nothing matches, and every
	# request goes to the server.
	@static file
	handle @static {
		file_server {
			# The engine ships brotli siblings next to openmw.wasm/.data; serve those when the
			# browser accepts them rather than re-compressing multi-megabyte files per request.
			precompressed br gzip
		}
	}

	handle {
		# Tells the server it is behind HTTPS, which is how it decides whether cookies may
		# carry the Secure flag. Caddy sets the header itself.
		reverse_proxy ${upstream}
	}

	log {
		output stdout
		format json
	}
}`;

  const header = `# GENERATED BY THE OPENMW-WEB DASHBOARD. Edits are overwritten.
#
# Written whenever the setup wizard's hosting answers change. Caddy runs with --watch, so
# saving this file applies it: a domain set in the browser gets a certificate within seconds,
# with nothing to restart and no file to hand-edit.
#
# To take this over by hand, point the caddy service at your own config in docker-compose.yml
# instead of at this directory.

{
	# Add "email you@example.com" if you want Let's Encrypt to warn you about renewal
	# problems. Deliberately not required: needing an email address to start a game server is
	# friction, and Caddy renews unattended regardless.
	admin off
}
`;

  // With a domain, the domain block gets a real certificate and localhost keeps its
  // self-signed one. Both listen, so the admin page is reachable either way.
  const blocks = domain === ''
    ? [site('localhost', '\ttls internal')]
    : [site(domain, '\t# Let\'s Encrypt, automatically. No directive means a public certificate.'),
       site('localhost', '\ttls internal')];

  return `${header}${blocks.join('\n')}\n`;
}

/** Where the generated config lives inside the shared data directory. */
export function caddyfilePath(dataDir: string): string {
  return join(dataDir, 'caddy', 'Caddyfile');
}

/**
 * Write the config if it differs from what is already there.
 *
 * Idempotent on purpose: this runs on every boot as well as on every hosting change, and
 * rewriting an identical file would make Caddy's --watch reload for no reason on each
 * restart. Never throws — a proxy that cannot be reconfigured must not stop the server that
 * serves the page explaining why.
 */
export function writeCaddyfile(dataDir: string, settings: ProxySettings): boolean {
  const path = caddyfilePath(dataDir);
  const next = renderCaddyfile(settings);
  try {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* first run */ }
    if (current === next) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, 'utf8');
    log('info', 'proxy.config_written', { path, domain: settings.domain || '(none)' });
    return true;
  } catch (e) {
    log('warn', 'proxy.config_write_failed', { path, error: String(e) });
    return false;
  }
}
