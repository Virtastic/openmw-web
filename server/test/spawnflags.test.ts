// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE FLAGS THE GATEWAY PASSES MUST BE ACCEPTED BY EVERY ENTRY POINT IT CAN SPAWN.
//
// node:util parseArgs THROWS on an unknown option. testhost.mjs did not declare --shared, so
// every world the harness's gateway spawned died instantly with
// ERR_PARSE_ARGS_UNKNOWN_OPTION, backed off, and died again — forever. The world list stayed
// permanently empty and every gateway scenario failed on an unrelated downstream assertion,
// because the gateway itself came up healthy and its output was discarded.
//
// A contract between two files that nothing checked. This checks it: the argv built in
// worlds.ts is compared against the parseArgs options of both entry points.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Long-form flags in the spawn argv (worlds.ts builds `const args = [...]`). */
function flagsPassedToWorlds(): string[] {
  const src = read('gateway/worlds.ts');
  const i = src.indexOf('const args = [');
  assert.ok(i > 0, 'could not find the spawn argv in gateway/worlds.ts');
  const chunk = src.slice(i, src.indexOf('];', i));
  return [...new Set([...chunk.matchAll(/'--([a-z-]+)'/g)].map((m) => m[1]!))];
}

/** Option names declared in a parseArgs({ options: { ... } }) block. */
function optionsAccepted(file: string): Set<string> {
  const src = read(file);
  const i = src.indexOf('options: {');
  assert.ok(i > 0, `no parseArgs options block in ${file}`);
  const chunk = src.slice(i, src.indexOf('},\n});', i));
  const names = new Set<string>();
  for (const m of chunk.matchAll(/(?:^|\s|')([a-z][a-z-]*)'?\s*:\s*\{\s*type:/gm)) names.add(m[1]!);
  return names;
}

test('every entry point the gateway can spawn accepts the flags it passes', () => {
  const passed = flagsPassedToWorlds();
  assert.ok(passed.includes('shared'), 'expected --shared among the spawn flags');
  assert.ok(passed.includes('gateway'), 'expected --gateway among the spawn flags');

  // Both are valid --server-entry targets: main.mjs in production, testhost.mjs in the harness.
  for (const entry of ['main.ts', 'testhost.ts']) {
    const accepted = optionsAccepted(entry);
    const missing = passed.filter((f) => !accepted.has(f));
    assert.deepEqual(missing, [],
      `${entry} does not declare ${missing.join(', ')} — parseArgs THROWS on an unknown `
      + 'option, so every world the gateway spawns would exit immediately and retry forever');
  }
});
