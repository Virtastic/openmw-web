// The Updates card offers a release only when it is NEWER than what runs. It compared for
// difference, so a server on a hotfix ahead of the newest GitHub release (1.6.8 against 1.6.6)
// was told "v1.6.6 is out" with no way to act on it (prod 2026-10-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNewerVersion } from '../src/net/admin/routes';

test('a release is newer only field by field, never by being different', () => {
  assert.equal(isNewerVersion('1.6.6', '1.6.8'), false, 'an older release is not an update');
  assert.equal(isNewerVersion('1.6.8', '1.6.8'), false);
  assert.equal(isNewerVersion('1.6.9', '1.6.8'), true);
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true, 'numeric, not string, order');
  assert.equal(isNewerVersion('v1.7.0', '1.6.8'), true, 'a leading v is allowed');
  assert.equal(isNewerVersion('', '1.6.8'), false, 'no release found is not an update');
});

test('the game-client card compares tags the same way', () => {
  const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');
  assert.match(app, /e\.tag && !tagNewer\(latestTag, e\.tag\)/);
});
