// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-103: "/me" action lines and canned emotes, seen only by players in range.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmote } from '../src/core/chat';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

test('parseEmote: /me, canned emotes, plain slash lines', () => {
  assert.deepEqual(parseEmote('/me waves hello'), { text: 'waves hello' });
  assert.deepEqual(parseEmote('/ME  grins  '), { text: 'grins' });
  assert.deepEqual(parseEmote('/me'), { empty: true });
  assert.deepEqual(parseEmote('/wave'), { text: 'waves.', anim: 'idle2' });
  assert.equal(parseEmote('/constructor'), undefined, 'prototype keys are not emotes');
  assert.equal(parseEmote('/unknown x'), undefined);
  assert.equal(parseEmote('hello /me'), undefined);
});

test('/me reaches players in range as an action line and not players far away', async (t) => {
  const server = await startServer({ requireGameData: false, dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } } });
  t.after(() => server.close());
  const mk = async (name: string, cell: string) => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange(cell, 0, 0, 0);
    return c;
  };
  const a = await mk('Alice', '5,5');
  const b = await mk('Bob', '5,5');
  const far = await mk('Far', '40,40');
  a.sendEvent('ChatSend', { text: '/me waves at the guard' });
  const got = await b.waitEvent('ChatMessage', (v) => (v as { emote?: boolean }).emote === true);
  assert.equal((got.value as { text: string }).text, 'waves at the guard');
  assert.equal((got.value as { from: string }).from, 'Alice');
  a.sendEvent('ChatSend', { text: '/wave' });
  const w = await b.waitEvent('ChatMessage', (v) => (v as { anim?: string }).anim === 'idle2');
  assert.equal((w.value as { text: string }).text, 'waves.');
  a.sendEvent('ChatSend', { text: 'marker' });
  await far.waitEvent('ChatMessage', (v) => (v as { text?: string }).text === 'marker');
  assert.equal(far.inbox.events.filter((e) => (e.value as { emote?: boolean }).emote === true).length, 0);
  a.close(); b.close(); far.close();
});
