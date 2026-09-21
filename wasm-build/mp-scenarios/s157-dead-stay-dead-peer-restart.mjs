// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s157: THE DEAD STAY DEAD ACROSS A PEER RESTART. The server records every death in the cell
// doc and sends the list with the cell state -- and two things swallowed it. The client
// indexed its puppets by the WIRE key ("c:<idx>:<file>") while the table is keyed by the
// local object id, so the replay matched nothing; and the simulator never received the cell
// record at all (relays were gated on where its avatar stood, and nothing asked at anchor),
// so after a restart it loaded the smuggler alive and streamed him standing. The holder now
// asks for the record when it takes a cell and kills the body for real; a late human resolves
// the wire key first. Kill an NPC (s109), restart the peer, and expect the corpse to
// stay a corpse on both screens.
import assert from 'node:assert/strict';
import { pickUntil } from './_probe.mjs';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const probeOf = async (c) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'));
const cellOf = async (c) => String(await c.eval('window.omw.state.cell||""'));

export default async function run(ctx) {
  let peer = ctx.startSimPeer('-2,-9');
  if (!peer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [a, b] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  // OUTDOORS, in the cell the hand-started peer holds: a manual peer anchors nothing else
  // (that is the server-spawned peer's job, s118), and the restart below needs peer.stop().
  for (const c of [a, b]) await c.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 300_000, `${c.name} puppeted the cell actors`);
  const inside = await cellOf(a);
  for (const c of [a, b]) {
    await c.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 120_000, `${c.name}: the cell has a holder`);
  }

  let pa, pb, victim;
  ({ found: victim, probes: [pa, pb] } = await pickUntil(ctx, () => Promise.all([probeOf(a), probeOf(b)]), (pa, pb) => Object.keys(pa).find((r) => r !== 'player' && pb[r] && !pa[r].dead && !pa[r].guard)));
  assert.ok(victim, `need a living NPC visible to both: A=${JSON.stringify(Object.keys(pa))}`);
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  // 180 s: at #116's frame rate the test hits landed 8 s apart and 90 s was eleven of them.
  const deadline = Date.now() + 180_000;
  let died = false;
  while (Date.now() < deadline && !died) {
    await a.cmd(`hitn:${victim}:40`);
    await ctx.sleep(600);
    died = (await a.eval(deadExpr)) === true;
  }
  assert.ok(died, `"${victim}" never died (s118 covers the fight)`);
  await b.waitFor(deadExpr, STEP, 'B sees it dead');
  ctx.log(`"${victim}" is dead in "${inside}" on both screens; restarting the peer`);

  // The simulator dies and comes back cold: it loads the room from the content files.
  peer.stop();
  await ctx.sleep(3_000);
  await a.waitFor('String(window.omw.state.authorityHolder||"none") === "none"', 120_000, 'the cell lost its holder');
  peer = ctx.startSimPeer('-2,-9');
  assert.ok(peer, 'could not restart the peer');
  await a.waitFor('String(window.omw.state.authorityHolder||"none") !== "none"', 300_000, 'the restarted peer re-took the cell');
  ctx.log('the peer holds the cell again; watching the corpse for 20 s');
  // Nothing may stand him up: not the fresh holder's stream, not a snapshot. Sampled over
  // time because a resurrection would arrive with the first actor batch, not at once.
  // Both signals: the local death state, and the HOLDER's hp as mirrored onto the puppet --
  // a corpse the fresh simulator reloaded alive keeps its death pose here while its mirrored
  // health climbs back above zero.
  const rowOf = (c) => c.eval(`JSON.stringify((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}))`).then(JSON.parse);
  const word = (r) => (r.dead === true && !(r.hp > 0)) ? 'dead' : `ALIVE(dead=${r.dead},hp=${r.hp})`;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await ctx.sleep(2_000);
    const [ra, rb] = await Promise.all([rowOf(a), rowOf(b)]);
    seen.push(`${word(ra)}/${word(rb)}`);
  }
  ctx.log(`corpse over 20 s (A/B): ${seen.join(' ')}`);
  assert.ok(seen.every((s) => s === 'dead/dead'), `"${victim}" stood up again after the peer restart: the death record never reached the simulator`);
  ctx.log('PASS: a killed NPC stays dead across a peer restart, on every screen');
}
