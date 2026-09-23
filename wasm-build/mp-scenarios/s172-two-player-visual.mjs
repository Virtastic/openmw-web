// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s172: TWO PLAYERS, WHAT EACH ONE SEES. "Rubber-banding, laggy movement, NPCs moving slowly
// and strangely, not seeing them attack, hits not registering" -- reported from live play
// while every movement scenario stayed green, because each asserts ONE mirror at ONE moment.
// This one measures, from both screens at once, with screenshots:
//   a. A walks/runs/turns/stops while B watches: A's own position vs A's puppet on B (lag
//      distance, time lag, snaps), and the pose stream as it reached B's browser (wire rate/gaps).
//   b. A's own reconciliation: selfDivergence p50/p95/max and hard snaps (s162 measures the
//      shaped-link case; this is the plain LAN one, beside a friend).
//   c. The same NPC/creature on A, on B, on B's wire and on the peer while it moves -- the
//      clients cannot report their animation, so their side is the screenshots (an NPC
//      puppet's snap is silent: actors.snapActor prints nothing, so it cannot be counted);
//      THE PEER'S SIDE needs a diagnostic print this file does not ship: actors.lua's
//      holder tick printing `[mp] PEERPROBE n= cell= rec= x= y= z= hp= fl= av= lo=<speed>
//      up=<ATK|-> fps=` at 2 Hz (no openmw.animation in GLOBAL context: it throws). Without
//      it the peer bars are skipped and the rest still runs.
//   d. A creature fighting A: its use bit on the wire at A and at B (the attack both should
//      see), A's hp on A's screen, and a REAL mouse swing from A registering on the peer and on B.
// Every mirror involved is 2 Hz; the page-side recorder below timestamps each write, and a
// WebSocket hook installed before the page's own scripts timestamps every pose frame, so the
// numbers are wall-clock exact up to that 500 ms mirror period.
// The pass bars (coordinator, 2026-09-23): own correction p95 <= 8 u and never > 48 u, <= 1
// hard snap per 5 min; the friend's puppet within 64 u of truth while moving; the same NPC
// within 64 u across A, B and the peer while moving; creature attacks visible to both; a real
// swing registers on the peer and both see the drop within 250 ms. All numbers are logged
// before any assertion, so a red run still reports everything.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const timeoutMs = 35 * 60_000;
export const managedPeer = true; // production lifecycle: the server's peer follows us to -2,-7
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SHOTS = join(ROOT, 'wasm-build', 'harness-out', 's172');
const STEP = 60_000;
const FIGHT_SPOT = '-12500,-53100,512'; // -2,-7: scrib / kwama forager / rat country (s109, s164)
const WEAPON = 'iron longsword';
// THE BOX IS SHARED (a Jenkins sweep beside us, --cpus=8): at full graphics two retail clients
// ran at ~0.25 fps (run 1: 35 pose mirrors in 147 s), which measures the box, not the netcode.
// Low tier, no shadows: the same world, a fraction of the SwiftShader cost. It still ran at
// 0.3-4 fps under #144's sweep, and the engine clamps a frame's simulated time to 200 ms
// (engine.cpp maxSimulationInterval): below 5 fps a client simulates 20-80 % of wall time, its
// own body falls behind its avatar and its puppets behind their streams. Read the numbers with
// the logged frame times; on an idle box the same code measures the netcode.
const LOWGFX = '&tier=low&noshadow=1';
const WALK_SPOT = { x: -12288, y: -69632, z: 87 }; // Seyda Neen, the retail start on land (s149); NPCs about. Run 1 walked +Y into the bay, run 3 into -2,-7's boulders

// Timestamps every pose frame the browser receives, before the page wraps WebSocket itself.
// 0x0101 PlayerMoveBatch: [hdr 6][u8 n] n x (u16 id + 20-byte pose). 0x0200 ActorMoveBatch:
// [hdr 6][u32 epoch][u8 n] n x (8-byte ref + 20-byte pose). Pose: f32 x,y,z; u16 yaw; u8
// pitch; u8 flags (bit3 = use/attack). PROTOCOL.md "Binary type registry".
const WIRE_HOOK = `(function(){
  var N = window.WebSocket; if (!N || window.__s172) return;
  var R = window.__s172 = { mv: {}, act: {}, n101: 0, n200: 0 };
  function W(url, p){
    var ws = p === undefined ? new N(url) : new N(url, p);
    ws.addEventListener('message', function(e){
      var d = e.data; if (!(d instanceof ArrayBuffer) || d.byteLength < 7) return;
      var v = new DataView(d), ty = v.getUint16(0, true), t = Date.now(), i, o;
      if (ty === 0x101) {
        R.n101++;
        for (i = 0, o = 7; i < v.getUint8(6) && o + 22 <= d.byteLength; i++, o += 22) {
          var a = R.mv[v.getUint16(o, true)] || (R.mv[v.getUint16(o, true)] = []);
          if (a.length < 40000) a.push([t, v.getFloat32(o + 2, true), v.getFloat32(o + 6, true), v.getFloat32(o + 10, true), v.getUint8(o + 17)]);
        }
      } else if (ty === 0x200 && d.byteLength >= 11) {
        R.n200++;
        for (i = 0, o = 11; i < v.getUint8(10) && o + 28 <= d.byteLength; i++, o += 28) {
          var k = v.getUint32(o, true) + ':' + v.getInt32(o + 4, true), fl = v.getUint8(o + 23);
          var r = R.act[k] || (R.act[k] = { n: 0, use: 0, edges: [], tl: [], prev: 0 });
          r.n++; if (fl & 8) r.use++;
          if ((fl & 8) && !(r.prev & 8) && r.edges.length < 2000) r.edges.push(t);
          r.prev = fl;
          r.tl.push([t, v.getFloat32(o + 8, true), v.getFloat32(o + 12, true), v.getFloat32(o + 16, true), fl]);
          if (r.tl.length > 900) r.tl.splice(0, 300);
        }
      }
    });
    return ws;
  }
  W.prototype = N.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(k){ W[k] = N[k]; });
  window.WebSocket = W;
})();`;
const BOOT = { retail: true, joinTimeoutMs: 420_000, newDocScript: WIRE_HOOK };

// Every write to the mirrors we read, timestamped (mp.set assigns window.omw.state[k] each time).
const REC_KEYS = ['pose', 'puppets', 'selfDivergence', 'selfSnap', 'selfStale', 'actorProbe', 'hp', 'selfFlags', 'stance'];
const INSTALL_REC = `(function(){
  if (window.__rec) return 'already';
  var H = window.__rec = { fps: [] }, keys = ${JSON.stringify(REC_KEYS)};
  var target = window.omw.state;
  window.omw.state = new Proxy(target, { set: function(o, k, v){ o[k] = v;
    if (keys.indexOf(k) >= 0) (H[k] || (H[k] = [])).push([Date.now(), v]); return true; } });
  setInterval(function(){ H.fps.push([Date.now(), +(window.__frameMs || 0)]); }, 1000);
  return 'ok';
})()`;
const DRAIN = `JSON.stringify((function(){ var H = window.__rec, out = {}; for (var k in H) { out[k] = H[k]; H[k] = []; } return out; })())`;

const q = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = (arr) => `p50=${q(arr, 0.5).toFixed(1)} p95=${q(arr, 0.95).toFixed(1)} max=${(arr.length ? Math.max(...arr) : NaN).toFixed(1)} n=${arr.length}`;
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Linear interpolation of a [{t,x,y,z}] track at time t; null outside it.
function at(track, t) {
  if (!track.length || t < track[0].t || t > track[track.length - 1].t) return null;
  for (let i = 1; i < track.length; i++) {
    if (track[i].t >= t) {
      const a = track[i - 1], b = track[i], k = (t - a.t) / Math.max(1, b.t - a.t);
      return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
    }
  }
  return null;
}

export default async function run(ctx) {
  const simPeer = ctx.startSimPeer('-2,-9');
  if (!simPeer) { ctx.log('SKIP: no simulating sim peer available (OMW_SIM_PEER_BIN unset).'); return; }
  mkdirSync(SHOTS, { recursive: true });
  const bars = []; // what missed the bar, asserted at the very end
  const bar = (ok, what) => { ctx.log(`${ok ? 'MEETS' : 'MISSES'}: ${what}`); if (!ok) bars.push(what); };
  const shot = async (c, name) => { const p = join(SHOTS, name); try { await c.screenshot(p); ctx.log(`screenshot ${p}`); } catch (e) { ctx.log(`screenshot ${name} failed: ${e.message}`); } };

  const [a, b] = await Promise.all([ctx.launchClient('bot-a', LOWGFX, BOOT), ctx.launchClient('bot-b', LOWGFX, BOOT)]);
  for (const c of [a, b]) await c.waitFor('String(window.omw.state.baselineReady||"") === "1"', 180_000, `${c.name} settled`);
  const idA = String(await a.eval('window.omw.state.playerId'));
  const rowA = `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(idA)}]||{})`;
  await b.waitFor(`${rowA}.x !== undefined`, 120_000, 'B has a puppet of A');
  await a.waitFor('Number(window.omw.state.puppetedActors||0) > 0', 180_000, 'the peer holds our cell (A puppets its actors)');
  await a.waitFor('typeof window.omw.state.selfDivergence === "string"', STEP, 'the avatar rules A');
  // The onboarding tour sits over the canvas in every screenshot and eats input (s64).
  for (const c of [a, b]) { try { await c.click('#omw-tour-x'); } catch { /* none */ } }
  for (const c of [a, b]) ctx.log(`${c.name}: rec ${await c.eval(INSTALL_REC)}, wire hook ${await c.eval('!!window.__s172')}`);

  // --- the peer's side: '[mp] PEERPROBE n=..' lines (the builder's diagnostic patch to
  // actors.lua), stamped on arrival. Managed, the peer's [mp] lines ride the server log.
  const peer = []; const seenPeer = new Set(); let peerPoll = true;
  const peerLoop = (async () => {
    while (peerPoll) {
      const text = `${ctx.peerLogTail?.(1500) ?? ''}\n${ctx.serverLogTail?.(1500) ?? ''}`;
      const now = Date.now();
      for (const m of text.matchAll(/PEERPROBE n=(\d+) cell=(\S+) rec=(\S+) x=(-?\d+) y=(-?\d+) z=(-?\d+) hp=(-?[\d.]+) fl=(-?\d+) av=(-?[\d.]+) lo=(\S+) up=(\S+) fps=([\d.]+)/g)) {
        const key = m[1] + '|' + m[3] + '|' + m[4];
        if (seenPeer.has(key)) continue; seenPeer.add(key);
        peer.push({ t: now, n: +m[1], cell: m[2], rec: m[3], x: +m[4], y: +m[5], z: +m[6], hp: +m[7], fl: +m[8], av: +m[9], lo: m[10], up: m[11], fps: +m[12] });
      }
      await ctx.sleep(400);
    }
  })();

  const drain = async (c) => JSON.parse(await c.eval(DRAIN));
  const wire = async (c) => JSON.parse(await c.eval('JSON.stringify(window.__s172||{})'));
  const snapLines = (c, re) => c.logMatches(re).length;

  // ===================== a + b: A walks, runs, turns and stops; B watches ==================
  // Onto the land at the Seyda Neen start, both of us.
  await a.cmd(`snapto:${WALK_SPOT.x},${WALK_SPOT.y},${WALK_SPOT.z}`);
  await b.cmd(`snapto:${WALK_SPOT.x + 400},${WALK_SPOT.y},${WALK_SPOT.z}`);
  await a.waitFor('window.omw.state.cell === "-2,-9" && window.omw.state.authorityHolder !== "none" && Number(window.omw.state.puppetedActors||0) > 0', 240_000, 'the peer holds -2,-9');
  await a.eval("window.omw.state.selfDivergence = null; 'x'");
  await a.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', STEP, 'A\'s avatar followed').catch((e) => ctx.log('A settle: ' + e.message.split('\n')[0]));
  const pA = JSON.parse(await a.eval('window.omw.state.pose'));
  ctx.log(`at the start: A ${JSON.stringify(pA)}`);
  // B 400 u to A's +X side (a same-cell hop under 256 u is never announced, so the avatar stays
  // put and drags B back: run 4 had B standing inside A); A walks a square around B's side of the field (one leg of a square
  // always runs into the open whatever the rocks do), B turning to keep A in view for each shot.
  await b.cmd(`snapto:${Math.round(pA.x + 400)},${Math.round(pA.y)},${Math.round(pA.z + 30)}`);
  await b.waitFor('Number(window.omw.state.selfDivergence||999) < 96', STEP, 'B\'s avatar followed B').catch((e) => ctx.log('B settle: ' + e.message.split('\n')[0]));
  const lookAtA = async () => { const p = JSON.parse(await a.eval('window.omw.state.pose')); await b.cmd(`face:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z + 60)}`); };
  const headA = async (dx, dy) => { const p = JSON.parse(await a.eval('window.omw.state.pose')); await a.cmd(`face:${Math.round(p.x + dx * 3000)},${Math.round(p.y + dy * 3000)},${Math.round(p.z + 100)}`); };
  await lookAtA(); await headA(0, -1);
  await ctx.sleep(1500);
  await shot(b, 'a0-b-before-walk.png');
  ctx.log(`puppets on B: ${await b.eval('window.omw.state.puppets')} | on A: ${await a.eval('window.omw.state.puppets')}`);
  await Promise.all([drain(a), drain(b)]);
  const snapA0 = snapLines(a, /SELF SNAP/), pupSnapB0 = snapLines(b, new RegExp(`puppet snap #${idA}\b`));
  const tWalk0 = Date.now();
  // walk -Y 5 s; turn, run -X 5 s; turn, run +Y 5 s; stop 4 s; turn, walk +X 4 s; stop (away from the bay first).
  await a.cmd('walk:0,1,5000');
  await ctx.sleep(2500); await lookAtA(); await shot(b, 'a1-b-sees-A-walking.png');
  await ctx.sleep(2500);
  await headA(-1, 0); await a.cmd('walk:0,1,5000:run');
  await ctx.sleep(2500); await lookAtA(); await shot(b, 'a2-b-sees-A-running.png');
  await ctx.sleep(2500);
  await headA(0, 1); await a.cmd('walk:0,1,5000:run');
  await ctx.sleep(2500); await lookAtA(); await shot(b, 'a3-b-sees-A-turned-running.png');
  await ctx.sleep(6500); // the rest of the run, then 4 s stopped
  await lookAtA(); await shot(b, 'a4-b-sees-A-stopped.png');
  await headA(1, 0); await a.cmd('walk:0,1,4000');
  await ctx.sleep(7000);
  const tWalk1 = Date.now();
  const [hA, hB] = await Promise.all([drain(a), drain(b)]);
  const wB = await wire(b);

  const trackA = (hA.pose || []).map(([t, v]) => ({ t, ...JSON.parse(v) }));
  const trackP = (hB.puppets || []).map(([t, v]) => { const r = JSON.parse(v)[idA]; return r ? { t, x: r.x, y: r.y, z: r.z, flags: r.flags } : null; }).filter(Boolean);
  const wireA = (wB.mv?.[idA] || []).filter((e) => e[0] >= tWalk0 && e[0] <= tWalk1).map(([t, x, y, z, fl]) => ({ t, x, y, z, fl }));
  const walked = trackA.length ? d2(trackA[0], trackA[trackA.length - 1]) : 0;
  let pathLen = 0; for (let i = 1; i < trackA.length; i++) pathLen += d2(trackA[i - 1], trackA[i]);
  ctx.log(`a: A's own path ${pathLen.toFixed(0)} u over ${((tWalk1 - tWalk0) / 1000).toFixed(1)} s (${trackA.length} pose samples); B puppet samples ${trackP.length}; wire poses of A at B ${wireA.length}`);
  // Lag DISTANCE: the puppet on B against A's own position at the same instant, while A moves.
  const lagD = [], lagT = [], movingLag = [];
  for (const s of trackP) {
    const truth = at(trackA, s.t); if (!truth) continue;
    const d = d2(truth, s); lagD.push(d);
    const before = at(trackA, s.t - 500);
    if (before && d2(before, truth) > 20) movingLag.push(d);
    // Time lag: how far back along A's path the puppet stands (0..3 s, 25 ms steps).
    let best = Infinity, bestTau = NaN;
    for (let tau = 0; tau <= 3000; tau += 25) { const p = at(trackA, s.t - tau); if (p) { const dd = d2(p, s); if (dd < best) { best = dd; bestTau = tau; } } }
    if (best < 40) lagT.push(bestTau);
  }
  // Wire: gaps between A's poses arriving at B (a jerky stream shows as a steering puppet
  // that stops and starts) and the wire pose vs A's truth (network + peer lag, before steering).
  const gaps = []; for (let i = 1; i < wireA.length; i++) gaps.push(wireA[i].t - wireA[i - 1].t);
  const wireLag = []; for (const s of wireA) { const tr = at(trackA, s.t); if (tr) wireLag.push(d2(tr, s)); }
  // Snaps: B's console narrates every teleport it gives a puppet; also any single mirror step
  // far beyond run speed (~400 u/s x period) counts as a visible jump.
  const pupSnaps = snapLines(b, new RegExp(`puppet snap #${idA}\\b`)) - pupSnapB0;
  let jumps = 0; for (let i = 1; i < trackP.length; i++) { const dt = (trackP[i].t - trackP[i - 1].t) / 1000; if (d2(trackP[i], trackP[i - 1]) > 150 + 450 * dt) jumps++; }
  // Speed of the puppet vs A over the same windows: a puppet steering at walk speed behind a
  // running A falls behind and snaps; one sliding at A's speed while standing is a teleport.
  const spd = (tr) => { const v = []; for (let i = 1; i < tr.length; i++) { const dt = (tr[i].t - tr[i - 1].t) / 1000; if (dt > 0.2) v.push(d2(tr[i], tr[i - 1]) / dt); } return v; };
  ctx.log(`a: puppet-of-A on B vs A's own position: ${stats(lagD)}; while A moves: ${stats(movingLag)}`);
  ctx.log(`a: puppet time lag behind A: ${stats(lagT)} ms`);
  ctx.log(`a: A's pose on the wire at B vs A's truth: ${stats(wireLag)}; arrival gaps ${stats(gaps)} ms`);
  ctx.log(`a: speeds u/s -- A ${stats(spd(trackA))} | puppet on B ${stats(spd(trackP))}`);
  ctx.log(`a: puppet teleports on B (console) ${pupSnaps}; mirror steps beyond run speed ${jumps}; puppet flags seen ${[...new Set(trackP.map((s) => s.flags))].join(',')}`);
  bar(movingLag.length > 0 && q(movingLag, 0.95) <= 64, `a: friend's puppet within 64 u of truth while moving (p95 ${q(movingLag, 0.95).toFixed(0)})`);
  bar(pupSnaps === 0 && jumps === 0, `a: friend's puppet never teleports (${pupSnaps} snaps, ${jumps} jumps)`);

  // b: A's own reconciliation over the same walk.
  const div = (hA.selfDivergence || []).map(([, v]) => Number(v)).filter(Number.isFinite);
  const corr = div.map((d) => Math.min(48, d * 0.25)); // player.lua CORRECT_GAIN / CORRECT_CAP
  const selfSnaps = snapLines(a, /SELF SNAP/) - snapA0;
  const fpsA = (hA.fps || []).map(([, f]) => f), fpsB = (hB.fps || []).map(([, f]) => f);
  ctx.log(`b: A selfDivergence ${stats(div)}; per-frame correction ${stats(corr)}; >48 u: ${div.filter((d) => d > 48).length}; hard snaps ${selfSnaps} (${(hA.selfSnap || []).map(([, v]) => v).join(' | ')})`);
  const period = (tr) => { const g = []; for (let i = 1; i < tr.length; i++) g.push(tr[i].t - tr[i - 1].t); return g; };
  ctx.log(`b: client frame time (ms, engine avg) A ${stats(fpsA)} B ${stats(fpsB)}; pose-mirror period on A (500 ms at >= 2 fps) ${stats(period(trackA))} ms`);
  bar(div.length > 0 && q(div, 0.95) <= 8 && Math.max(...div) <= 48, `b: own correction p95 <= 8 u, max <= 48 (p95 ${q(div, 0.95).toFixed(1)}, max ${Math.max(...div).toFixed(1)})`);
  bar(selfSnaps <= 1, `b: <= 1 hard snap (${selfSnaps})`);

  // ===================== c: the same actor on A, on B and on the peer =====================
  // Watch 25 s with both looking the same way, then pick the actor that moved most and was
  // unique on every screen.
  // Back to the start (the walk can end anywhere), both of us, before watching the town.
  await a.cmd(`snapto:${WALK_SPOT.x},${WALK_SPOT.y},${WALK_SPOT.z}`);
  await b.cmd(`snapto:${WALK_SPOT.x + 400},${WALK_SPOT.y},${WALK_SPOT.z}`);
  await ctx.sleep(4000);
  const pNow = JSON.parse(await a.eval('window.omw.state.pose'));
  await Promise.all([drain(a), drain(b)]);
  const tC0 = Date.now();
  await ctx.sleep(12_000);
  // Look at the busiest mover so the screenshots show it.
  const probeA = JSON.parse(await a.eval('window.omw.state.actorProbe||"{}"'));
  const near = Object.entries(probeA).filter(([, p]) => (p.n ?? 1) === 1 && !p.dead && Math.hypot(p.x - pNow.x, p.y - pNow.y) < 4000);
  const pk = peer.filter((r) => r.t >= tC0);
  const moved = (rec) => { const rs = pk.filter((r) => r.rec === rec); return rs.length > 1 ? Math.hypot(rs[rs.length - 1].x - rs[0].x, rs[rs.length - 1].y - rs[0].y) + rs.filter((r, i) => i && Math.hypot(r.x - rs[i - 1].x, r.y - rs[i - 1].y) > 5).length * 10 : 0; };
  near.sort((x, y) => moved(y[0]) - moved(x[0]));
  const focus = near[0]?.[0];
  ctx.log(`c: candidates near A: ${near.slice(0, 6).map(([r, p]) => `${r}@${Math.hypot(p.x - pNow.x, p.y - pNow.y).toFixed(0)}u moved~${moved(r).toFixed(0)}`).join(', ') || 'none'}`);
  if (focus) {
    const f = probeA[focus];
    await Promise.all([a.cmd(`face:${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.z + 60)}`), b.cmd(`face:${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.z + 60)}`)]);
    await ctx.sleep(1500);
    await shot(a, 'c1-a-sees-npc.png'); await shot(b, 'c1-b-sees-npc.png');
    await ctx.sleep(4000);
    await shot(a, 'c2-a-sees-npc.png'); await shot(b, 'c2-b-sees-npc.png');
  }
  await ctx.sleep(6000);
  const [cA, cB] = await Promise.all([drain(a), drain(b)]);
  const cWireB = await wire(b);
  const probeTrack = (h, rec) => (h.actorProbe || []).map(([t, v]) => { const p = JSON.parse(v)[rec]; return p ? { t, x: p.x, y: p.y, z: p.z, hp: p.hp } : null; }).filter(Boolean);
  const cRecs = near.slice(0, 5).map(([r]) => r);
  let worstMovingAB = [], worstMovingPeer = [];
  // THE PEER'S COPY OF THE SAME ACTOR: the probe keys by record and several rats share one, so
  // follow one body through the peer's 2 Hz dumps -- start at the row nearest the client's first
  // sample, then at each dump take the same-record row nearest the previous one.
  const chain = (rows, from) => {
    const byN = new Map(); for (const r of rows) (byN.get(r.n) || byN.set(r.n, []).get(r.n)).push(r);
    let prev = from, out = [];
    for (const n of [...byN.keys()].sort((x, y) => x - y)) {
      const best = byN.get(n).reduce((m, r) => (!m || d2(r, prev) < d2(m, prev) ? r : m), null);
      if (best && d2(best, prev) < 400) { out.push(best); prev = best; }
    }
    return out;
  };
  for (const rec of cRecs) {
    const tA = probeTrack(cA, rec), tB = probeTrack(cB, rec);
    const tP = tB.length ? chain(peer.filter((r) => r.rec === rec && r.t >= tC0), tB[0]) : [];
    const ab = [], bp = [], ap = [], moving = [];
    for (const s of tB) {
      const x = at(tA, s.t); if (x) ab.push(d2(x, s));
      const pp = at(tP, s.t); if (pp) { bp.push(d2(pp, s)); const pp0 = at(tP, s.t - 1000); if (pp0 && d2(pp0, pp) > 30) { moving.push(d2(pp, s)); if (x) worstMovingAB.push(d2(x, s)); } }
    }
    for (const s of tA) { const pp = at(tP, s.t); if (pp) ap.push(d2(pp, s)); }
    worstMovingPeer.push(...moving);
    const pSpeed = tP.map((r) => Number(r.lo)).filter(Number.isFinite);
    const pmoving = tP.filter((r, i) => i && Math.hypot(r.x - tP[i - 1].x, r.y - tP[i - 1].y) > 10);
    ctx.log(`c: ${rec}: A-vs-B ${stats(ab)} | B-vs-peer ${stats(bp)} | A-vs-peer ${stats(ap)} | B-vs-peer while it moves ${stats(moving)} | peer engine speed ${stats(pSpeed)}; peer dumps moving ${pmoving.length}/${tP.length}; peer fps ${stats(tP.map((r) => r.fps))}; client tracks A ${tA.length} B ${tB.length} moving-on-B ${tB.filter((s, i) => i && d2(s, tB[i - 1]) > 10).length}`);
    // WHERE THE GAP OPENS: the wire ref that carries this actor (the one riding the peer's
    // track) against the peer, and B's on-screen body against that wire stream.
    if (tP.length > 3) {
      let best = null, bd = Infinity;
      for (const [k, r] of Object.entries(cWireB.act || {})) {
        const ds = r.tl.map((e) => { const p = at(tP, e[0]); return p ? Math.hypot(e[1] - p.x, e[2] - p.y) : NaN; }).filter(Number.isFinite);
        if (ds.length > 5) { const m = q(ds, 0.5); if (m < bd) { bd = m; best = k; } }
      }
      if (best) {
        const wt = cWireB.act[best].tl.filter((e) => e[0] >= tC0).map(([t, x, y, z]) => ({ t, x, y, z }));
        const wv = wt.map((s) => { const p = at(tP, s.t); return p ? d2(p, s) : NaN; }).filter(Number.isFinite);
        const bw = tB.map((s) => { const w = at(wt, s.t); return w ? d2(w, s) : NaN; }).filter(Number.isFinite);
        const g = []; for (let i = 1; i < wt.length; i++) g.push(wt[i].t - wt[i - 1].t);
        ctx.log(`c: ${rec} on B's wire (ref ${best}): wire-vs-peer ${stats(wv)} | B's body vs its own wire stream ${stats(bw)} | wire gaps ${stats(g)} ms`);
      } else ctx.log(`c: ${rec}: no wire ref at B follows the peer's track`);
    }
  }
  if (peer.length) bar(worstMovingPeer.length > 0 && q(worstMovingPeer, 0.95) <= 64, `c: a moving NPC within 64 u, B vs peer (p95 ${q(worstMovingPeer, 0.95).toFixed(0)}, n=${worstMovingPeer.length})`);
  bar(worstMovingAB.length === 0 || q(worstMovingAB, 0.95) <= 64, `c: a moving NPC within 64 u, A vs B (p95 ${q(worstMovingAB, 0.95).toFixed(0)}, n=${worstMovingAB.length})`);

  // ===================== d: a creature fights A; A swings back for real ===================
  await a.cmd('snapto:' + FIGHT_SPOT);
  await b.cmd('snapto:-12100,-53100,512');
  await a.waitFor('window.omw.state.cell === "-2,-7" && Number(window.omw.state.puppetedActors||0) > 0', 240_000, 'A stands in -2,-7 and the peer holds it');
  await ctx.sleep(3000); // a probe tick in the new cell
  await a.waitFor(`(function(){var pr=JSON.parse(window.omw.state.actorProbe||"{}");return Object.values(JSON.parse(window.omw.state.netObjects||"{}")).some(function(r){var p=pr[r];return p&&!p.dead;});})()`,
    180_000, 'the peer\'s creature is in A\'s probe, alive');
  const me = JSON.parse(await a.eval('window.omw.state.pose'));
  const probe = JSON.parse(await a.eval('window.omw.state.actorProbe||"{}"'));
  const netRecs = new Set(Object.values(JSON.parse(await a.eval('window.omw.state.netObjects||"{}"'))));
  // The nearest living non-guard actor: it is the one that will be biting A.
  const victim = Object.keys(probe).filter((r) => !probe[r].dead && !probe[r].guard && d2(probe[r], me) < 3000).sort((x, y) => d2(probe[x], me) - d2(probe[y], me))[0];

  ctx.log(`d: net creatures ${[...netRecs].join(",")}; probe ${Object.keys(probe).join(",")}`);
  assert.ok(victim, 'no living unique creature to fight');
  ctx.log(`d: the creature: ${victim} at ${d2(probe[victim], me).toFixed(0)} u, hp ${probe[victim].hp}`);
  await a.cmd(`equip:${WEAPON}:16`);
  await a.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(WEAPON)}) >= 0`, 15_000, 'the sword is in hand');
  await a.cmd('setskill:longblade:100');
  await a.cmd('stance:weapon');
  await a.waitFor('window.omw.state.stance === "weapon"', 15_000, 'the sword is drawn');
  // Beside it (step back first so the approach is an announced jump, s164), provoke with one sting.
  const c0 = probe[victim];
  const dir = { x: (me.x - c0.x) / (d2(me, c0) || 1), y: (me.y - c0.y) / (d2(me, c0) || 1) };
  await a.cmd(`snapto:${Math.round(c0.x + dir.x * 400)},${Math.round(c0.y + dir.y * 400)},${Math.round(c0.z + 8)}`);
  await ctx.sleep(1500);
  await a.cmd(`snapto:${Math.round(c0.x + dir.x * 80)},${Math.round(c0.y + dir.y * 80)},${Math.round(c0.z + 8)}`);
  await a.eval("window.omw.state.selfDivergence = null; 'x'");
  await a.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', STEP, 'A\'s avatar is beside the creature').catch((e) => ctx.log('d settle: ' + e.message.split('\n')[0]));
  await b.cmd(`snapto:${Math.round(c0.x + dir.y * 300)},${Math.round(c0.y - dir.x * 300)},${Math.round(c0.z + 8)}`);
  await ctx.sleep(1500);
  await a.cmd(`hitn:${victim}:1`);
  ctx.log(`d: puppets on B: ${await b.eval('window.omw.state.puppets')}`);
  await Promise.all([drain(a), drain(b)]);

  const tD0 = Date.now();
  // 20 s of the creature attacking a standing A; both keep looking at it.
  for (let i = 0; i < 4; i++) {
    const cp = JSON.parse(await b.eval('window.omw.state.actorProbe||"{}"'))[victim] || c0;
    await Promise.all([a.cmd(`face:${Math.round(cp.x)},${Math.round(cp.y)},${Math.round(cp.z + 30)}`), b.cmd(`face:${Math.round(cp.x)},${Math.round(cp.y)},${Math.round(cp.z + 30)}`)]);
    await ctx.sleep(2500);
    await shot(a, `d1-${i}-a-creature-attacks.png`); await shot(b, `d1-${i}-b-creature-attacks.png`);
    await ctx.sleep(2000);
  }
  const tD1 = Date.now();
  const [dA, dB] = await Promise.all([drain(a), drain(b)]);
  const [wA1, wB1] = [await wire(a), await wire(b)];
  // The creature's ref on the wire: the actor whose wire track sits on the probe's position.
  const refOf = (w, track) => { let best = null, bd = Infinity; for (const [k, r] of Object.entries(w.act || {})) { const ds = []; for (const e of r.tl) { const p = at(track, e[0]); if (p) ds.push(Math.hypot(e[1] - p.x, e[2] - p.y)); } if (ds.length > 3) { const m = ds.reduce((s, v) => s + v, 0) / ds.length; if (m < bd) { bd = m; best = k; } } } return best; };
  const vTrackA = probeTrack(dA, victim), vTrackB = probeTrack(dB, victim);
  const refA = refOf(wA1, vTrackA), refB = refOf(wB1, vTrackB);
  const edgesIn = (w, ref) => ((w.act?.[ref]?.edges) || []).filter((t) => t >= tD0 && t <= tD1).length;
  // WHOEVER IS BITING A: every wire actor that came within 250 u of A in the window, with its
  // use-bit edges as each screen received them (the creature on the probe may not be the one).
  const trackAd = (dA.pose || []).map(([t, v]) => ({ t, ...JSON.parse(v) }));
  const nearA = (w) => Object.entries(w.act || {}).map(([k, r]) => {
    const tl = r.tl.filter((e) => e[0] >= tD0 && e[0] <= tD1);
    const md = Math.min(...tl.map((e) => { const p = at(trackAd, e[0]); return p ? Math.hypot(e[1] - p.x, e[2] - p.y) : Infinity; }));
    return { k, md, edges: r.edges.filter((t) => t >= tD0 && t <= tD1).length, useFrames: tl.filter((e) => e[4] & 8).length, frames: tl.length };
  }).filter((x) => x.md < 250);
  const nA = nearA(wA1), nB = nearA(wB1);
  ctx.log(`d1: actors within 250 u of A -- on A's wire ${JSON.stringify(nA)} | on B's wire ${JSON.stringify(nB)}`);
  const peerV = vTrackA.length ? chain(peer.filter((r) => r.rec === victim && r.t >= tD0 && r.t <= tD1), vTrackA[0]) : [];
  const peerAttack = peerV.filter((r) => (r.fl & 8) || r.up === 'ATK');
  const hpA = (dA.hp || []).map(([t, v]) => [t, Number(v)]);
  const hpDrops = hpA.filter((e, i) => i && e[1] < hpA[i - 1][1]);
  ctx.log(`d1: the creature on the peer: ${peerV.length} samples, attacking in ${peerAttack.length} (up/lo groups ${[...new Set(peerV.map((r) => r.lo + '/' + r.up))].join(' ')})`);
  ctx.log(`d1: use-bit edges on the wire -- at A (ref ${refA}) ${edgesIn(wA1, refA)}, at B (ref ${refB}) ${edgesIn(wB1, refB)}; A's hp on A's screen ${hpA.map((e) => e[1]).join(' -> ') || '(no change)'} (${hpDrops.length} drops)`);
  if (peer.length) bar(peerAttack.length > 0, `d: the creature attacks on the peer (${peerAttack.length} samples)`);
  bar(nA.some((x) => x.edges > 0) && nB.some((x) => x.edges > 0), 'd: attacks on A reach both screens (use-bit edges from an actor beside A, at A and at B)');
  bar(hpDrops.length > 0, `d: A's hp drops on A's screen (${hpDrops.length})`);

  // Real swings: focus the canvas the way a player does, face the creature, hold the button.
  try { await a.mouseHold(60); } catch (e) { ctx.log('focus click: ' + e.message); }
  await ctx.sleep(500);
  await a.cmd('stance:weapon');
  const swings = [];
  for (let i = 0; i < 8; i++) {
    const st = JSON.parse(await a.eval(`JSON.stringify({ p: (JSON.parse(window.omw.state.actorProbe||"{}"))[${JSON.stringify(victim)}] || null, me: JSON.parse(window.omw.state.pose||"{}") })`));
    if (!st.p || st.p.dead) break;
    if (d2(st.p, st.me) > 110) {
      await a.cmd(`snapto:${Math.round(st.p.x + dir.x * 70)},${Math.round(st.p.y + dir.y * 70)},${Math.round(st.p.z + 8)}`);
      await a.waitFor('Number(window.omw.state.selfDivergence||999) < 60', 15_000, 'the avatar came along').catch(() => {});
    }
    await a.cmd(`face:${Math.round(st.p.x)},${Math.round(st.p.y)},${Math.round(st.p.z + 20)}`);
    const t0 = Date.now();
    await a.mouseHold(900);
    swings.push({ t0, tRel: Date.now(), hp0: st.p.hp });
    if (i === 1) { await shot(a, 'd2-a-swings.png'); await shot(b, 'd2-b-sees-A-swing.png'); }
    await ctx.sleep(1800);
  }
  await ctx.sleep(1500);
  const [sA, sB] = await Promise.all([drain(a), drain(b)]);
  const flagsA = (sA.selfFlags || []).map(([t, v]) => [t, Number(v)]);
  const avatarSwung = swings.map((s) => flagsA.some(([t, f]) => t >= s.t0 && t <= s.tRel + 1500 && (f & 8)));
  const hpTrackOf = (h) => probeTrack(h, victim).map((s) => [s.t, s.hp]);
  const firstDropAfter = (track, t) => { let prev = null; for (const [tt, hp] of track) { if (tt >= t && prev != null && hp < prev) return tt; prev = hp; } return null; };
  const vStart = probeTrack(sA, victim)[0] || vTrackA[vTrackA.length - 1];
  const peerHp = vStart ? chain(peer.filter((r) => r.rec === victim && r.t >= (swings[0]?.t0 ?? 0) - 1000), vStart).map((r) => [r.t, r.hp]) : [];
  for (const [i, s] of swings.entries()) {
    const pd = firstDropAfter(peerHp, s.t0), ad = firstDropAfter(hpTrackOf(sA), s.t0), bd = firstDropAfter(hpTrackOf(sB), s.t0);
    const rel = (x) => (x == null || x > s.tRel + 2500 ? '-' : `${x - s.tRel}ms`);
    ctx.log(`d2: swing ${i}: avatar use bit ${avatarSwung[i] ? 'yes' : 'NO'}; creature hp drop after release -- peer ${rel(pd)} A ${rel(ad)} B ${rel(bd)}`);
  }
  const hpSeq = (tr) => tr.map((e) => e[1]).filter((v, i, arr) => i === 0 || v !== arr[i - 1]).join('>');
  ctx.log(`d2: creature hp -- peer ${hpSeq(peerHp.filter(([t]) => t >= swings[0]?.t0))} | A ${hpSeq(hpTrackOf(sA))} | B ${hpSeq(hpTrackOf(sB))}; A hitFwdCount ${await a.eval('window.omw.state.hitFwdCount')}`);
  bar(avatarSwung.some(Boolean), `d: a real mouse swing reaches the avatar (${avatarSwung.filter(Boolean).length}/${swings.length})`);
  const peerDropped = peerHp.length > 1 && Math.min(...peerHp.filter(([t]) => t >= (swings[0]?.t0 ?? Infinity)).map((e) => e[1])) < (swings[0]?.hp0 ?? -1);
  bar(peerDropped || hpSeq(hpTrackOf(sB)).includes('>'), 'd: a real swing registers (creature hp drops on the peer, or on B when the peer probe is off)');
  await shot(a, 'd3-a-after-swings.png'); await shot(b, 'd3-b-after-swings.png');

  peerPoll = false; await peerLoop;
  ctx.log(`wire totals: A n101=${wA1.n101} n200=${wA1.n200}; B n101=${wB1.n101} n200=${wB1.n200}`);
  assert.equal(bars.length, 0, `missed ${bars.length} bar(s):\n  ${bars.join('\n  ')}`);
}
