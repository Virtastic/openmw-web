// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 2.5 party voice: the server relays WebRTC signaling between PARTY MEMBERS ONLY
// and never carries audio. Party scope is the access control — an SDP offer you can send
// to a stranger is how a voice feature becomes a way to force a connection on someone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';

async function trio(t: { after(fn: () => unknown): void }) {
  const server = await startServer({
    dataDir: tmpDataDir(), port: 0, host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 16 } },
  });
  t.after(() => server.close());
  const mk = async (name: string) => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew(name);
    await c.waitEvent('PlayerList');
    c.sendCellChange('0,0', 0, 0, 0);
    return c;
  };
  return { server, a: await mk('Alice'), b: await mk('Bob'), c: await mk('Carol') };
}

test('voice signaling is relayed inside a party and refused outside it', async (t) => {
  const { a, b, c } = await trio(t);

  // No party yet: even a well-formed offer goes nowhere.
  a.sendEvent('VoiceSignal', { acct: 'bob', kind: 'offer', payload: 'sdp-1' });
  const refused = await a.waitEvent('SocialResult', (v) => (v as { op: string }).op === 'VoiceSignal');
  assert.deepEqual(
    [(refused.value as { ok: boolean }).ok, (refused.value as { detail: string }).detail],
    [false, 'not_in_party'],
  );

  a.sendEvent('PartyInvite', { acct: 'bob' });
  await b.waitEvent('PartyInviteReceived');
  b.sendEvent('PartyAccept', { acct: 'alice' });
  await b.waitEvent('PartyUpdate');

  // In the party: the offer reaches Bob verbatim, tagged with who sent it.
  a.sendEvent('VoiceSignal', { acct: 'bob', kind: 'offer', payload: 'sdp-offer' });
  const got = await b.waitEvent('VoiceSignal');
  assert.deepEqual(got.value, {
    fromAcct: 'alice', fromName: 'Alice', kind: 'offer', payload: 'sdp-offer',
  });

  // Carol is not in the party and must receive nothing, ever.
  a.sendEvent('VoiceSignal', { acct: 'carol', kind: 'offer', payload: 'sdp-2' });
  await a.waitEvent('SocialResult', (v) => (v as { detail: string }).detail === 'not_in_party');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.inbox.events.filter((e) => e.name === 'VoiceSignal').length, 0,
    'a stranger must never be offered a peer connection');
  a.close();
  b.close();
  c.close();
});

test('a muted member is never offered a connection', async (t) => {
  const { a, b } = await trio(t);
  a.sendEvent('PartyInvite', { acct: 'bob' });
  await b.waitEvent('PartyInviteReceived');
  b.sendEvent('PartyAccept', { acct: 'alice' });
  await b.waitEvent('PartyUpdate');

  // Bob mutes Alice. Alice's signaling is accepted (she is not told she is muted, which
  // would just invite retaliation) but never delivered.
  b.sendEvent('MuteAdd', { acct: 'alice' });
  await b.waitEvent('SocialResult', (v) => (v as { op: string }).op === 'MuteAdd');

  a.sendEvent('VoiceSignal', { acct: 'bob', kind: 'offer', payload: 'sdp-3' });
  await a.waitEvent('SocialResult', (v) => (v as { op: string }).op === 'VoiceSignal');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.inbox.events.filter((e) => e.name === 'VoiceSignal').length, 0,
    'muting must stop the connection being offered at all, not just the audio');
  a.close();
  b.close();
});
