// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Adversarial / pressure suite: everything a hostile or broken client can throw at the
// server. The trust model (see README) accepts that a modified client can LIE about
// gameplay values. What must never happen is the server crashing, leaking sessions,
// corrupting another player's state, or wedging the event loop.
//
// The contract this suite pins down:
//   1. A malformed *frame* is a protocol violation -> that ONE session is disconnected.
//   2. Everyone else keeps playing, and the server keeps accepting new players.
//   3. State writes are attributed to the authenticated sender, never to an id in the body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/server';
import { TestClient, tmpDataDir } from './helpers';
import { packEnvelope, packEvent } from '../src/proto/envelope';
import { lserEncode, jsToL } from '../src/proto/lser';

// LSER wire tags (mirror of components/lua/serialization.cpp) — needed to hand-craft
// payloads the client-side encoder deliberately refuses to produce.
const LSER_VERSION = 0x00;
const TABLE_START = 0x03;

// After every abuse case: a brand-new client must still complete the full happy path.
// This is the assertion that actually matters — "did the abuse take the server down".
async function assertServesNewPlayers(port: number, tag: string): Promise<void> {
  const probe = await TestClient.connect(port);
  const { playerId } = await probe.joinAsNew(`probe_${tag}`);
  assert.ok(playerId > 0, `server still serves new clients after ${tag}`);
  probe.ws.close();
}

test('adversarial: malformed and hostile input', async (t) => {
  // Every bot dials from 127.0.0.1, so the per-IP connection cap (3) and the login limiter
  // (5/min) would reject the churn and multi-client cases long before the code under test
  // runs — and a starved limiter makes every later subtest fail misleadingly. Both limits
  // are covered on their own terms by ratelimit.test.ts.
  const server = await startServer({
    dataDir: tmpDataDir(),
    port: 0,
    host: '127.0.0.1',
    configOverride: { limits: { maxConnsPerIp: 200, loginPerMinPerIp: 10_000 } },
  });
  t.after(() => server.close());

  await t.test('random binary garbage kills only the offending session', async () => {
    const bystander = await TestClient.connect(server.port);
    await bystander.joinAsNew('garbage_bystander');

    const hostile = await TestClient.connect(server.port);
    await hostile.joinAsNew('garbage');
    for (let i = 0; i < 200; i++) hostile.sendRawBinary(randomBytes(1 + (i % 300)));
    await hostile.closed; // the offender is dropped, by design

    // The bystander is untouched and still fully functional.
    bystander.sendEvent('ChatSend', { text: 'bystander alive' });
    await bystander.waitEvent('ChatMessage', (v) => String((v as { text: string }).text).includes('bystander alive'), 4000);
    await assertServesNewPlayers(server.port, 'garbage');
    bystander.ws.close();
  });

  await t.test('every truncation of a valid frame is refused, never accepted', async () => {
    const CANARY = 'truncation-canary-payload';
    const valid = packEvent(1, 'ChatSend', lserEncode(jsToL({ text: CANARY })));
    // Walk every prefix of a well-formed frame — the classic decoder fuzz. Each gets its
    // own connection because a protocol violation legitimately ends the session.
    // NB: match on the canary text, not merely on ChatMessage — the MOTD arrives as a
    // ChatMessage at join and would otherwise read as "the truncated frame was processed".
    for (let n = 1; n < valid.length; n++) {
      const c = await TestClient.connect(server.port);
      await c.joinAsNew(`trunc${n}`);
      c.sendRawBinary(valid.subarray(0, n));
      const processed = await c
        .waitEvent('ChatMessage', (v) => String((v as { text?: string }).text ?? '').includes(CANARY), 300)
        .then(() => true)
        .catch(() => false);
      assert.equal(processed, false, `truncated frame of length ${n} must never be processed`);
      c.ws.close();
    }
    await assertServesNewPlayers(server.port, 'truncation');
  });

  await t.test('depth-bomb LSER is refused by the decoder, not the process', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('depthbomb');
    // 200 unterminated nested tables. Hand-crafted: the client encoder caps at 16, so the
    // only way to exercise the server's decoder guard is to write the bytes directly.
    const bomb = Buffer.concat([Buffer.from([LSER_VERSION]), Buffer.alloc(200, TABLE_START)]);
    c.sendRawBinary(packEvent(99, 'ChatSend', bomb));
    await Promise.race([c.closed, new Promise((r) => setTimeout(r, 500))]);
    await assertServesNewPlayers(server.port, 'depthbomb');
    c.ws.close();
  });

  await t.test('huge declared length in LSER does not allocate or hang', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('bigalloc');
    // LONG_STRING (0x01) claiming 4 GB with no payload behind it.
    const evil = Buffer.concat([Buffer.from([LSER_VERSION, 0x01]), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
    const t0 = Date.now();
    c.sendRawBinary(packEvent(1, 'ChatSend', evil));
    await Promise.race([c.closed, new Promise((r) => setTimeout(r, 1000))]);
    assert.ok(Date.now() - t0 < 5000, 'server did not hang on a bogus length field');
    await assertServesNewPlayers(server.port, 'bigalloc');
    c.ws.close();
  });

  await t.test('unknown event names and unknown binary types are ignored, session lives', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('unknown');
    // Unknown-but-well-formed traffic is NOT a protocol violation: the session must survive
    // (this is what lets an older server tolerate a newer client's extra messages).
    c.sendEvent('TotallyMadeUpMessage', { a: 1 });
    c.sendRawBinary(packEnvelope(0xbeef, 1, Buffer.from([1, 2, 3])));
    c.sendEvent('ChatSend', { text: 'unknowns ignored' });
    await c.waitEvent('ChatMessage', (v) => String((v as { text: string }).text).includes('unknowns ignored'), 4000);
    c.ws.close();
  });

  await t.test('an empty event name is a protocol violation, not an unknown message', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('emptyname');
    // Hand-crafted: the client encoder refuses to emit a zero-length name, so the only way
    // to test the server's guard is to write the frame bytes directly ([u8 nameLen=0]).
    c.sendRawBinary(packEnvelope(0x0002, 1, Buffer.from([0x00, 0x00])));
    await Promise.race([c.closed, new Promise((r) => setTimeout(r, 800))]);
    await assertServesNewPlayers(server.port, 'emptyname');
    c.ws.close();
  });

  await t.test('spoofing: state writes are attributed to the sender, never to a body id', async () => {
    const victim = await TestClient.connect(server.port);
    const { playerId: victimId } = await victim.joinAsNew('victim');
    victim.sendCellChange('0,0', 0, 0, 0);
    await victim.waitEvent('PlayerCellChange');

    const attacker = await TestClient.connect(server.port);
    await attacker.joinAsNew('attacker');
    attacker.sendCellChange('0,0', 0, 0, 0);
    await attacker.waitEvent('PlayerCellChange');
    victim.inbox.events.length = 0;

    // Name the victim's id in the body and try to rewrite their identity and stats.
    attacker.sendEvent('PlayerStatsDynamic', {
      id: victimId, playerId: victimId,
      hp: { c: 1, b: 1 }, mp: { c: 1, b: 1 }, ft: { c: 1, b: 1 },
    });
    attacker.sendEvent('PlayerAppearance', {
      id: victimId, playerId: victimId,
      race: 'hacked', head: 'h', hair: 'h', isMale: true, class: 'c', name: 'hacked',
    });
    await new Promise((r) => setTimeout(r, 500));

    const spoofed = victim.inbox.events.filter(
      (e) => (e.name === 'PlayerStatsDynamic' || e.name === 'PlayerAppearance')
        && (e.value as { id?: number }).id === victimId,
    );
    assert.equal(spoofed.length, 0, 'no relayed event is attributed to the victim');
    victim.ws.close();
    attacker.ws.close();
  });

  await t.test('oversized frame is refused without killing the server', async () => {
    const c = await TestClient.connect(server.port);
    await c.joinAsNew('oversize');
    c.sendRawBinary(randomBytes(400_000)); // past [limits] maxMsgBytes (256 KB)
    await Promise.race([c.closed, new Promise((r) => setTimeout(r, 800))]);
    await assertServesNewPlayers(server.port, 'oversize');
  });

  await t.test('connect/disconnect churn leaks no sessions', async () => {
    const players = async () =>
      ((await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()) as { players: unknown[] }).players.length;
    // Session teardown is async, so a bare reading can catch earlier subtests' sockets
    // mid-drain and poison the baseline. Poll until the count holds steady.
    const settled = async () => {
      let last = await players();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const now = await players();
        if (now === last) return now;
        last = now;
      }
      return last;
    };
    const before = await settled();
    // Deliberately ONE full join per round: registration runs argon2id (m=19456,t=2), which
    // is expensive by design — bursting it concurrently is a CPU-starvation test, not a
    // cleanup test, and the login limiter is what guards that in production. The
    // abandoned-mid-handshake sockets cost nothing and cover the other teardown path.
    for (let round = 0; round < 6; round++) {
      const joined = await TestClient.connect(server.port);
      await joined.joinAsNew(`churn_${round}`);
      const abandoned = await Promise.all(
        Array.from({ length: 4 }, () =>
          TestClient.connect(server.port).then((c) => { c.hello(); return c; }),
        ),
      );
      for (const c of [joined, ...abandoned]) c.ws.close();
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(await settled(), before, 'no sessions leaked across 30 connect/disconnect cycles');
  });

  await t.test('abrupt holder disconnect mid-operation hands off authority', async () => {
    const a = await TestClient.connect(server.port);
    await a.joinAsNew('midop_a');
    a.sendCellChange('77,77', 0, 0, 0);
    await a.waitEvent('ActorAuthorityGrant', () => true, 5000);

    const b = await TestClient.connect(server.port);
    await b.joinAsNew('midop_b');
    b.sendCellChange('77,77', 0, 0, 0);
    await b.waitEvent('ActorAuthorityInfo', () => true, 5000);

    a.ws.terminate(); // hard kill, no close handshake — the real "player alt-F4'd" case
    const grant = await b.waitEvent('ActorAuthorityGrant', () => true, 8000);
    assert.ok(grant, 'authority handed off after an abrupt holder disconnect');
    b.ws.close();
  });
});
