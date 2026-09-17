// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s150: SLEEPING HEALS YOU, AND YOUR FRIEND WAKES UP IN THE SAME HOUR. The host rests eight
// hours: the wound closes on the body the peer rules (a local heal that must be claimed --
// the same channel a potion uses, s146 -- but over eight game hours at once), and the clock
// jump is the owner's to make (timeSkip = "owner") and reaches the guest, who never rested.
// s70 proves the clock is shared and s135 that a guest cannot skip it; nothing had proven
// that the host's own sleep does what sleep is for.
import assert from 'node:assert/strict';

const STEP = 30_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const HOURS = 8;

const parseBars = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '')); return m ? { c: Number(m[1]), b: Number(m[2]) } : null; };
const bars = async (c) => parseBars(await c.eval('window.omw.state.selfStats'));
const timeOf = async (c) => JSON.parse(await c.eval('window.omw.state.gameTime||"{}"'));

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  const [host, guest] = await Promise.all([ctx.launchClient('bot-a', '', BOOT), ctx.launchClient('bot-b', '', BOOT)]);
  await host.waitFor('String(window.omw.state.selfStats||"").indexOf("/") > 0', 300_000, 'the peer reports the host bars');
  await host.waitFor('String(window.omw.state.baselineReady||"") === "1"', STEP, 'the character is settled (identity diffs may speak)');
  await guest.waitFor('Number(window.omw.state.timeApplied||"0") > 0', STEP, 'the guest has the clock');

  // A wound, the honest way (s144): raise the max by a legal base step; current stays put.
  const start = await bars(host);
  await host.cmd(`sethpbase:${start.b + 60}`);
  await host.waitFor(`Number(String(window.omw.state.selfStats||"0/0").split("/")[1]) >= ${start.b + 58}`, STEP, 'the max rose');
  const wounded = await bars(host);
  assert.ok(wounded.c < wounded.b - 20, `no wound to sleep off (${wounded.c}/${wounded.b})`);
  const t0 = await timeOf(host), g0 = await timeOf(guest);
  ctx.log(`host ${wounded.c}/${wounded.b} at ${t0.abs?.toFixed?.(2)} h; guest clock ${g0.abs?.toFixed?.(2)} h`);

  // Sleep.
  await host.cmd(`sleep:${HOURS}`);
  await host.waitFor('String(window.omw.state.slept||"") !== ""', STEP, 'the engine answered the sleep');
  assert.notEqual(await host.eval('window.omw.state.slept'), '-1', 'mp.restHours is not bound on this engine');

  // The heal must stick on the peer-reported bars.
  let after = wounded;
  const by = Date.now() + 40_000;
  while (Date.now() < by && !(after.c > wounded.c + 10)) { await ctx.sleep(1_000); after = (await bars(host)) || after; }
  // WHICH HALF LOST IT (backlog 460): the client's own bar (identity's `hp` mirror) says whether
  // the engine healed at all, `hpClaim` whether identity.lua said so (`<bar>+<gain>`), and the
  // peer's word above whether the server and the avatar took it. Three reds gave only the last.
  ctx.log(`after sleeping ${HOURS} h: peer says ${after.c}/${after.b}; the client's own bar says ${await host.eval('window.omw.state.hp')},`
    + ` last hp claim ${await host.eval('window.omw.state.hpClaim || "none"')}`);
  assert.ok(after.c > wounded.c + 10, `sleeping ${HOURS} h healed nothing that stuck (${wounded.c} -> ${after.c})`);
  assert.ok(after.c <= after.b, 'never past the maximum');

  // The clock moved by the hours slept, on the host and -- through the server -- the guest.
  const t1 = await timeOf(host);
  assert.ok(t1.abs - t0.abs >= HOURS - 0.5, `the host's clock did not advance ${HOURS} h (${t0.abs?.toFixed?.(2)} -> ${t1.abs?.toFixed?.(2)})`);
  await guest.waitFor(`Number((JSON.parse(window.omw.state.gameTime||"{}").abs)||0) >= ${t1.abs - 0.5}`, 90_000, "the guest's clock caught up with the host's sleep");
  const g1 = await timeOf(guest);
  ctx.log(`clocks after: host ${t1.abs.toFixed(2)} h, guest ${g1.abs.toFixed(2)} h`);
  ctx.log(`PASS: the host slept ${HOURS} h, healed ${after.c - wounded.c}, and the guest woke in the same hour`);
}
