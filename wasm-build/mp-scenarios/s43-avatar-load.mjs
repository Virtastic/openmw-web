// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s43 (Phase G): AVATAR RENDER LOAD. The server side of a crowded cell is settled — the
// broadcaster costs ~7% of a tick with 100 players co-located (server/README.md). What has
// never been measured is the side that actually binds: ONE browser client rendering and
// interpolating N remote avatars on top of the cell's NPCs.
//
// So this ramps protocol bots into the client's own cell and samples real frame cost at
// each step. It is a MEASUREMENT first and a gate second: the pass condition is deliberately
// loose (the client must stay alive, connected, and still spawning puppets for everyone it
// is told about), because the useful output is the table, not a green tick. A hard fps
// threshold here would only encode whatever this particular box happened to do.
//
// Why bots and not browser clients: 64 retail clients is ~96 GB of pinned WASM heap. Bots
// are indistinguishable from real players on the wire, which is exactly the load under test
// — the client cannot tell what is on the far end of a pose stream.
//
// RETAIL DATA REQUIRED (the clean Example Suite ships no NPCs, so there is no crowd).
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Steps are cumulative avatar counts, not wave sizes.
const STEPS = (process.env.S43_STEPS ?? '8,16,32,48,64').split(',').map(Number);
const SETTLE_MS = Number(process.env.S43_SETTLE_MS ?? 8_000);
// Generous: this covers `npx tsx` cold start plus N logins on a box that may be busy.
const JOIN_TIMEOUT = Number(process.env.S43_JOIN_TIMEOUT ?? 180_000);
const SAMPLE_MS = Number(process.env.S43_SAMPLE_MS ?? 12_000);
const STEP_TIMEOUT = 60_000;
const BOOT = { retail: true, joinTimeoutMs: 420_000 };

// Bots must outlive the whole ramp; they are killed explicitly at the end.
const BOT_MINUTES = Math.ceil((STEPS.length * (SETTLE_MS + SAMPLE_MS)) / 60_000) + 5;

// [content] enforce = "off" is REQUIRED to mix protocol bots with a retail browser client,
// and the reason is not obvious: ContentGate adopts the FIRST client's manifest as the
// session's canonical one (core/manifest.ts). The browser client joins first carrying the
// full retail manifest, so every bot afterwards is refused BAD_CONTENT and the socket closes
// mid-handshake — the crowd silently never arrives. Bot-only soaks never hit this because
// the bots all agree with each other. Content policy is not what this scenario measures.
// A/B arm. S43_RENDER_LOD=full is the control (every avatar fully simulated, pre-G2);
// "tiered" degrades by distance. S43_LOD_RADIUS=0 forces every avatar into the far tier,
// which is how a fixed test layout exercises degradation without walking anyone anywhere.
const RENDER_LOD = process.env.S43_RENDER_LOD ?? 'tiered';
const LOD_RADIUS = Number(process.env.S43_LOD_RADIUS ?? 0);
// The arm that matters for a real crowd: set S43_LOD_RADIUS huge so every avatar is inside
// the near radius (a market square, where distance culling does nothing) and let the cap be
// the only thing bounding cost.
const NEAR_MAX = Number(process.env.S43_NEAR_MAX ?? 0);

// The send RATES are pinned to 15 Hz in BOTH arms on purpose. Shipping couples render tier
// to network tier, but for measurement that would change two things at once and the win
// could not be attributed: a cheaper frame might just mean fewer poses arrived. Holding the
// network identical leaves render tiering as the only variable.
export const serverRules =
  `\n[server]\nmaxPlayers = ${Math.max(...STEPS) * 2 + 16}\n`
  + `\n[content]\nenforce = "off"\n`
  + `\n[limits]\nmaxConnsPerIp = ${Math.max(...STEPS) * 2 + 16}\nloginPerMinPerIp = 100000\n`
  + `renderLod = "${RENDER_LOD}"\n`
  + `lodNearRadius = ${LOD_RADIUS}\nlodMidRadius = ${LOD_RADIUS}\n`
  + `lodNearMaxAvatars = ${NEAR_MAX}\n`
  // Culling off. A load test wants every avatar actually delivered — with culling on, the
  // server would quietly drop distant peers and the client would render a smaller crowd
  // than the one named in the results. (It is also required config-wise: interestRadius
  // must be 0 or >= lodMidRadius, and the crowd arm sets a huge lodMidRadius.)
  + `interestRadius = 0\n`
  + `lodNearHz = 15\nlodMidHz = 15\nlodFarHz = 15\n`;

async function cellKeyOf(c) {
  const census = JSON.parse(await c.eval('(window.__omwMP||{}).actorCensus||"[]"'));
  const me = census.find((e) => e.startsWith('player@'));
  if (!me) throw new Error(`[${c.name}] actorCensus has no player entry`);
  return me.slice('player@'.length);
}

const puppetCount = async (c) => Object.keys(JSON.parse(await c.eval('(window.__omwMP||{}).puppets||"{}"'))).length;

// Median of repeated samples, not a mean: a single GC pause or compositor hitch skews a
// mean badly at this sample count, and the question here is what a frame typically costs.
async function sampleFrame(ctx, c, ms) {
  const fps = [];
  const frameMs = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    fps.push(Number(await c.eval('window.__fps||0')));
    frameMs.push(Number(await c.eval('window.__frameMs||0')));
    await ctx.sleep(1000);
  }
  const med = (a) => a.filter((v) => v > 0).sort((x, y) => x - y)[Math.floor(a.filter((v) => v > 0).length / 2)] ?? 0;
  // Host load is captured with every sample because this measurement is usually taken on a
  // shared workstation. Absolute fps is only meaningful on a quiet box; the RELATIVE shape
  // across steps survives contention, since the contention is roughly constant throughout a
  // run. A row whose load differs sharply from its neighbours should be re-taken, not
  // reasoned about — record the number so that is a decision and not a guess.
  return { fps: med(fps), frameMs: med(frameMs), worstFrameMs: Math.max(...frameMs), load: +os.loadavg()[0].toFixed(1) };
}

export default async function run(ctx) {
  if (!existsSync(join(ROOT, 'play', 'mwdata', 'Morrowind.esm'))) {
    ctx.log('SKIP: play/mwdata/Morrowind.esm absent (retail data required)');
    return;
  }

  const c = await ctx.launchClient('lodmeter', '', BOOT);
  await c.waitFor('Number((window.__omwMP||{}).actorCount||0) > 0', STEP_TIMEOUT, 'client sees cell actors');
  const cellKey = await cellKeyOf(c);
  ctx.log(`measuring in cell ${cellKey}; ramp ${STEPS.join(' -> ')} avatars; `
    + `renderLod=${RENDER_LOD} lodRadius=${LOD_RADIUS}`);

  const base = await sampleFrame(ctx, c, SAMPLE_MS);
  ctx.log(`  0 avatars: ${base.fps} fps, frame ${base.frameMs}ms (worst ${base.worstFrameMs}ms)`);

  const waves = [];
  const rows = [{ n: 0, ...base, puppets: 0 }];
  let spawned = 0;
  try {
    for (const target of STEPS) {
      const add = target - spawned;
      if (add <= 0) continue;
      const w = spawn('npx', ['tsx', 'bots/soak.ts',
        '--attach', String(ctx.serverPort), '--onecell', '--cellkey', cellKey,
        // Distinct name prefix per wave: bot names are account keys, so a second wave
        // reusing soak0..soakN supersedes the first wave's sessions instead of adding
        // players, and the population silently stops growing at the first wave's size.
        '--prefix', `w${target}_`,
        '--bots', String(add), '--minutes', String(BOT_MINUTES)],
        { cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
      w.stdout.on('data', (b) => {
        for (const ln of String(b).split('\n')) if (ln.trim()) ctx.log(`  [bots] ${ln.trim().slice(0, 220)}`);
      });
      w.stderr.on('data', (b) => ctx.log(`  [bots] ${String(b).trim().slice(0, 200)}`));
      waves.push(w);
      spawned = target;

      // WAIT for the crowd to actually arrive rather than sleeping a fixed settle and
      // hoping. `npx tsx` cold start alone can outlast a 30s timer on a loaded box, and
      // sampling before the bots connect measures an empty scene while reporting it as a
      // crowd — the failure that made the first three runs of this scenario meaningless.
      await c.waitFor(
        // +1: the roster includes this client itself.
        `JSON.parse((window.__omwMP||{}).players||'[]').length >= ${target + 1}`,
        JOIN_TIMEOUT, `roster reached ${target} remote players`);
      await ctx.sleep(SETTLE_MS); // let poses stream and puppets finish spawning
      // The client must actually be RENDERING these avatars, not merely be told about them.
      // Without this the fps number is meaningless — an idle client that dropped every
      // puppet posts a beautiful frame time. This is the same false-green shape s40 hit.
      const pups = await puppetCount(c);
      // Roster vs puppets separates "the client was never told" from "the client was told
      // and did not spawn" — two completely different bugs that look identical from the
      // puppet count alone.
      ctx.log(`  roster=${await c.eval('(window.__omwMP||{}).players||"?"')} puppets=${pups}`);
      // Prove the arm is actually the arm. "tiered" with radius 0 must put every avatar in
      // the far tier (key "2"); if the client silently kept them near, the frame numbers
      // below would be the control's numbers wearing the treatment's label — the single
      // easiest way to manufacture a fake performance win.
      const tiers = JSON.parse(await c.eval('(window.__omwMP||{}).puppetTiers||"{}"'));
      ctx.log(`  puppetTiers=${JSON.stringify(tiers)}`);
      // Both arms assert POSITIVELY that the expected tier is populated. An arm that only
      // checked "no unexpected tiers" passes against an empty mirror, which is exactly how
      // the first version of this check reported a green control against no data at all.
      if (RENDER_LOD === 'tiered' && LOD_RADIUS === 0) {
        assert.ok(tiers.far > 0, `expected FAR-tier avatars, got ${JSON.stringify(tiers)}`);
        assert.ok(!tiers.near, `expected no NEAR-tier avatars with lodRadius=0, got ${JSON.stringify(tiers)}`);
      }
      // The cap must hold even though every avatar is inside the near radius — that is the
      // whole claim: worst-case client cost stops depending on how tightly players cluster.
      if (RENDER_LOD === 'tiered' && NEAR_MAX > 0 && target > NEAR_MAX) {
        assert.ok((tiers.near ?? 0) <= NEAR_MAX,
          `near-tier cap breached: ${tiers.near} > ${NEAR_MAX} with ${target} avatars all inside the near radius`);
        assert.ok((tiers.mid ?? 0) + (tiers.far ?? 0) > 0,
          `cap should have degraded somebody at ${target} avatars, got ${JSON.stringify(tiers)}`);
      }
      if (RENDER_LOD === 'full') {
        assert.ok(tiers.near > 0, `control arm should report NEAR avatars, got ${JSON.stringify(tiers)}`);
        assert.ok(!tiers.mid && !tiers.far,
          `control arm must not degrade anyone, got ${JSON.stringify(tiers)}`);
      }
      const s = await sampleFrame(ctx, c, SAMPLE_MS);
      rows.push({ n: target, ...s, puppets: pups });
      ctx.log(`  ${String(target).padStart(2)} avatars: ${s.fps} fps, frame ${s.frameMs}ms `
        + `(worst ${s.worstFrameMs}ms), puppets spawned ${pups}, host load ${s.load}`);
      assert.ok(pups >= target * 0.75,
        `client only spawned ${pups} puppets for ${target} remote players — it is not rendering the crowd, `
        + 'so the frame numbers above describe an empty scene');
      assert.equal(await c.eval('(window.__omwMP||{}).state'), 'Joined',
        `client fell out of Joined at ${target} avatars`);
    }
  } finally {
    for (const w of waves) w.kill('SIGTERM');
  }

  ctx.log('avatars | fps | frame ms | worst ms | puppets | host load');
  for (const r of rows) {
    ctx.log(`  ${String(r.n).padStart(3)} | ${String(r.fps).padStart(3)} | ${String(r.frameMs).padStart(8)}`
      + ` | ${String(r.worstFrameMs).padStart(8)} | ${String(r.puppets).padStart(7)} | ${r.load}`);
  }

  // The only hard gate: the client survived the maximum crowd still connected and still
  // rendering it. Frame cost is reported for the capacity docs to quote, not asserted.
  const last = rows[rows.length - 1];
  assert.ok(last.fps > 0, 'client stopped rendering entirely under load');
}
