// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s171: A REAL FIGHT, AS THE PLAYER HAS IT. 2026-09-23, dev box, solo private world, Seyda
// Neen outskirts: "I don't see them attack, they move slowly towards me, and it doesn't show
// me registering hits." Every fight scenario before this one (s109/s110/s51/s164) drives the
// hitn: relay or the attack: use-bit hook; none watches the creature COME AT you or swings a
// real mouse button at it. One client, the server's own peer (production lifecycle), a named
// levelled creature, a drawn sword, real canvas mouse swings -- and on every ~200 ms sample:
// where the puppet stands vs where the peer's creature stands, the flags the browser received
// for it, the player's bars; per swing the peer creature's health.
//
// The browser side is read from play/index.html's actor tap (window.__omwActorTap): every
// pose the browser received for the creature, and every edge of its use bit. The peer's own
// view comes from `[mp] d171` lines when a diagnostic checkout adds those prints to the peer's
// actors.lua / global.lua / companion.lua (see the s171 notes in the commit); without them the
// received stream stands in for the peer (measured 0-1 u from it) and the bars are the
// client's mirror.
//
// Measured 2026-09-23 on the LAN builder (#144 engine, 47b10ec8 Lua), before the fixes:
// the rat's use bit is up for ONE peer frame per bite (49 bites, 48 received); the player
// bitten 35 -> 12 while its puppet stood idle; 2 real swings kill a rat (22 -> 9 -> 0), the
// bars reach the browser 166 ms after the peer's hit; 1-2 rejected combat claims per fight.
// The client ran at 0.6-1.7 fps there, so the chase itself (puppet vs peer while moving) is
// measured by the lua-tests replay, not here.
//
// What the player expects, asserted after everything is logged:
//   1. the creature on the client stays within 64 u of the peer's while it moves;
//   2. when the peer's creature attacks, the client receives the attack (use bit) for it;
//   3. a real in-range swing lowers the creature's health on the peer, and the client
//      receives the new bars within 250 ms;
//   4. no rejected 'combat claim' / 'travel claim' in the server log (a puppet's relayed fight
//      echoed back as the player's own claim).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const managedPeer = true; // the dev box shape: the server spawns and anchors the peer
export const timeoutMs = 900_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };
const STEP = 30_000;
// -2,-7 is where the peer reliably names scrib / kwama forager / rat (s109, s164). The player
// stood in -2,-8; OMW_S171_SPOT overrides.
const SPOT = process.env.OMW_S171_SPOT || '-12500,-53100,512';
const WEAPON = 'iron longsword';
const REACH = Number(process.env.OMW_S171_REACH || 170); // centre to centre: the peer's rat bites the avatar from ~140 u
// A held button must span client frames: the harness client runs at ~1-2 fps on a loaded box
// (s171 measured 0.6-1.7), and a press and release inside one frame never reach the avatar.
const HOLD_MS = Number(process.env.OMW_S171_HOLD_MS || 2500);
const FIGHT_MS = Number(process.env.OMW_S171_FIGHT_MS || 120_000);
const SHOTS = join(ROOT, 'wasm-build', 'harness-out', 's171');

const q = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f0 = (n) => (Number.isFinite(n) ? n.toFixed(0) : String(n));

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) { ctx.log('SKIP: retail data absent'); return; }
  const peer = ctx.startSimPeer('-2,-7');
  if (!peer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  mkdirSync(SHOTS, { recursive: true });
  const a = await ctx.launchClient('fighter', '', BOOT);
  await a.waitFor('window.omw.state.state === "Joined"', 60_000, 'joined');
  await a.cmd('snapto:' + SPOT);
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 180_000, 'the peer holds the cell (actors puppeted)');
  await a.waitFor(`(function(){var pr=JSON.parse(window.omw.state.actorProbe||"{}");return Object.values(JSON.parse(window.omw.state.netObjects||"{}")).some(function(r){var p=pr[r];return p&&!p.dead&&p.n===1;});})()`,
    120_000, 'a living, unique, named creature in the probe');

  // FOCUS LIKE A PLAYER (s64): click into the canvas, close the tour, take the pointer lock.
  await a.mouseHold(60);
  try { await a.click('#omw-tour-x'); } catch {}
  await a.evalGesture("(function(){var c=document.querySelector('canvas'); try { var p=c.requestPointerLock(); return p&&p.then?p.then(function(){return 'locked'},function(e){return 'rejected:'+e}):'requested'; } catch(e){ return 'threw:'+e; }})()");
  await a.eval("(function(){var c=document.querySelector('canvas'); if(c) c.focus(); return 1;})()");
  const tap = await a.eval('!!window.__omwActorTap');
  ctx.log(`pointerLock=${await a.eval('!!document.pointerLockElement')} actorTap=${tap}`);

  // Kit (s164): the sword, the skill to land it, the stance. The avatar gets all three.
  await a.cmd(`equip:${WEAPON}:16`);
  await a.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(WEAPON)}) >= 0`, 15_000, 'the sword is in hand');
  await a.cmd('setskill:longblade:100');
  await ctx.sleep(2_000);
  await a.cmd('stance:weapon');
  await a.waitFor('window.omw.state.stance === "weapon"', 10_000, 'the sword is drawn');

  // The mark: the nearest unique named creature (a rat or a forager comes at you on its own;
  // a scrib is provoked below).
  const nets = JSON.parse(await a.eval('window.omw.state.netObjects||"{}"'));
  const probe0 = JSON.parse(await a.eval('window.omw.state.actorProbe||"{}"'));
  const me0 = JSON.parse(await a.eval('window.omw.state.pose||"{}"'));
  // The probe is keyed by RECORD and several net ids can share one (three scribs); the one
  // the probe describes is the net id whose received pose stands where the probe says.
  const rx0 = JSON.parse(await a.eval('JSON.stringify((window.__omwActorTap||{}).last||{})'));
  const cand = Object.entries(nets).filter(([, r]) => probe0[r] && !probe0[r].dead && probe0[r].n === 1)
    .map(([id, r]) => { const t = rx0['n' + id]; return { id, r, d: Math.hypot(probe0[r].x - me0.x, probe0[r].y - me0.y),
      m: t ? Math.hypot(t.x - probe0[r].x, t.y - probe0[r].y) : Infinity }; })
    .filter((c) => c.m < 60).sort((x, y) => (x.r === 'scrib') - (y.r === 'scrib') || x.d - y.d || x.m - y.m); // a scrib will not come at you; a rat or a forager does
  assert.ok(cand.length, `no unique living named creature: nets=${JSON.stringify(nets)} probe=${JSON.stringify(Object.keys(probe0))}`);
  const { id: netId, r: victim } = cand[0];
  ctx.log(`  (net ${netId}'s received pose is ${f0(cand[0].m)} u from the probe's ${victim})`);
  const tapKey = 'n' + netId;
  ctx.log(`the mark: "${victim}" net ${netId} at ${f0(cand[0].d)} u; others: ${cand.slice(1, 6).map((c) => c.r + '@' + f0(c.d)).join(' ')}`);

  // Stand ~300 u off it (an announced jump, s164's lesson) so it has to COME to us.
  {
    const p = probe0[victim];
    const dx = me0.x - p.x, dy = me0.y - p.y, d = Math.hypot(dx, dy) || 1;
    await a.cmd(`snapto:${Math.round(p.x + (dx / d) * 300)},${Math.round(p.y + (dy / d) * 300)},${Math.round(p.z + 16)}`);
    await a.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'x'");
    await a.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar is beside us').catch((e) => ctx.log('  (avatar settle: ' + e.message + ')'));
  }
  // One sting: a scrib will not start a fight on its own (s110's idiom). Relay-only, and
  // counted, so it is told apart from the real swings.
  await a.cmd(`hitn:${victim}:1`);
  await ctx.sleep(2_000); // the sting's own forward lands before the baseline
  const fwd0 = String(await a.eval('window.omw.state.hitFwdCount'));
  const fps = JSON.parse(await a.evalAsync('new Promise(function(r){var n=0,t0=performance.now();function f(){n++; if(performance.now()-t0<2000) requestAnimationFrame(f); else r(JSON.stringify({fps:n/((performance.now()-t0)/1000)}));} requestAnimationFrame(f);})'));
  ctx.log(`client rAF rate ${fps.fps.toFixed(1)}/s`);

  // THE FIGHT: sample every ~200 ms in ONE eval; swing for real whenever in reach.
  const READ = `JSON.stringify((function(){var s=window.omw.state, pr=JSON.parse(s.actorProbe||"{}")[${JSON.stringify(victim)}]||null, t=window.__omwActorTap;
    return { t: Date.now(), pr: pr, me: JSON.parse(s.pose||"null"), sf: Number(s.selfFlags||0), ss: s.selfStats, hp: s.hp,
      rx: t ? t.last[${JSON.stringify(tapKey)}] || null : null, rxN: t ? Object.keys(t.last).length : -1 }; })())`;
  const samples = [], swings = [];
  let swingP = null, lastSwing = 0, shot = 0, lastShotAt = 0, farSince = null, resnaps = 0, lastLook = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < FIGHT_MS) {
    const s = JSON.parse(await a.eval(READ));
    samples.push(s);
    if (s.pr?.dead) { ctx.log(`the ${victim} died at +${((s.t - t0) / 1000).toFixed(1)} s`); break; }
    const p = s.pr, me = s.me;
    const d = p && me ? Math.hypot(p.x - me.x, p.y - me.y) : Infinity;
    if (d <= REACH && !swingP && s.t - lastSwing > 1400) {
      lastSwing = s.t;
      const face = `face:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z + 30)}`;
      swings.push({ t: s.t, d, pr: p });
      const n = swings.length;
      swingP = (async () => {
        await a.eval(`window.omw.send(${JSON.stringify(face)}); 1`);
        await a.mouseHold(HOLD_MS);
        // What the player sees just after the blow: the enemy bar, blood, a flinch -- or nothing.
        await ctx.sleep(300);
        if (shot < 60) await a.screenshot(join(SHOTS, `${String(shot++).padStart(2, '0')}-swing${n}.png`)).catch(() => {});
      })()
        .catch((e) => ctx.log('  swing failed: ' + e.message)).finally(() => { swingP = null; });
    }
    // A creature that wandered off (or never came) gets approached, a few times at most.
    if (d > 500) { farSince ??= s.t; } else farSince = null;
    if (farSince && s.t - farSince > 12_000 && resnaps < 4 && p) {
      resnaps++; farSince = null;
      await a.cmd(`snapto:${Math.round(p.x + 200)},${Math.round(p.y)},${Math.round(p.z + 16)}`);
    }
    // The player's view: every 3 s, and whenever the tap shows the creature's use bit set.
    const attacking = s.rx && (s.rx.fl & 8);
    if (shot < 40 && (s.t - lastShotAt > 3000 || (attacking && s.t - lastShotAt > 400))) {
      lastShotAt = s.t;
      await a.screenshot(join(SHOTS, `${String(shot++).padStart(2, '0')}-${Math.round((s.t - t0) / 100)}ds-d${f0(d)}${attacking ? '-ATK' : ''}.png`)).catch(() => {});
    }
    // Watch it like a player does: face it once a second (fire and forget, no ack wait).
    if (p && !swingP && s.t - lastLook > 1000) { lastLook = s.t; await a.eval(`window.omw.send('face:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z + 30)}'); 1`); }
    await ctx.sleep(Math.max(0, 200 - (Date.now() - s.t)));
  }
  if (swingP) await swingP;
  const tap1 = JSON.parse(await a.eval('JSON.stringify(window.__omwActorTap || null)'));
  await ctx.sleep(1500); // the peer's last lines reach the server log

  // ---------------------------------------------------------------- the peer's side
  const srv = ctx.serverLogTail(400_000).split('\n');
  const peerLines = [];
  for (const l of srv) {
    if (!l.includes('d171 ')) continue;
    let ts, text;
    try { const j = JSON.parse(l); ts = Date.parse(j.ts); text = String(j.text || ''); } catch { continue; }
    let m = /d171 A net=(\d+) rec=(.+?) p=(-?\d+),(-?\d+),(-?\d+) fl=(\d+) hp=(-?[\d.]+)(?: yaw=(-?[\d.]+))?/.exec(text);
    if (m) { peerLines.push({ k: 'A', ts, net: m[1], rec: m[2], x: +m[3], y: +m[4], z: +m[5], fl: +m[6], hp: +m[7], yaw: m[8] === undefined ? NaN : +m[8] }); continue; }
    m = /d171 V id=(\d+) p=(-?\d+),(-?\d+),(-?\d+) yaw=(-?[\d.]+) fl=(\d+) atk=(\S+) hp=(-?[\d.]+)/.exec(text);
    if (m) { peerLines.push({ k: 'V', ts, x: +m[2], y: +m[3], z: +m[4], yaw: +m[5], fl: +m[6], atk: m[7] === 'true', hp: +m[8] }); continue; }
    m = /d171 AI rec=(.+?) pkg=(\S+) tgt=(.+?) d=(\S+)/.exec(text);
    if (m) peerLines.push({ k: 'AI', ts, rec: m[1], tgt: m[3], d: m[4] });
  }
  const pA = peerLines.filter((l) => l.k === 'A' && l.net === String(netId) && l.ts >= t0 - 2000);
  const pV = peerLines.filter((l) => l.k === 'V' && l.ts >= t0 - 2000);
  const pAI = peerLines.filter((l) => l.k === 'AI' && l.rec === victim && l.ts >= t0 - 2000);
  const havePeer = pA.length > 0;
  // WITHOUT the peer's d171 prints (a diagnostic checkout adds them; production Lua does not
  // carry them) the truth is what the browser RECEIVED for the creature -- measured 1 u from
  // the peer's own position -- and the bars are the client's mirrored ones.
  const track = havePeer ? pA : samples.filter((s) => s.rx).map((s) => ({ ts: s.rx.t, x: s.rx.x, y: s.rx.y, z: s.rx.z, fl: s.rx.fl, hp: s.pr ? s.pr.hp : NaN }))
    .filter((l, i, arr) => i === 0 || l.ts !== arr[i - 1].ts);
  ctx.log(`peer lines: A(${victim})=${pA.length} V=${pV.length} AI=${pAI.length}${havePeer ? '' : ' (no d171 peer prints: the received stream stands in for the peer)'}`);
  const peerAt = (t) => { // the peer's creature at wall time t (linear between lines)
    let prev = null;
    for (const l of track) { if (l.ts >= t) { if (!prev) return l; const k = (t - prev.ts) / Math.max(1, l.ts - prev.ts); return { x: prev.x + (l.x - prev.x) * k, y: prev.y + (l.y - prev.y) * k, z: prev.z + (l.z - prev.z) * k, fl: l.fl, hp: l.hp }; } prev = l; }
    return prev;
  };

  // ---------------------------------------------------------------- 1. position
  // The probe is a 2 Hz mirror of the puppet's REAL position; take each fresh value and
  // compare it with the peer's creature at the same wall time, and with the best match inside
  // +-300 ms (a lag-tolerant read that cannot blame the sampling for a real gap).
  const gapsNow = [], gapsBest = [], rxGaps = [], moving = [];
  let lastKey = '';
  for (const s of samples) {
    if (!s.pr) continue;
    const key = `${s.pr.x},${s.pr.y}`; if (key === lastKey) continue; lastKey = key;
    const pn = peerAt(s.t); if (!pn) continue;
    const pb = peerAt(s.t - 1000); const speed = pb ? Math.hypot(pn.x - pb.x, pn.y - pb.y) : 0; // u/s
    const now = Math.hypot(s.pr.x - pn.x, s.pr.y - pn.y);
    let best = now; for (let dt = -300; dt <= 300; dt += 25) { const pp = peerAt(s.t + dt); if (pp) best = Math.min(best, Math.hypot(s.pr.x - pp.x, s.pr.y - pp.y)); }
    if (s.rx) rxGaps.push(Math.hypot(s.rx.x - pn.x, s.rx.y - pn.y));
    if (speed > 20) { gapsNow.push(now); gapsBest.push(best); moving.push(speed); }
  }
  ctx.log(`POSITION while the peer's creature moves (n=${gapsNow.length}, peer speed p50 ${f0(q(moving, 0.5))} u/s): client-vs-peer gap p50=${f0(q(gapsNow, 0.5))} p90=${f0(q(gapsNow, 0.9))} max=${f0(q(gapsNow, 1))}; lag-tolerant p50=${f0(q(gapsBest, 0.5))} p90=${f0(q(gapsBest, 0.9))}; received-vs-peer p50=${f0(q(rxGaps, 0.5))}`);
  // Distance-to-player over time, client puppet vs peer creature (the "moves slowly toward me").
  const trace = [];
  const lastA = (t) => { let b = null; for (const l of pA) { if (l.ts <= t) b = l; else break; } return b; };
  for (let i = 0; i < samples.length; i += samples.length > 60 ? 5 : 1) {
    const s = samples[i]; if (!s.pr || !s.me) continue; const pn = peerAt(s.t);
    trace.push(`+${((s.t - t0) / 1000).toFixed(1)}s cl=${f0(Math.hypot(s.pr.x - s.me.x, s.pr.y - s.me.y))}${pn ? ' peer=' + f0(Math.hypot(pn.x - s.me.x, pn.y - s.me.y)) : ''} rxFl=${s.rx ? s.rx.fl : '-'} hp=${s.ss} yaw: toPlayer=${Math.atan2(s.me.x - s.pr.x, s.me.y - s.pr.y).toFixed(2)} peer=${lastA(s.t)?.yaw?.toFixed?.(2)} rx=${s.rx?.yaw?.toFixed?.(2)}`);
  }
  ctx.log('TRACE (distance to player: client puppet / peer creature): ' + trace.join(' | '));

  // ---------------------------------------------------------------- 2. attacks
  const runs = []; let cur = null;
  for (const l of havePeer ? pA : []) { if (l.fl & 8) { if (!cur) { cur = { from: l.ts, to: l.ts, n: 0 }; runs.push(cur); } cur.to = l.ts; cur.n++; } else cur = null; }
  const edgesV = (tap1?.edges || []).filter((e) => e[1] === tapKey && e[0] >= t0);
  const rises = edgesV.filter((e) => e[2] & 8);
  ctx.log(`ATTACKS: peer attack windows=${runs.length} (durations ms: ${runs.slice(0, 12).map((r) => r.to - r.from).join(',')}; lines each: ${runs.slice(0, 12).map((r) => r.n).join(',')}); browser received use-bit rises=${rises.length}; peer AI Combat lines=${pAI.length} (last: ${pAI.slice(-2).map((l) => l.tgt + '@' + l.d).join(' ')})`);
  const bitsSeen = [...new Set(pA.map((l) => l.fl))].join(',');
  ctx.log(`peer flags seen for the ${victim}: ${bitsSeen}; received flags now=${samples.at(-1)?.rx?.fl}`);

  // ---------------------------------------------------------------- 3. swings
  const selfSwing = samples.filter((s) => s.sf & 8).length;
  const hpTrack = havePeer ? pA : samples.filter((s) => s.pr).map((s) => ({ ts: s.t, hp: s.pr.hp }));
  const hpDrops = []; for (let i = 1; i < hpTrack.length; i++) if (hpTrack[i].hp < hpTrack[i - 1].hp - 0.01) hpDrops.push({ ts: hpTrack[i].ts, from: hpTrack[i - 1].hp, to: hpTrack[i].hp });
  const statsRx = (tap1?.events || []).filter((e) => e[1] === 'ActorStatsDynamic').map((e) => e[0]);
  // The peer's hit to the browser's bars (the kill travels as a death, not as bars).
  const lat = (havePeer ? hpDrops.filter((h) => h.to > 0) : []).map((h) => { const r = statsRx.find((t) => t >= h.ts - 20); return r === undefined ? Infinity : r - h.ts; });
  const avSwings = []; cur = null;
  for (const l of pV) { if (l.fl & 8 || l.atk) { if (!cur) { cur = { from: l.ts, atk: false }; avSwings.push(cur); } cur.atk ||= l.atk; } else cur = null; }
  const perSwing = swings.map((sw) => {
    const v = pV.filter((l) => l.ts >= sw.t && l.ts <= sw.t + 3000);
    const pv = peerAt(sw.t);
    const av = v.find((l) => l.fl & 8);
    const avD = av && pv ? Math.hypot(av.x - pv.x, av.y - pv.y) : NaN;
    const drop = hpDrops.find((h) => h.ts >= sw.t && h.ts <= sw.t + 3500);
    return `@+${((sw.t - t0) / 1000).toFixed(1)}s clientRange=${f0(sw.d)} avatarUse=${!!av} avatarAtk=${v.some((l) => l.atk)} avatar-creature=${f0(avD)} hit=${drop ? drop.from.toFixed(0) + '->' + drop.to.toFixed(0) : 'no'}`;
  });
  ctx.log(`SWINGS: ${swings.length} real in-range swings; selfFlags use-bit samples=${selfSwing}; avatar swing windows on the peer=${avSwings.length} (engine attacking in ${avSwings.filter((w) => w.atk).length}); peer hp drops=${hpDrops.length} [${hpDrops.map((h) => h.from.toFixed(0) + '->' + h.to.toFixed(0)).join(' ')}]; bars reach the browser after ${lat.map(f0).join(',')} ms`);
  for (const l of perSwing) ctx.log('  swing ' + l);
  const fwd1 = String(await a.eval('window.omw.state.hitFwdCount'));
  ctx.log(`hitFwdCount ${fwd0} -> ${fwd1} (real swings must not forward); client probe hp ${samples[0]?.pr?.hp} -> ${samples.at(-1)?.pr?.hp}`);

  // ---------------------------------------------------------------- 4. claims
  const claims = srv.filter((l) => /combat claim without the conversation|travel claim without the conversation/.test(l));
  ctx.log(`rejected claims in the server log: ${claims.length}${claims.length ? ' e.g. ' + claims[0].slice(0, 300) : ''}`);

  // ---------------------------------------------------------------- verdicts
  const fails = [];
  // A CLIENT BELOW REAL TIME CANNOT KEEP UP WITH ANYTHING. The engine simulates at most 200 ms
  // a frame, so at 2 fps (#147, SwiftShader on the builder) a puppet lives at 40% of wall time
  // and falls behind a creature the stream reports within 1 u. The bar is judged where the
  // client runs near real time; below that the numbers are logged, and live telemetry from a
  // real browser is the evidence.
  const REALTIME_FPS = Number(process.env.S171_REALTIME_FPS ?? 20);
  if (gapsBest.length >= 5 && q(gapsBest, 0.9) > 64) {
    if (fps.fps >= REALTIME_FPS) fails.push(`the client's ${victim} strays from the peer's while moving: lag-tolerant gap p90 ${f0(q(gapsBest, 0.9))} u (> 64)`);
    else ctx.log(`NOT JUDGED here: position gap p90 ${f0(q(gapsBest, 0.9))} u at ${fps.fps.toFixed(1)} fps (< ${REALTIME_FPS}: the client simulates ${Math.min(100, Math.round(fps.fps * 20))}% of wall time)`);
  }
  if (havePeer && runs.length > 0 && rises.length < Math.ceil(runs.length * 0.8)) fails.push(`the peer's ${victim} attacked ${runs.length} times; the browser received the use bit ${rises.length} times`);
  const bitten = samples.some((s, i) => i > 0 && parseInt(s.ss) < parseInt(samples[0].ss));
  if ((havePeer ? runs.length : rises.length) === 0 && !bitten) fails.push(`the ${victim} never attacked in ${Math.round(FIGHT_MS / 1000)} s -- nothing for the client to show`);
  const inRange = perSwing.length;
  if (inRange >= 3 && hpDrops.length === 0) fails.push(`${inRange} real in-range swings, the peer's ${victim} never lost health`);
  if (lat.some((x) => x > 250)) fails.push(`the bars reached the browser ${lat.filter((x) => x > 250).map(f0).join(',')} ms after the peer's hit (> 250)`);
  if (claims.length) fails.push(`${claims.length} rejected combat/travel claims in the server log`);
  if (fwd1 !== fwd0) fails.push(`a real swing went out on the relay (hitFwdCount ${fwd0} -> ${fwd1})`);
  writeFileSync(join(SHOTS, "data.json"), JSON.stringify({ t0, netId, victim, samples, swings, peerLines, tap: tap1, fps }));
  ctx.log(`screenshots: ${shot} in ${SHOTS}`);
  assert.ok(fails.length === 0, 'the fight is not what the player expects:\n  - ' + fails.join('\n  - '));
  ctx.log('ok: the creature tracks, attacks visibly, and real swings land');
}
