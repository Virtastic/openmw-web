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
  /** Empty means no domain, which now also means plain HTTP — see `internal`. */
  domain: string;
  /**
   * LAN, port-forwarding, or somebody else's reverse proxy in front. Plain HTTP, no
   * certificate, no redirect.
   *
   * This used to serve a SELF-SIGNED certificate instead, which is the wrong answer for every
   * one of those cases: a browser on the LAN shows a full-page warning, port-forwarding hands
   * the internet a certificate nothing trusts, and a reverse proxy in front has to be told to
   * ignore an upstream certificate it should never have been offered. Whoever is in front —
   * nginx, Traefik, a tunnel, or nothing — is where TLS belongs in this mode.
   */
  internal?: boolean;
  /** Which port to listen on. Only meaningful for `internal`; the public path is 443. */
  port?: number;
  /** Upstream container name and port, as compose names them. */
  upstream?: string;
  /**
   * Serve play/launcher.html, the hosted site's chooser. Off unless the operator opts in.
   *
   * It asks whether you want the bundled sample game, your own local Morrowind, or
   * multiplayer — none of which is a question for somebody who arrived at a particular
   * server to play on it. That is what "/" is for. Deliberately env-only and not a dashboard
   * setting: it exists for developing the launcher itself, not for configuring a server.
   */
  launcher?: boolean;
}

/**
 * Render the Caddyfile.
 *
 * The localhost block is ALWAYS present, whether or not a domain is set. Losing access to
 * the dashboard is the worst failure this file can cause, and the operator's own machine is
 * how they would fix it — a mistyped domain must not take the admin page down with it.
 */
export function renderCaddyfile(
  { domain, upstream = 'openmw-web:8080', launcher = false, internal = false, port = 80 }: ProxySettings,
): string {
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
	@mwdata path /mwdata/* /mwdata-manifest.json /mwdata-mods.json
	handle @mwdata {
		reverse_proxy ${upstream}
	}
${launcher ? '' : `	# THE LAUNCHER IS OFF UNLESS SOMEBODY ASKED FOR IT (OMW_ENABLE_LAUNCHER=1).
	#
	# It is the hosted site's chooser: bundled sample, your own local Morrowind, or multiplayer.
	# None of those is a question for a player who came to THIS server to play on it, and "/"
	# already signs them in and starts the game.
	#
	# Redirected rather than refused, deliberately. The game page falls back to the launcher in
	# several places — the no-fragment gate, the "Back to the launcher" button on a fatal — and
	# a 404 would strand a player on a dead end at exactly the moment something already went
	# wrong. Sending them to the front door is the answer those fallbacks actually wanted.
	# "redir * / 302", with the explicit wildcard matcher. Caddy's redir takes an OPTIONAL
	# leading matcher, so "redir / 302" parses as matcher "/" with destination "302": it then
	# matches only the site root and redirects it to a relative URL called 302. Caddy accepts
	# it, reloads cleanly, and logs the request as a NOP with no status — which is how a
	# launcher that was supposed to be switched off went on being served.
	@launcher path /launcher.html
	handle @launcher {
		redir * / 302
	}
`}

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

  const header = (plain: boolean): string => `# GENERATED BY THE OPENMW-WEB DASHBOARD. Edits are overwritten.
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
${plain ? `	# No certificates and no HTTP->HTTPS redirect. Without this Caddy would try to provision
	# one for the site address below and bounce every plain request, which is precisely what a
	# LAN client or an upstream reverse proxy must not meet.
	auto_https off
` : ''}}
`;

  // With a domain, the domain block gets a real certificate and localhost keeps its
  // self-signed one. Both listen, so the admin page is reachable either way.
  // INTERNAL: one plain-HTTP site on the chosen port. No tls directive, and auto_https off in
  // the global block, so Caddy neither asks for a certificate nor redirects to one. That is the
  // right answer for a LAN client, a forwarded port, and an upstream reverse proxy alike —
  // whichever of those is in front is where TLS belongs.
  //
  // PUBLIC: the domain gets a real certificate, and localhost keeps a self-signed one, so a
  // mistyped domain cannot take the dashboard down with it.
  // The port travels from a form field through TOML and back; a 0, a NaN, or a fraction
  // must not reach the listen directive, where it takes the whole proxy down on reload.
  const p = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.trunc(port) : 80;
  const blocks = internal
    ? [site(`:${p}`,
      '\t# Plain HTTP on purpose: a LAN, a forwarded port, or your own reverse proxy in front.\n'
      + '\t# Whatever sits in front of this is where TLS belongs.')]
    : domain === ''
      ? [site('localhost', '\ttls internal')]
      : [site(domain, '\t# Let\'s Encrypt, automatically. No directive means a public certificate.'),
         site('localhost', '\ttls internal')];

  return `${header(internal)}${blocks.join('\n')}\n`;
}

/**
 * Is the launcher switched on? Environment only, and off unless explicitly set.
 *
 * Not a config key and not a dashboard toggle: it decides whether a development page is
 * exposed, which is a property of how this container was started rather than an answer about
 * the server. Keeping it out of the config also keeps it out of the settings UI, where it
 * would read as a feature an operator ought to have an opinion about.
 */
export function launcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OMW_ENABLE_LAUNCHER ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
