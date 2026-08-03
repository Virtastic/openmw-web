// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s11 (M1, visual): capture a screenshot with BOTH avatars in frame. A backs away from the
// shared spawn point so B's puppet (standing at spawn) ends up in front of A's third-person
// camera. No convergence asserts (that's s10) — this is the human-checkable artifact:
// /tmp/omw-mp-two-avatars.png
export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('cam-a'),
    ctx.launchClient('cam-b'),
  ]);
  const idB = await b.eval('(window.__omwMP||{}).playerId');
  await a.waitFor(
    `!!(JSON.parse((window.__omwMP||{}).puppets||"{}")[${JSON.stringify(idB)}])`,
    15_000, 'puppet of B on A');
  // Back A up ~1s so the spawn point (where B's puppet stands) sits in front of the camera
  // at readable distance.
  await a.eval(`Module.__omwMPCmd='walk:0,-1,900'`);
  await ctx.sleep(2500);
  const poses = async () => {
    const pose = JSON.parse(await a.eval('(window.__omwMP||{}).pose||"null"'));
    const pup = JSON.parse(await a.eval('(window.__omwMP||{}).puppets||"{}"'))[idB];
    ctx.log('A pose', JSON.stringify(pose), '| puppet-of-B', JSON.stringify(pup));
  };
  await poses();
  // Offset B a step to the side so A's own body doesn't eclipse the puppet dead-center.
  await b.eval(`Module.__omwMPCmd='walk:1,0,500'`);
  await ctx.sleep(1500);
  // Third person on A so A's own avatar shares the frame with B's puppet standing at spawn
  // (?start deep-links leave the player in first person, where the own body is invisible).
  await a.eval(`Module.__omwMPCmd='cam:3p'`);
  await ctx.sleep(700);
  const path = await a.screenshot('/tmp/omw-mp-two-avatars.png');
  ctx.log('screenshot with both avatars:', path);
}
