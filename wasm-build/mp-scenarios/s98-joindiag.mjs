// s98: a RETAIL client joins, and says so. Boots ONE client waiting only for the engine to report a
// session state (not for Joined), then traces the session as it progresses and asserts where it
// ends. Exists because a retail client rendered fine (smoke PASS) yet never joined -- the boot
// was healthy and the failure was in the session handshake, which a boot-only check cannot
// distinguish. The trace is kept: when this fails, it is the first thing to read.
import assert from 'node:assert/strict';

export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  // retail:true -- must match s40/s41's boot, since the failure was retail-specific (the demo
  // path joins fine in ~37s).
  const c = await ctx.launchClient('diag', '', {
    retail: true,
    waitExpr: 'window.omw.state.state !== "boot"',
    waitWhat: 'the engine reported a session state',
    joinTimeoutMs: 420_000,
  });
  const deadline = Date.now() + 180_000;
  let last = null;
  let s = {};
  while (Date.now() < deadline) {
    s = await c.eval(`(() => { const o = window.omw.state; return { state: o.state, err: o.lastError,
      server: o.serverName, id: o.playerId }; })()`);
    const line = `state=${s.state} err=${s.err} server=${s.server} id=${s.id}`;
    if (line !== last) { ctx.log(line); last = line; }
    if (s.state === 'Joined' || s.state === 'Failed') break;
    await ctx.sleep(2000);
  }
  if (s.state !== 'Joined') { ctx.log('--- console tail ---'); ctx.log(c.logTail(40)); }
  assert.equal(s.state, 'Joined', `the retail client never joined (last: ${last})`);
  assert.ok(!s.err, `joined, but with an error on record: ${s.err}`);
  assert.ok(String(s.server ?? '').length > 0, 'the welcome named the server');
  assert.ok(Number(s.id) > 0, 'the welcome gave the client a player id');
}
