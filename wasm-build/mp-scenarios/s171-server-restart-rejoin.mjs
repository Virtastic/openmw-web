// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s171: THE SERVER RESTARTS UNDER A PLAYING CLIENT, and the player carries on where they stood.
//
// s81 proves the redial ladder against a server that never comes back; s80/s21 prove a rejoin
// after the CLIENT left. Nothing drove the operator's everyday case end to end: a deploy (TERM,
// drain, the same world back on the same port) and a crash (KILL, no drain). The player must
// not see the fatal modal, must rejoin by themselves, and must come back in place -- not at the
// respawn point and not with the health the server had before the session.
import assert from 'node:assert/strict';

const POS_EPS = 128;
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export default async function run(ctx) {
  const a = await ctx.launchClient('restart-a');

  // Distinctive state: moved off the spawn point, hp 21.
  await a.eval(`window.omw.send('walk:0,1,2000')`);
  await ctx.sleep(3000);
  await a.eval(`window.omw.send('sethp:21')`);
  await a.waitFor('window.omw.state.hp === "21"', 5000, 'hp mirror = 21');
  await ctx.sleep(1500); // the pose and stats diffs reach the server
  const pose = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
  assert.ok(pose, 'pose mirror');

  const survive = async (how, restart) => {
    const before = Number(await a.eval('window.omw.state.reconnectTotal || 0'));
    await restart();
    ctx.log(`${how}: server back on port ${ctx.serverPort}`);
    await a.waitFor(`Number(window.omw.state.reconnectTotal || 0) > ${before}`, 30_000, `${how}: the client noticed and redialled`);
    await a.waitFor('window.omw.state.state === "Joined"', 120_000, `${how}: rejoined by itself`);
    const s = await a.eval(`({ state: window.omw.state.state, err: window.omw.state.lastError,
      modal: !!document.getElementById('mp-error-modal') })`);
    ctx.log(`${how}: ${JSON.stringify(s)}`);
    assert.equal(s.modal, false, `${how}: the fatal modal was shown`);

    await a.waitFor('window.omw.state.hp === "21"', 15_000, `${how}: hp is the one the player had`);
    let err = Infinity;
    for (let i = 0; i < 20 && err >= POS_EPS; i++) {
      const p2 = JSON.parse(await a.eval('window.omw.state.pose||"null"'));
      if (p2) err = dist(pose, p2);
      if (err >= POS_EPS) await ctx.sleep(500);
    }
    ctx.log(`${how}: back ${err.toFixed(1)} u from where the player stood`);
    assert.ok(err < POS_EPS, `${how}: not back in place (${err.toFixed(1)} u off)`);
  };

  // A DEPLOY: SIGTERM drains -- clients get SHUTDOWN (not a failure), stores flush.
  // The serverRestarting mark lives only while the server is away (a rejoin clears it), so it
  // is read DURING the outage.
  await survive('graceful restart', async () => {
    const back = ctx.serverRestart({ downMs: 6000 });
    await a.waitFor('window.omw.state.serverRestarting === "1"', 6000, 'the SHUTDOWN frame was read as a restart, not a failure');
    ctx.log(`graceful restart: last disconnect "${await a.eval('window.omw.state.lastError || ""')}"`);
    await back;
  });

  // A CRASH: nothing is told, nothing drains. The player's state was flushed by the graceful
  // restart and has not changed since, so "in place" still holds.
  await survive('crash restart', () => ctx.serverRestart({ crash: true, downMs: 3000 }));
  ctx.log('ok: a restart and a crash each rejoined the player in place, without the fatal modal');
}
