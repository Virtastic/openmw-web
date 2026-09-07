// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The log module's two production properties: it must not write credentials down, and it must
// not pay a syscall per line to find out how big it has got.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, enableFileLog, recentLogs } from '../src/log';

// EVERY SINK HERE IS DURABLE. The file outlives the crash it was written to explain, the ring
// is served to anyone holding the dashboard's log view, and stdout is whatever the host's
// collector keeps forever. A credential that reaches log() has not been briefly visible — it
// has been published to three places, and rotating it is the only way back.
test('secret-looking fields are never written down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-log-'));
  enableFileLog(dir);

  log('info', 'test.secrets', {
    account: 'ada',                       // ordinary, must survive
    password: 'hunter2',
    serverToken: 'tok_live_abc123',
    smtpPass: 'mail-pw',
    webhookUrl: 'https://hooks.example.com/T/B/XYZ',
    apiKey: 'ak_live_9',
    authorization: 'Bearer eyJ',
    accessKeyId: 'AKIA...',
    cookie: 'sid=abc',
  });

  const line = readFileSync(join(dir, 'logs', 'server.log'), 'utf8');
  for (const leaked of ['hunter2', 'tok_live_abc123', 'mail-pw', 'T/B/XYZ', 'ak_live_9',
    'eyJ', 'AKIA', 'sid=abc']) {
    assert.ok(!line.includes(leaked), `a credential reached the log file: ${leaked}`);
  }
  assert.ok(line.includes('ada'), 'ordinary fields must still be logged — this is not a blanket mask');
  assert.ok(line.includes('[redacted]'), 'and the masking must be visible, not a silent drop');

  // The ring the dashboard serves is the same entry object, so it must be masked too — a
  // viewer role can read that view.
  const ring = recentLogs(20).find((e) => e.event === 'test.secrets');
  assert.ok(ring, 'the entry must reach the ring');
  assert.equal(ring.password, '[redacted]');
  assert.equal(ring.account, 'ada');
});

// An EMPTY credential is not a credential, and masking it would tell an operator their token is
// set when it is not — the opposite of what a log is for.
test('an empty secret field is left alone, so absence still looks like absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-log-'));
  enableFileLog(dir);
  log('info', 'test.empty', { serverToken: '', smtpPass: undefined });
  const line = readFileSync(join(dir, 'logs', 'server.log'), 'utf8');
  assert.ok(!line.includes('[redacted]'),
    'an unset credential must read as unset, not as one being hidden');
});

// rotateIfBig() ran statSync() before EVERY append: one extra syscall per line, on a path a
// busy server walks thousands of times a minute, to learn something this process is the only
// writer of. The counter replaces it — and still has to rotate at the right size.
test('the file rotates on size without measuring itself every line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omw-log-'));
  enableFileLog(dir);
  const path = join(dir, 'logs', 'server.log');
  // MAX_BYTES is 8 MB; a kilobyte of padding per line reaches it without a huge test.
  const pad = 'x'.repeat(1024);
  for (let i = 0; i < 9000; i++) log('info', 'test.bulk', { i, pad });

  assert.ok(existsSync(`${path}.1`), 'the file must have rotated at all');
  assert.ok(statSync(path).size < 9 * 1024 * 1024,
    `the live file must stay near its cap, got ${statSync(path).size} bytes`);
  // And it kept working after the rotation, which is the failure that would matter.
  log('info', 'test.after_rotate', { ok: true });
  assert.ok(readFileSync(path, 'utf8').includes('test.after_rotate'),
    'logging must continue after a rotation');
});
