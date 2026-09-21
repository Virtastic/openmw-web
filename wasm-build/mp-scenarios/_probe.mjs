// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A PICK THAT WAITS. Scenarios used to read the actor probe once, right after
// `puppetedActors > 0` first turned true, and choose a mark from it; the probe fills over the
// frames that follow, and a client at a few seconds a frame handed back an empty or partial
// one -- 'need a living NPC both see' on a scenario that had passed ten sweeps (#130 s114,
// #132 s119). Read again until the pick lands or the budget is spent; the last probes are
// returned either way, so a failure can still say what each client saw.
export async function pickUntil(ctx, read, pick, timeoutMs = 60_000, everyMs = 2_000) {
  let probes = [], found;
  for (const by = Date.now() + timeoutMs; ;) {
    probes = await read();
    found = pick(...probes);
    if (found || Date.now() >= by) return { found, probes };
    await ctx.sleep(everyMs);
  }
}
