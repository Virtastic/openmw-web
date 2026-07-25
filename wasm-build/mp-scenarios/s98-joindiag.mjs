// Diagnostic: boot ONE client and report the MP session state as it progresses, instead of
// silently waiting for 'Joined'. Exists because a retail client rendered fine (smoke PASS)
// yet never joined — proving the boot was healthy and the failure was in the session
// handshake, which a boot-only check cannot distinguish.
export const bootTimeoutMs = 420_000;

export default async function run(ctx) {
  // Wait only for the engine to be up (__omwMP exists), NOT for Joined — the whole point
  // is to observe how far the session actually gets.
  // retail:true — must match s40/s41's boot, since the failure is retail-specific (the demo
  // path joins fine in ~37s).
  const c = await ctx.launchClient('diag', '', {
    retail: true,
    waitExpr: 'typeof window.__omwMP === "object" && !!(window.__omwMP||{}).state',
    waitWhat: '__omwMP present',
    joinTimeoutMs: 420_000,
  });
  const deadline = Date.now() + 180_000;
  let last = null;
  while (Date.now() < deadline) {
    const [state, err, serverName, playerId] = await Promise.all([
      c.eval('(window.__omwMP||{}).state'),
      c.eval('(window.__omwMP||{}).lastError'),
      c.eval('(window.__omwMP||{}).serverName'),
      c.eval('(window.__omwMP||{}).playerId'),
    ]);
    const line = `state=${state} err=${err} server=${serverName} id=${playerId}`;
    if (line !== last) { ctx.log(line); last = line; }
    if (state === 'Joined' || state === 'Failed') break;
    await ctx.sleep(2000);
  }
  ctx.log('--- console tail ---');
  ctx.log(c.logTail(40));
}
