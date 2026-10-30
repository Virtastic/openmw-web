// OT3-137: one handle length limit. The in-game field allowed 24 while the server and the
// launcher allow 20, so a valid-looking entry failed after submit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HANDLE_MAX } from '../src/core/accounts';

const play = join(import.meta.dirname, '..', '..', 'play');
const opts = existsSync(join(play, 'index.html')) ? {} : { skip: 'play/ is not part of the server image' };

test('the handle field limit is the server limit in both front-door forms', opts, () => {
  const game = readFileSync(join(play, 'index.html'), 'utf8');
  const launcher = readFileSync(join(play, 'launcher.html'), 'utf8');
  const g = /id="omw-uname-in" maxlength="(\d+)"/.exec(game);
  const l = /id="ob-username"[^>]*maxlength="(\d+)"/.exec(launcher);
  assert.equal(Number(g?.[1]), HANDLE_MAX);
  assert.equal(Number(l?.[1]), HANDLE_MAX);
  assert.ok(game.includes('v.length > ' + HANDLE_MAX), 'in-game form rejects an over-long handle before submit');
});
