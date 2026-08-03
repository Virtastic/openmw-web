// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Social UX: whisper — a directed line to one recipient chosen from the friend dropdown
// (client sends channel:'whisper', to:<accountKey>). Delivered to that peer + echoed to the
// sender; a recipient's mute silently drops their copy but the sender still sees their echo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

async function two(t: { after(fn: () => unknown): void }) {
  const server = await startServer({ requireGameData: false,
    dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const a = await TestClient.connect(server.port);
  await a.joinAsNew('Alice');
  await a.waitEvent('PlayerList');
  const b = await TestClient.connect(server.port);
  await b.joinAsNew('Bob');
  await b.waitEvent('PlayerList');
  return { server, a, b };
}

const whispers = (c: TestClient) =>
  c.inbox.events.filter((e) => e.name === 'ChatMessage' && (e.value as { channel?: string }).channel === 'whisper');

test('whisper reaches only the target, and echoes to the sender with the recipient name', async (t) => {
  const { a, b } = await two(t);
  a.sendEvent('ChatSend', { text: 'meet me in Balmora', channel: 'whisper', to: 'bob' });

  const heard = await b.waitEvent('ChatMessage',
    (v) => (v as { channel?: string }).channel === 'whisper');
  assert.equal((heard.value as { text: string }).text, 'meet me in Balmora');
  assert.equal((heard.value as { from: string }).from, 'Alice');
  assert.equal((heard.value as { to?: string }).to, undefined, "recipient's copy carries no 'to'");

  // Sender's echo: same channel, but tagged with the recipient's display name.
  const echo = await a.waitEvent('ChatMessage',
    (v) => (v as { channel?: string; to?: string }).channel === 'whisper'
      && (v as { to?: string }).to === 'Bob');
  assert.equal((echo.value as { text: string }).text, 'meet me in Balmora');
  a.close();
  b.close();
});

test('a muted sender is dropped for the recipient but still echoes to the sender', async (t) => {
  const { a, b } = await two(t);
  b.sendEvent('MuteAdd', { acct: 'alice' });
  await b.waitEvent('SocialResult', (v) => (v as { op?: string }).op === 'MuteAdd');

  a.sendEvent('ChatSend', { text: 'are you there', channel: 'whisper', to: 'bob' });
  // The sender always gets their echo — that's how we prove the muted delivery, not silence.
  await a.waitEvent('ChatMessage',
    (v) => (v as { channel?: string; to?: string }).channel === 'whisper' && (v as { to?: string }).to === 'Bob');
  // Give any (erroneous) delivery a beat to land, then assert Bob heard nothing.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(whispers(b).length, 0, 'a muted recipient must not receive the whisper');
  a.close();
  b.close();
});

test('whispering nobody / yourself is refused with a helpful server line', async (t) => {
  const { a } = await two(t);
  a.sendEvent('ChatSend', { text: 'hello?', channel: 'whisper', to: '' });
  await a.waitEvent('ChatMessage',
    (v) => (v as { channel?: string }).channel === 'server'
      && /pick someone/i.test(String((v as { text?: string }).text ?? '')));
  a.close();
});

test('whispering an offline / absent account says so instead of vanishing', async (t) => {
  const { a } = await two(t);
  a.sendEvent('ChatSend', { text: 'you around?', channel: 'whisper', to: 'ghost' });
  await a.waitEvent('ChatMessage',
    (v) => (v as { channel?: string }).channel === 'server'
      && /not reachable/i.test(String((v as { text?: string }).text ?? '')));
  a.close();
});
