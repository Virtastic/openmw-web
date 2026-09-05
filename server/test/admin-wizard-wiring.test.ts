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

// --- the save that moves the front door ----------------------------------------------------
//
// Choosing internal hosting rewrites the proxy to plain HTTP, and Caddy applies it within
// seconds — so the https origin the wizard is running on stops answering. Polling it for the
// restart, which is what every other save does, would sit on the loading sheet forever.

test('finishing the wizard hands over to the origin the hosting answer creates', () => {
  // Both directions: internal moves the proxy to plain HTTP on the chosen port, public moves
  // it to HTTPS. Either way the origin the wizard is running on can stop answering, so the
  // destination is computed from the answer rather than assumed.
  assert.ok(app.includes("const dest = answers.hosting === 'internal'"),
    'the review save must consider that its own origin is about to die');
  assert.ok(app.includes('location.href = `${dest}/admin#restarting`;'),
    'the operator must be sent to the address that will answer');
  assert.ok(app.includes('`https://${answers.domain || location.hostname}`'),
    'public hosting must aim at the domain when one was given');
  // Only when the origin actually changes: saving internal from http://localhost stays put.
  assert.ok(app.includes('if (dest !== location.origin) {'));
});

test('the new origin shows the restart sheet, not a sign-in form that errors', () => {
  // The redirected page arrives mid-restart. Booting normally would paint a login form whose
  // every attempt fails until the server is back, which reads as broken; #restarting routes
  // it into the same waiting sheet the old page would have shown.
  assert.ok(app.includes("if (location.hash === '#restarting') {"));
  const boot = app.slice(app.indexOf("if (location.hash === '#restarting') {"));
  assert.ok(boot.includes('waitForRestart();'));
  assert.ok(boot.includes("history.replaceState(null, '', location.pathname);"),
    'the fragment must not survive into bookmarks and reloads');
});

// --- the questions that are gone, and the one that is no longer gated ---------------------

test('the delivery question is gone from the wizard, not merely gated', () => {
  // The server always supplies the game files; per-player cloud copies belong to the game
  // launcher. A greyed tile would still be a question, so there is no tile at all.
  assert.doesNotMatch(app, /stepDelivery/, 'the delivery step must not exist');
  assert.doesNotMatch(app, /playerUploads/, 'no trace of the removed flag in the page');
  assert.doesNotMatch(app, /'delivery',/, 'no delivery entry in the step list');
  // The answer still travels, as the one constant value the server also forces.
  assert.match(app, /deliveryModel: 'serve'/);
});

test('the server forces serve, whatever the page did', () => {
  const routes = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'routes.ts'), 'utf8');
  const handler = /if \(method === 'POST' && path === '\/admin\/api\/setup'\) \{[\s\S]*?\n    \}/.exec(routes)!;
  // The endpoint is reachable without the page, so the missing question is enforced here.
  assert.match(handler[0], /body\.deliveryModel = 'serve';/);
  assert.doesNotMatch(handler[0], /playerUploads/);
});

test('the dashboard offers no delivery control either', () => {
  // Removing the wizard question and leaving a settings toggle would be the same option with
  // worse framing. Old configs saying verify are still honoured at runtime.
  const api = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'api-settings.ts'), 'utf8');
  assert.ok(api.includes("'setup.deliveryModel',"), 'the field must be in the not-offered list');
  const help = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'help.ts'), 'utf8');
  assert.doesNotMatch(help, /setup\.deliveryModel/, 'no help for a control that does not exist');
});

test('multiplayer is offered without any environment flag', () => {
  // It was gated behind OMW_EXPERIMENTAL while it was half-finished. It is finished; a wizard
  // that greys the tile and a route that refuses the answer would leave the operator unable
  // to set up the one thing the multiplayer server exists for.
  assert.doesNotMatch(app, /OMW_EXPERIMENTAL|expLock|GATED_ANSWERS|state\.experimental/);
  assert.doesNotMatch(app, /Multiplayer \(experimental\)/);
  const routes = readFileSync(join(process.cwd(), 'src', 'net', 'admin', 'routes.ts'), 'utf8');
  assert.doesNotMatch(routes, /experimental/i);
});
