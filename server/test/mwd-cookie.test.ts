// OT3-52: the cookie the origin mints is the cookie the edge Worker accepts, and nothing else is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintMwd, MWD_TTL_SEC } from '../src/data/locker-routes';
import { verifyMwd, worker } from '../../infra/mwdata-worker/worker';

const KEY = 'test-only-key';

test('OT3-52: the Worker accepts the origin mint and refuses expired, tampered or foreign cookies', async () => {
  const now = 1_800_000_000_000;
  const good = mintMwd(KEY, 'google:123', now);
  assert.equal(await verifyMwd(good, KEY, now / 1000), true);
  assert.equal(await verifyMwd(good, KEY, now / 1000 + MWD_TTL_SEC + 1), false, 'expired');
  const [exp, acct, sig] = good.split('.');
  assert.equal(await verifyMwd(`${Number(exp) + 999}.${acct}.${sig}`, KEY, now / 1000), false, 'extended expiry');
  assert.equal(await verifyMwd(`${exp}.${Buffer.from('google:999').toString('base64url')}.${sig}`, KEY, now / 1000), false, 'other account');
  assert.equal(await verifyMwd(good, 'other-key', now / 1000), false, 'other key');
  assert.equal(await verifyMwd('', KEY, now / 1000), false, 'no cookie');
  assert.equal(await verifyMwd(good, '', now / 1000), false, 'no secret configured');
});

test('OT3-52: the Worker answers 403 without a valid cookie', async () => {
  const res = await worker.fetch(new Request('https://opentes3.test/mwdata/Morrowind.bsa'), { MWD_HMAC_KEY: KEY });
  assert.equal(res.status, 403);
});
