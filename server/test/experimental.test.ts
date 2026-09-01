// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which wizard answers a fresh server is allowed to offer.
//
// One of them: multiplayer. It is SHOWN AND DISABLED rather than hidden: an operator who
// came here for multiplayer and finds no mention of it concludes they downloaded the wrong
// software, where a greyed tile naming the variable that turns it on answers the question
// they actually have.
//
// The delivery question (and its playerUploads flag) is gone entirely: the server always
// supplies the game files, and per-player cloud copies are the game launcher's own feature.
// Half of this file now pins that it STAYS gone from the operator surfaces.
//
// The greying is not the gate, though. The wizard restores its answers from the browser and
// the endpoint is reachable without the page, so the refusal has to live on the server; these
// tests are mostly about that half.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXPERIMENTS, EXPERIMENTAL_ENV, experimental, parseExperimental } from '../src/core/experimental';

/** Set the variable for one case and put it back, whatever the case does. */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const had = process.env[EXPERIMENTAL_ENV];
  if (value === undefined) delete process.env[EXPERIMENTAL_ENV];
  else process.env[EXPERIMENTAL_ENV] = value;
  try { return fn(); } finally {
    if (had === undefined) delete process.env[EXPERIMENTAL_ENV];
    else process.env[EXPERIMENTAL_ENV] = had;
  }
}

test('nothing is enabled by default, which is the whole point', () => {
  withEnv(undefined, () => {
    const on = experimental();
    for (const name of EXPERIMENTS) assert.equal(on[name], false, `${name} must be off by default`);
  });
  withEnv('', () => assert.equal(experimental().multiplayer, false));
});

test('one name enables one feature', () => {
  withEnv('multiplayer', () => {
    assert.deepEqual(experimental(), { multiplayer: true });
  });
  withEnv('all', () => {
    for (const name of EXPERIMENTS) assert.equal(experimental()[name], true);
  });
});

test('it is forgiving about how the name is typed, and about names it does not know', () => {
  // A typo must not stop the server booting, and a flag from a newer version arriving in an
  // older one is not an error either.
  for (const spelling of ['multiplayer', 'MULTIPLAYER', 'multi_player', 'multi-player', ' multiplayer ']) {
    assert.equal(parseExperimental(spelling).has('multiplayer'), true, `rejected: ${spelling}`);
  }
  assert.deepEqual([...parseExperimental('nonsense,multiplayer')], ['multiplayer']);
  assert.equal(parseExperimental('nonsense').size, 0);
});

// --- the wizard's half --------------------------------------------------------------------

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');

test('the locked tile is rendered, not dropped', () => {
  // Hiding the feature would be the easy version and the wrong one: the wizard would read as
  // though multiplayer does not exist.
  const fn = /function choice\(name, value, title, blurb[\s\S]*?\n\}/.exec(app)!;
  assert.match(fn[0], /lock \? 'vt-locked' : ''/);
  assert.match(fn[0], /disabled aria-disabled="true"/);
  assert.match(fn[0], /badge text-bg-secondary ms-1">Experimental/);
  // And it must say what to do about it, not merely that it cannot be clicked.
  assert.ok(app.includes('function expLock(flag, what)'));
  assert.match(app, /Set \$\{env\}=\$\{flag\} in the /);
});

test('a state that never loaded reads as locked, not as available', () => {
  // Guessing "available" would offer an answer the save then refuses, which is the one
  // outcome worse than not offering it.
  const fn = /function expLock\(flag, what\)[\s\S]*?\n\}/.exec(app)!;
  assert.match(fn[0], /if \(state\.experimental\?\.\[flag\]\) return '';/);
});

test('the delivery question is gone from the wizard, not merely gated', () => {
  // The server always supplies the game files; per-player cloud copies belong to the game
  // launcher. A greyed tile would still be a question, so there is no tile at all.
  assert.match(app, /expLock\('multiplayer', 'Multiplayer'\)/);
  assert.doesNotMatch(app, /stepDelivery/, 'the delivery step must not exist');
  assert.doesNotMatch(app, /playerUploads/, 'no trace of the removed flag in the page');
  assert.doesNotMatch(app, /'delivery',/, 'no delivery entry in the step list');
  // The answer still travels, as the one constant value the server also forces.
  assert.match(app, /deliveryModel: 'serve'/);
});

test('an answer restored from the browser is dropped when its flag is off', () => {
  // The wizard saves to localStorage, so a run begun while a feature was enabled can be
  // finished after it was turned off. Without this the operator carries a selected tile all
  // the way to a save that rejects it.
  assert.match(app, /const GATED_ANSWERS = \[/);
  const fn = /function renderWizard\(\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(fn[0], /for \(const \[key, value, flag\] of GATED_ANSWERS\)/);
  assert.match(fn[0], /!state\.experimental\?\.\[flag\]/);
  assert.match(fn[0], /answers\[key\] = null;/);
});

test('the server refuses a gated answer and forces serve, whatever the page did', () => {
  const routes = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'routes.ts'), 'utf8');
  const handler = /if \(method === 'POST' && path === '\/admin\/api\/setup'\) \{[\s\S]*?\n    \}/.exec(routes)!;
  assert.match(handler[0], /body\.deploymentMode === 'multiplayer' && !on\.multiplayer/);
  // The endpoint is reachable without the page, so the missing question is enforced here.
  assert.match(handler[0], /body\.deliveryModel = 'serve';/);
  assert.doesNotMatch(handler[0], /playerUploads/);
  // Refused BEFORE anything is written, or a rejected answer still reaches the config.
  assert.ok(handler[0].indexOf('json(res, 400,') < handler[0].indexOf('applyWizard('),
    'the check must come before applyWizard');
});

test('the dashboard offers no delivery control either', () => {
  // Removing the wizard question and leaving a settings toggle would be the same option with
  // worse framing. Old configs saying verify are still honoured at runtime.
  const api = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'api-settings.ts'), 'utf8');
  assert.ok(api.includes("'setup.deliveryModel',"), 'the field must be in the not-offered list');
  const help = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'help.ts'), 'utf8');
  assert.doesNotMatch(help, /setup\.deliveryModel/, 'no help for a control that does not exist');
});

test('the state endpoint tells the page which answers it may offer', () => {
  const routes = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'routes.ts'), 'utf8');
  assert.match(routes, /experimental: experimental\(\),/);
  // The variable's name travels with the flags, so the page never hard-codes it.
  assert.match(routes, /experimentalEnv: EXPERIMENTAL_ENV,/);
});
