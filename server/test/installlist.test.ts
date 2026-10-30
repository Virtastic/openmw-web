// OT3-152: the peer image installs only the scripts named in openmw/files/data/CMakeLists.txt,
// while mp-harness.mjs bind-mounts the repo scripts over the image -- so a script missing from
// that list passes the sweep and breaks production. Fail here, on a laptop, instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA = resolve(import.meta.dirname, '../../openmw/files/data');
const have = existsSync(join(DATA, 'CMakeLists.txt'));
const opts = have ? {} : { skip: 'openmw/ is not part of the server image' };
const cmake = have ? readFileSync(join(DATA, 'CMakeLists.txt'), 'utf8') : '';
const installed = new Set(
  cmake.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
);

test('every scripts/mp/*.lua file is in the install list', opts, () => {
  const files = readdirSync(join(DATA, 'scripts/mp')).filter((f) => f.endsWith('.lua'));
  assert.ok(files.length > 10, 'found the mp scripts');
  const missing = files.map((f) => `scripts/mp/${f}`).filter((p) => !installed.has(p));
  assert.deepEqual(missing, [], `missing from openmw/files/data/CMakeLists.txt: ${missing.join(', ')}`);
});

test('every script mp.omwscripts attaches, and the content files, are in the install list', opts, () => {
  const lines = readFileSync(join(DATA, 'mp.omwscripts'), 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const paths = lines.map((l) => l.replace(/^[A-Z_,]+:\s*/, ''));
  assert.ok(paths.length >= 5);
  for (const p of [...paths, 'mp.omwscripts', 'builtin.omwscripts']) {
    assert.ok(installed.has(p), `${p} is not in the install list`);
  }
});
