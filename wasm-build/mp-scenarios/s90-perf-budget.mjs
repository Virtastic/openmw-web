// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s90 (perf): record the boot timeline, the frame-phase split and the GL call count on a fixed
// route, and fail if they regress against a checked-in baseline.
//
// WHY THIS EXISTS. Every other gate in this repo asserts on CORRECTNESS -- smoke-test.sh on the
// serving contract, verify-mp-hardening.sh on the auth ladder, the scenarios on behaviour. Nothing
// asserted on performance, and most of the OpenTES3 work is changes whose entire value is a number:
// the ICU filter is a build input someone will regenerate, the brotli quality is a variable, the
// SIMD flag lives in a script that gets edited. Without a gate, that work is done once and quietly
// lost the next time somebody tidies a build file.
//
// WHAT IT MEASURES, and why these four:
//   __omwBoot      time-to-playable. The number a browser game is actually judged on.
//   __omwPhase     the cull/draw/rest split, which is what says WHERE a frame went. Needs
//                  ?perfstats=1 (OPENMW_PERF_STATS); the F3 stats HUD is not used because it
//                  costs ~5ms itself and pollutes the thing it is measuring.
//   __glPerFrame   GL calls per frame. THE metric for this build -- the profiling note that
//                  drove the object-paging merge factor reads "~1770 drawables, Draw 5-7ms",
//                  and draw submission is JS<->wasm<->ANGLE crossings. Needs ?glcount=1.
//   __streamfsStats  BSA range-read misses and the main-thread stall they cost.
//
// RATIOS, NOT MILLISECONDS. Frame timings on shared CI hardware under SwiftShader are not
// comparable to a laptop with a GPU, and a fixed threshold there is a flake generator -- a lesson
// this repo already paid for once (see the s57 budget, which was changed to measure against the
// machine it runs on rather than a constant). So: gate GL CALL COUNTS and BOOT PHASE RATIOS, which
// are properties of the build, and only WARN on wall-clock, which is a property of the machine.
// Artifact sizes are the exception -- those are deterministic and asserted exactly, elsewhere.
//
// FIRST RUN writes the baseline instead of failing, so this is not a chicken-and-egg problem.
// Re-baseline deliberately with OMW_PERF_REBASELINE=1 and say why in the commit.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, 'perf-baseline.json');

// Allowed regression before failing. GL calls are deterministic for a fixed route, so this is
// tight; it exists to absorb ordering jitter in what the culler admits, not real growth.
const GL_TOLERANCE = 1.10;   // +10% GL calls per frame
const BOOT_TOLERANCE = 1.25; // +25% on boot phase ratios (noisier: download and disk cache vary)

// The route. Deliberately dull and fully scripted -- a perf gate that wanders is a perf gate that
// flaps. Balmora because it is the densest ordinary exterior in the base game and the place the
// draw-submission cost was originally measured.
const ROUTE = [
  ['walk:0,1,1200', 1500],   // forward down the street
  ['cam:3p', 400],           // third person: adds the player's own rig to the skinning load
  ['walk:1,0,900', 1200],    // strafe past the shopfronts
  ['walk:0,1,1200', 1500],   // further in, crossing a cell boundary
  ['cam:1p', 400],
];

export default async function run(ctx) {
  // extraParams is appended raw to an already-started query string (mp-harness.mjs:364), so it
  // leads with '&'. resetcfg=1 matters more than it looks: the settings.cfg index.html writes is
  // only a DEFAULTS layer, and a profile that has already run keeps its own copy in IDBFS -- so
  // without it a settings change under test may never be applied and the run measures stale values.
  const c = await ctx.launchClient('perf', '&perfstats=1&glcount=1&resetcfg=1');


  const boot = JSON.parse(await c.eval('JSON.stringify(window.__omwBoot||{})'));
  ctx.log('boot timeline (ms from navigation start):', JSON.stringify(boot));
  assert.ok(boot.firstFrame > 0, 'no firstFrame mark -- engine never rendered, or F24 is missing');

  // Walk the route, sampling once per leg so a single unlucky frame cannot decide the verdict.
  const glSamples = [];
  const phaseSamples = [];
  for (const [cmd, settle] of ROUTE) {
    await c.eval(`window.omw.send(${JSON.stringify(cmd)})`);
    await ctx.sleep(settle);
    const gl = JSON.parse(await c.eval('JSON.stringify(window.__glPerFrame||null)'));
    const ph = JSON.parse(await c.eval('JSON.stringify(window.__omwPhase||null)'));
    if (gl) glSamples.push(gl);
    if (ph) phaseSamples.push(ph);
  }
  assert.ok(glSamples.length, 'no __glPerFrame samples -- ?glcount=1 did not arm');

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const measured = {
    glTotal: median(glSamples.map((g) => g.total)),
    glDraw: median(glSamples.map((g) => g.draw)),
    // Boot as a RATIO of total boot, so a slow download on CI does not read as an engine
    // regression: what we care about is the share spent after the runtime is up.
    bootPostRuntimeShare: boot.firstFrame > 0
      ? +((boot.firstFrame - (boot.runtimeInit || 0)) / boot.firstFrame).toFixed(3)
      : 0,
  };
  const wallclock = {
    bootFirstFrameMs: boot.firstFrame,
    frameMs: await c.eval('window.__frameMs||0'),
    phase: phaseSamples[phaseSamples.length - 1] || null,
    streamfs: JSON.parse(await c.eval('JSON.stringify(window.__streamfsStats||null)')),
  };
  ctx.log('measured (gated):', JSON.stringify(measured));
  ctx.log('wallclock (informational, machine-dependent):', JSON.stringify(wallclock));

  const hadBaseline = existsSync(BASELINE);
  if (!hadBaseline || process.env.OMW_PERF_REBASELINE) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(measured, null, 2) + '\n');
    ctx.log(hadBaseline ? 'baseline REWRITTEN (OMW_PERF_REBASELINE)' : 'baseline written (first run)');
    return;
  }

  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const fail = [];
  const check = (key, tol) => {
    const b = base[key], m = measured[key];
    if (!b) return;                       // new key: nothing to compare against yet
    if (m > b * tol) fail.push(`${key}: ${m} vs baseline ${b} (max ${(b * tol).toFixed(1)})`);
    ctx.log(`  ${key}: ${m} vs ${b} ${m > b * tol ? 'REGRESSED' : 'ok'}`);
  };
  check('glTotal', GL_TOLERANCE);
  check('glDraw', GL_TOLERANCE);
  check('bootPostRuntimeShare', BOOT_TOLERANCE);

  assert.equal(fail.length, 0,
    'performance regressed against wasm-build/mp-scenarios/perf-baseline.json:\n  ' + fail.join('\n  ')
    + '\nIf the regression is intended, re-run with OMW_PERF_REBASELINE=1 and say why in the commit.');
}
