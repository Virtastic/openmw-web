// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The wizard's "is my domain actually working?" check.
//
// Two questions, answered in the order a non-technical operator needs them:
//   1. Does the name resolve at all? (Did they buy it / create the DNS record?)
//   2. Does an HTTPS request to it answer? (Are ports forwarded, is Caddy up, is the
//      certificate real yet?)
//
// The check runs from the server's own vantage point, which is closer to a player's than
// the operator's browser is, but not identical: hairpin NAT means some home networks
// cannot reach their own public address from inside. So the failure wording is "could not
// confirm", never "broken", and each result says what to try next.

import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';

export interface DomainCheck {
  dns: { ok: boolean; addresses: string[]; message: string };
  https: { status: 'ok' | 'self-signed' | 'unreachable' | 'skipped'; message: string };
  /**
   * Did a request to that domain, from the public internet, arrive at THIS server?
   *
   * DNS resolving and something answering on 443 are both necessary and neither is
   * sufficient: the name can point at a different machine entirely, or at a router that
   * answers on its own behalf, and the operator would still be told it worked. The only
   * proof is a value this process invented coming back, so that is what is checked.
   */
  reachable: { ok: boolean; message: string };
}

/**
 * The path the reachability probe asks for, and the value it expects back.
 *
 * Unauthenticated and harmless by construction: it serves one random string this process
 * generated at boot and nothing else. Knowing it proves only that you reached this server,
 * which is exactly the question being asked.
 */
export const VERIFY_PATH = '/.well-known/openmw-web-verify';
export const VERIFY_NONCE = randomBytes(16).toString('hex');

/**
 * Fetch the verify path over the public domain and see whether our own nonce comes back.
 *
 * Deliberately tolerant about TLS: at the moment this runs there may be no certificate for
 * the domain yet, which is the whole reason the operator is here. Identity is established by
 * the nonce, not by the certificate, so a self-signed one in the way is not a failure.
 * Redirects are followed because Caddy sends 80 to 443 on its own.
 */
async function probeReachable(domain: string): Promise<boolean> {
  for (const url of [`https://${domain}${VERIFY_PATH}`, `http://${domain}${VERIFY_PATH}`]) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'openmw-web-setup-check' },
      });
      clearTimeout(timer);
      if (res.ok && (await res.text()).trim() === VERIFY_NONCE) return true;
    } catch { /* try the other scheme, then give up */ }
  }
  return false;
}

/** One HTTPS probe. Resolves to how far the connection got, never rejects. */
function probe(domain: string, rejectUnauthorized: boolean): Promise<'answered' | 'cert' | 'failed'> {
  return new Promise((done) => {
    const req = httpsRequest(
      { host: domain, port: 443, path: '/healthz', method: 'GET', timeout: 6000, rejectUnauthorized },
      (res) => { res.resume(); done('answered'); },
    );
    req.on('timeout', () => { req.destroy(); done('failed'); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      // Any TLS-layer refusal means the socket worked and the certificate did not, which
      // for this check is its own useful answer, distinct from "nothing there at all".
      done(/certificate|TLS|SSL|altnames/i.test(String(e.message)) ? 'cert' : 'failed');
    });
    req.end();
  });
}

/**
 * A bare hostname from whatever was typed. Mirrors the page's own cleanDomain: people paste
 * "https://mp.example.com/" because that is where a domain lives as far as they are
 * concerned, and both ends must agree on what that means. "www." is deliberately left alone,
 * being a genuinely different host.
 */
export function normaliseDomain(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

export async function checkDomain(domain: string): Promise<DomainCheck> {
  const addresses: string[] = [];
  for (const lookup of [resolve4(domain), resolve6(domain)]) {
    try { addresses.push(...await lookup); } catch { /* no records of that family is normal */ }
  }
  if (addresses.length === 0) {
    return {
      dns: {
        ok: false, addresses,
        message: `"${domain}" does not point anywhere yet. In your domain provider's control `
          + 'panel, create an A record for it with this machine\'s public IP address, then '
          + 'give it a few minutes and check again.',
      },
      https: { status: 'skipped', message: 'Skipped, the name has to resolve first.' },
      reachable: { ok: false, message: 'Not checked: the name has to resolve first.' },
    };
  }

  const dns = {
    ok: true, addresses,
    message: `"${domain}" points at ${addresses.join(', ')}.`,
  };

  const reachedUs = await probeReachable(domain);
  const reachable = reachedUs
    ? { ok: true, message: 'A request to that address from the public internet arrived at THIS server. '
        + 'DNS, your router and the ports are all correct.' }
    : { ok: false, message: 'A request to that address did not reach this server. Either the name '
        + 'points somewhere else, or ports 80 and 443 are not forwarded to this machine yet. '
        + 'One more thing to rule out: some routers cannot call their own public address from '
        + 'inside, so if you are certain it is set up, try the address from a phone on mobile data.' };

  const first = await probe(domain, true);
  if (first === 'answered') {
    return { dns, reachable, https: { status: 'ok', message: 'HTTPS answers with a valid certificate. Players can use this address as-is.' } };
  }
  if (first === 'cert' && await probe(domain, false) === 'answered') {
    return { dns, reachable, https: { status: 'self-signed', message:
      'HTTPS answers, but with a self-signed certificate, browsers will warn. If you just '
      + 'set SERVER_DOMAIN in .env, restart the proxy and check again; a real certificate is '
      + 'fetched automatically once the domain reaches it.' } };
  }
  return { dns, reachable, https: { status: 'unreachable', message:
    'The name resolves, but an HTTPS request from this server got no answer. Usually that '
    + 'means ports 80 and 443 are not forwarded to this machine yet, or your router does '
    + 'not let this network call its own public address, in which case everything may be '
    + 'fine anyway: try the address from a phone off your wifi.' } };
}
