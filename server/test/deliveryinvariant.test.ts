// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// EVERY EVENT THE SERVER SENDS HAS SOMEWHERE TO LAND. The engine hands every server event to Lua
// as a GLOBAL event named MP_<name> (openmw/apps/openmw/mwmp/netmanager.cpp: addGlobalEvent), and
// the global script's event table is global.lua's own handlers plus those of the modules it
// merges in (`for name, fn in pairs(<module>.handlers)`). An event with no handler there is
// dropped without a word -- which is how SelfSkillUse shipped: the server sent it, player.lua
// counted it, each half had a test, and nothing connected them (armour and block never
// progressed). The other direction (a player.lua handler nothing forwards) is asserted in
// wasm-build/lua-tests/run.lua.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MP = join(ROOT, 'openmw', 'files', 'data', 'scripts', 'mp');
// The server image runs this suite without the engine tree (Dockerfile.simpeer's test stage).
const skip = existsSync(join(MP, 'global.lua')) ? false : 'no openmw/ tree here (the server image)';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

export function serverSentEvents(): Map<string, string> {
  const sent = new Map<string, string>();
  for (const f of tsFiles(join(ROOT, 'server', 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\.sendEvent\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      if (!sent.has(m[1]!)) sent.set(m[1]!, f);
    }
  }
  return sent;
}

export function globalHandlers(): Set<string> {
  const g = readFileSync(join(MP, 'global.lua'), 'utf8');
  const requires = new Map<string, string>();
  for (const m of g.matchAll(/local (\w+) = require\('scripts\.mp\.(\w+)'\)/g)) requires.set(m[1]!, m[2]!);
  const merged = [...g.matchAll(/for name, fn in pairs\((\w+)\.handlers\) do/g)].map((m) => requires.get(m[1]!));
  const sources = [g, ...merged.filter((x): x is string => !!x).map((mod) => readFileSync(join(MP, mod + '.lua'), 'utf8'))];
  const names = new Set<string>();
  for (const src of sources) for (const m of src.matchAll(/\b(MP_[A-Za-z0-9_]+)\s*=\s*function/g)) names.add(m[1]!);
  return names;
}

test('every event the server sends is handled in the global context (global.lua or a module it merges)', { skip }, () => {
  const sent = serverSentEvents();
  const handled = globalHandlers();
  assert.ok(sent.size > 40 && handled.size > 40, `the scan found too little to mean anything (${sent.size} sent, ${handled.size} handled)`);
  const missing = [...sent].filter(([name]) => !handled.has('MP_' + name)).map(([name, f]) => `${name} (${f})`);
  assert.deepEqual(missing, [], 'server events that land nowhere: ' + missing.join(', '));
});

test('the scan would catch the SelfSkillUse gap (negative control)', { skip }, () => {
  const handled = globalHandlers();
  assert.ok(handled.has('MP_SelfSkillUse'), 'the forward is present today');
  const without = new Set([...handled].filter((n) => n !== 'MP_SelfSkillUse'));
  assert.ok(serverSentEvents().has('SelfSkillUse') && !without.has('MP_SelfSkillUse'),
    'removing the global forward leaves a sent event with no handler -- the case this test exists for');
});
