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

export interface DomainCheck {
  dns: { ok: boolean; addresses: string[]; message: string };
  https: { status: 'ok' | 'self-signed' | 'unreachable' | 'skipped'; message: string };
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
    };
  }

  const dns = {
    ok: true, addresses,
    message: `"${domain}" points at ${addresses.join(', ')}.`,
  };

  const first = await probe(domain, true);
  if (first === 'answered') {
    return { dns, https: { status: 'ok', message: 'HTTPS answers with a valid certificate. Players can use this address as-is.' } };
  }
  if (first === 'cert' && await probe(domain, false) === 'answered') {
    return { dns, https: { status: 'self-signed', message:
      'HTTPS answers, but with a self-signed certificate, browsers will warn. If you just '
      + 'set SERVER_DOMAIN in .env, restart the proxy and check again; a real certificate is '
      + 'fetched automatically once the domain reaches it.' } };
  }
  return { dns, https: { status: 'unreachable', message:
    'The name resolves, but an HTTPS request from this server got no answer. Usually that '
    + 'means ports 80 and 443 are not forwarded to this machine yet, or your router does '
    + 'not let this network call its own public address, in which case everything may be '
    + 'fine anyway: try the address from a phone off your wifi.' } };
}
