// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Every wizard step has a handler to render it.
//
// app.js is browser JavaScript, so tsc never sees it and `node --check` only proves it
// parses. A step whose function does not exist is a RUNTIME error: the wizard renders fine
// until somebody presses Continue onto that step, and then throws "stepRegistration is not
// defined" with the page stuck. That is exactly what shipped when a slice deleting one dead
// step took a live one out with it, and nothing in the suite noticed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');

/** Is `name` defined in app.js, as a function or a const arrow? */
function isDefined(name: string): boolean {
  return app.includes(`function ${name}(`)
    || app.includes(`const ${name} = `)
    || app.includes(`async function ${name}(`);
}

test('every step the wizard can route to has a function defined', () => {
  const list = /const wizardSteps = \(\) => \{[\s\S]*?\n\};/.exec(app);
  assert.ok(list, 'wizardSteps not found; this test needs updating alongside it');
  const steps = [...list[0].matchAll(/^\s+'([a-z]+)',?$/gm)].map((m) => m[1]!);
  assert.ok(steps.length >= 8, `expected the full step list, got ${steps.join(', ')}`);

  const missing = steps
    .map((s) => `step${s[0]!.toUpperCase()}${s.slice(1)}`)
    .filter((fn) => !isDefined(fn));
  assert.deepEqual(missing, [], 'reaching these steps would throw');
});

test('every handler the router dispatches to is defined', () => {
  // The other direction: renderWizard names handlers explicitly, and one of those going
  // missing is the same failure approached from the other end.
  const called = [...app.matchAll(/if \(name === '[a-z]+'\) return (step[A-Za-z]+)\(\);/g)]
    .map((m) => m[1]!);
  assert.ok(called.length >= 8, `expected the dispatch list, got ${called.length}`);
  assert.deepEqual(called.filter((fn) => !isDefined(fn)), [], 'called but not defined');
});

test('the step rail has a label for every step', () => {
  // A missing label renders the raw key ("registration" instead of "Sign-ups"), which is not
  // a crash but is the same drift showing up in the operator's face.
  const list = /const wizardSteps = \(\) => \{[\s\S]*?\n\};/.exec(app)!;
  const steps = [...list[0].matchAll(/^\s+'([a-z]+)',?$/gm)].map((m) => m[1]!);
  const labels = /const STEP_LABEL = \{[\s\S]*?\n\};/.exec(app);
  assert.ok(labels, 'STEP_LABEL not found');
  assert.deepEqual(steps.filter((s) => !new RegExp(`\\b${s}:`).test(labels[0])), []);
});
