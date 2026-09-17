// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// GO TO THE COMPANION YOU JUST RECRUITED. The claim stacks Follow on the holder's NPC, and
// an unactivated Follow stands still: aifollow.cpp activates only with the leader within
// followDistance + 384 and in sight, checked every 0.5 s on the peer. So from the claim on
// the NPC stops wandering and the recruiter's puppet copy converges on where the peer really
// has it -- which is the first moment a scenario can trust the probe. Before that it could
// not: an in-suite client runs at a fraction of 1 fps, so the pre-dialogue read was seconds
// old and the snapto landed the avatar a few slow frames later still, ~1000 u behind a
// WALKING wanderer (s114 in #112/#113: 1135 u, 1063 u; s117 in #113: 1081 u -- one
// standing still, fargoth in #111, passed). Re-reading before the dialogue could not help:
// the re-read was just as stale. In play the player walks over to the companion; this is
// that walk. Library, not a scenario (leading underscore).
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export async function goToCompanion(ctx, a, rec, start) {
  // Settled = three reads 3 s apart within 30 u. A slow client can hand back the same mirror
  // twice with no frame between, so one quiet interval proves nothing; two do.
  let at = null, quiet = 0;
  for (let i = 0; i < 20 && quiet < 2; i++) {
    await ctx.sleep(3_000);
    const q = (await probeOf(a))[rec];
    if (!q) continue;
    quiet = at && dist2(q, at) < 30 ? quiet + 1 : 0;
    at = q;
  }
  if (quiet < 2) throw new Error(`"${rec}" never held still after the recruit claim (A's copy still moving 60 s later)`);
  ctx.log(`"${rec}" settled at (${Math.round(at.x)},${Math.round(at.y)}), ${Math.round(dist2(at, start))} u from the pre-dialogue read`);
  await a.cmd(`snapto:${Math.round(at.x + 80)},${Math.round(at.y)},${Math.round(at.z + 8)}`);
  // The avatar's teleport follows A's PlayerCellChange a few slow frames later (3-7 s in
  // #113), then AiFollow needs one of its 0.5 s checks: hold here long enough for both.
  await ctx.sleep(10_000);
  return at;
}
