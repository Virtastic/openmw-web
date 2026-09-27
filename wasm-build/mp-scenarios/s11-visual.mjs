// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s11 (M1, visual): BOTH avatars in one frame. A backs away from the shared spawn point so B's
// puppet (standing at spawn) ends up in front of A's third-person camera. Asserted: B's puppet
// on A stands where B says it stands, at a distance a camera can frame, and the captured frame
// is a rendered scene rather than a flat fill. Whether it LOOKS right stays a human call:
// /tmp/omw-mp-two-avatars.png
import assert from 'node:assert/strict';

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export default async function run(ctx) {
  const [a, b] = await Promise.all([
    ctx.launchClient('cam-a'),
    ctx.launchClient('cam-b'),
  ]);
  const idB = await b.eval('window.omw.state.playerId');
  await a.waitFor(
    `!!(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(idB)}])`,
    15_000, 'puppet of B on A');
  // Back A up ~1s so the spawn point (where B's puppet stands) sits in front of the camera
  // at readable distance.
  await a.eval(`window.omw.send('walk:0,-1,900')`);
  await ctx.sleep(2500);
  // Offset B a step to the side so A's own body doesn't eclipse the puppet dead-center.
  await b.eval(`window.omw.send('walk:1,0,500')`);
  await ctx.sleep(1500);
  // Third person on A so A's own avatar shares the frame with B's puppet standing at spawn
  // (?start deep-links leave the player in first person, where the own body is invisible).
  await a.dismissTour();
  await a.eval(`window.omw.send('cam:3p')`);
  await ctx.sleep(700);

  // Where B is, by B's own account, against where A draws B -- settled for up to 5 s.
  let poseA, poseB, pup;
  for (let i = 0; i < 10; i++) {
    poseA = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
    poseB = JSON.parse(await b.eval('window.omw.state.pose||"null"'));
    pup = JSON.parse(await a.eval('window.omw.state.puppets||"{}"'))[idB];
    if (poseA && poseB && pup && dist(pup, poseB) < 150) break;
    await ctx.sleep(500);
  }
  ctx.log('A pose', JSON.stringify(poseA), '| B pose', JSON.stringify(poseB), '| puppet-of-B on A', JSON.stringify(pup));
  assert.ok(poseA && poseB && pup, 'both poses and the puppet are published');
  assert.ok(dist(pup, poseB) < 150, `A draws B ${Math.round(dist(pup, poseB))} u from where B stands`);
  const apart = dist(poseA, pup);
  assert.ok(apart > 64 && apart < 2000, `the two avatars are ${Math.round(apart)} u apart: not a frameable shot`);

  const path = '/tmp/omw-mp-two-avatars.png';
  const frame = await a.frameStats(undefined, path);
  ctx.log('screenshot with both avatars:', path, JSON.stringify(frame));
  assert.ok(frame.colours > 64 && frame.dominant < 0.6,
    `the frame is a flat fill, not a scene (${frame.colours} colours, ${Math.round(frame.dominant * 100)}% one colour)`);
}
