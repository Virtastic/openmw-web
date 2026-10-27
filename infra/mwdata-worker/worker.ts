// Cloudflare Worker on opentes3.com/mwdata/* (OT3-52). Refuses any hosted-asset read without a
// valid `mwd` cookie, which the origin mints (server/src/data/locker-routes.ts mintMwd) only for
// an account holding hash-verified ESMs. mwdata-manifest.json sits outside /mwdata/ and stays
// public. Secret: MWD_HMAC_KEY (wrangler secret), the same value as the origin's
// OMW_MWDATA_HMAC_KEY; never in the repo.

const enc = new TextEncoder();

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** `<exp>.<acct>.<hmac>`: true only for an unexpired value signed with `secret`. */
export async function verifyMwd(value: string, secret: string, nowSec = Date.now() / 1000): Promise<boolean> {
  const [exp = '', acct, sig = '', extra] = value.split('.');
  if (acct === undefined || extra !== undefined || !secret) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < nowSec) return false;
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlBytes(sig); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(`${exp}.${acct}`)); // constant-time
}

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

export const worker = {
  async fetch(req: Request, env: { MWD_HMAC_KEY: string }): Promise<Response> {
    if (!await verifyMwd(cookie(req, 'mwd'), env.MWD_HMAC_KEY)) return new Response('forbidden', { status: 403 });
    // ponytail: passes through to the origin (cache key = URL, so the cookie never splits the
    // cache). The R2 read, ranges from the full object, lands with OT3-44.
    return fetch(req);
  },
};
export default worker;
