// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M8 ops: rank gating for every command at every rank, ban/ipban enforcement including
// reconnect attempts, the AdminCommand event path, /console gating and auditing, session
// resume inside and outside the window (and that resume cannot dodge content policy),
// resume re-sync completeness, and the public /status lobby payload.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../src/server';
import type { DeepPartial, Config } from '../src/config';
import { TestClient, tmpDataDir, MANIFEST } from './helpers';

async function boot(t: { after(fn: () => unknown): void }, override?: DeepPartial<Config>, dataDir = tmpDataDir()) {
  const configOverride: DeepPartial<Config> = {
    ...override,
    time: { scale: 0, ...override?.time },
    // Every client dials from 127.0.0.1: a starved limiter would fail later subtests for
    // reasons unrelated to what they assert.
    limits: { maxConnsPerIp: 64, loginPerMinPerIp: 240, ...override?.limits },
  };
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1', configOverride });
  t.after(() => server.close());
  return { server, dataDir };
}

async function join(server: RunningServer, name: string) {
  const c = await TestClient.connect(server.port);
  const w = await c.joinAsNew(name);
  await c.waitEvent('PlayerList');
  // The motd plugin greets every joiner on the server channel; drain it so it cannot be
  // mistaken for a command reply later.
  await c.waitEvent('ChatMessage', (v) => (v as { channel: string }).channel === 'server');
  return { c, playerId: w.playerId, welcome: w.welcome };
}

// Runs a slash command and returns the server's whispered answer. `want` picks the line
// out of the server channel: /motd also BROADCASTS on that channel, so "first server
// message wins" would race the reply against the broadcast.
async function slash(c: TestClient, line: string, want: RegExp = /.*/): Promise<string> {
  c.sendEvent('ChatSend', { text: line });
  const msg = await c.waitEvent('ChatMessage', (v) => {
    const m = v as { channel: string; text: string };
    return m.channel === 'server' && want.test(m.text);
  });
  return (msg.value as { text: string }).text;
}

async function status(server: RunningServer): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${server.port}/status`);
  return (await res.json()) as Record<string, unknown>;
}

test('rank gating', async (t) => {
  const { server } = await boot(t, { admin: { owners: ['Owner'] } });
  // Owner registers first so the [admin] owners seeding has an account to promote; the
  // plugin promotion is applied to the live session too.
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');
  const { c: player } = await join(server, 'Player');
  const { c: victim } = await join(server, 'Victim');

  await t.test('rank 0 may run open commands and is refused privileged ones', async () => {
    assert.match(await slash(player, '/list', /Player/), /Player/);
    assert.match(await slash(player, '/motd', /^MOTD: /), /^MOTD: /);
    for (const [cmd, need] of [['kick Victim', 1], ['tp Victim', 1], ['tpto Victim', 1],
      ['ban Victim', 2], ['unban Victim', 2], ['ipban Victim', 2], ['give Victim gold_001', 2],
      ['motd hijacked', 2], ['setrank Victim 3', 3], ['console Victim print(1)', 3]] as const) {
      const answer = await slash(player, `/${cmd}`, new RegExp(`requires rank ${need}`));
      assert.match(answer, new RegExp(`requires rank ${need}`), `/${cmd} must be refused at rank 0: ${answer}`);
    }
    // A refusal must not have had an effect.
    assert.match(await slash(player, '/motd', /^MOTD: /), /^MOTD: (?!hijacked)/);
  });

  await t.test('rank 1 unlocks crowd control but nothing above it', async () => {
    assert.match(await slash(owner, '/setrank Player 1', /moderator/), /moderator/);
    assert.match(await slash(player, '/tpto Victim', /not in a cell yet/), /not in a cell yet/); // gate passed
    assert.match(await slash(player, '/ban Victim', /requires rank 2/), /requires rank 2/);
    assert.match(await slash(player, '/setrank Victim 2', /requires rank 3/), /requires rank 3/);
  });

  await t.test('rank 2 unlocks state changes but not escalation or console', async () => {
    assert.match(await slash(owner, '/setrank Player 2', /admin/), /admin/);
    assert.match(await slash(player, '/give Victim gold_001 5', /Gave 5x gold_001 to Victim/), /Gave 5x gold_001 to Victim/);
    assert.deepEqual((await victim.waitEvent('AdminGive')).value, { recordId: 'gold_001', count: 5 });
    assert.match(await slash(player, '/motd from an admin', /MOTD set to: from an admin/), /MOTD set to: from an admin/);
    assert.match(await slash(player, '/console Victim print(1)', /requires rank 3/), /requires rank 3/);
    assert.match(await slash(player, '/setrank Victim 1', /requires rank 3/), /requires rank 3/);
  });

  await t.test('a lower rank cannot act on someone who outranks them', async () => {
    assert.match(await slash(owner, '/setrank Victim 3', /owner/), /owner/);
    assert.match(await slash(player, '/kick Victim', /outranks you/), /outranks you/);
    assert.match(await slash(player, '/ban Victim', /outranks you/), /outranks you/);
    assert.match(await slash(player, '/ipban Victim', /outranks you/), /outranks you/);
    assert.match(await slash(owner, '/setrank Victim 0', /player/), /player/);
  });

  await t.test('unknown commands and bad arguments answer clearly', async () => {
    assert.match(await slash(owner, '/nonsense', /Unknown command/), /Unknown command/);
    assert.match(await slash(owner, '/kick', /usage: \/kick/), /usage: \/kick/);
    assert.match(await slash(owner, '/kick Nobody', /No player named "Nobody"/), /No player named "Nobody"/);
    assert.match(await slash(owner, '/give Victim gold_001 0', /count must be an integer/), /count must be an integer/);
    assert.match(await slash(owner, '/setrank Victim 9', /usage: \/setrank/), /usage: \/setrank/);
    assert.match(await slash(owner, '/ban Nobody', /No account named/), /No account named/);
  });

  await t.test('the AdminCommand event path shares the gate and always answers', async () => {
    player.sendEvent('AdminCommand', { cmd: 'list', args: [] });
    assert.match(((await player.waitEvent('AdminResult')).value as { text: string }).text, /Owner/);
    player.sendEvent('AdminCommand', { cmd: 'setrank', args: ['Victim', '3'] }); // rank 2 actor
    assert.match(((await player.waitEvent('AdminResult')).value as { text: string }).text, /requires rank 3/);
    for (const body of [{ cmd: 'list' }, { cmd: 42, args: [] }, { cmd: 'give', args: [{ nested: 1 }] }, {}]) {
      player.sendEvent('AdminCommand', body);
      const text = ((await player.waitEvent('AdminResult')).value as { text: string }).text;
      assert.ok(text.length > 0, 'a malformed AdminCommand still gets an answer');
    }
    // Malformed admin traffic must not have cost the session.
    assert.equal(player.isClosed, false);
    assert.match(await slash(player, '/list', /Player/), /Player/);
  });

  await t.test('/console is owner-only, delivered, and disable-able', async () => {
    assert.match(await slash(owner, '/console Victim print("hi there")', /Sent to Victim/), /Sent to Victim/);
    assert.deepEqual((await victim.waitEvent('ConsoleCommand')).value, { script: 'print("hi there")' });
    assert.match(await slash(owner, '/console Nobody print(1)', /usage: \/console/), /usage: \/console/);
  });

  owner.close(); player.close(); victim.close();
  await owner.closed; await player.closed; await victim.closed;
});

test('/console can be disabled entirely', async (t) => {
  const { server } = await boot(t, { admin: { allowConsole: false } });
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');
  const { c: victim } = await join(server, 'Victim');
  assert.match(await slash(owner, '/console Victim print(1)', /not permitted|disabled/), /not permitted|disabled/);
  victim.sendEvent('ChatSend', { text: 'still here' });
  await victim.waitEvent('ChatMessage', (v) => (v as { text: string }).text === 'still here');
  assert.equal(victim.inbox.events.filter((e) => e.name === 'ConsoleCommand').length, 0);
  owner.close(); victim.close();
  await owner.closed; await victim.closed;
});

test('bans', async (t) => {
  const dataDir = tmpDataDir();
  const { server } = await boot(t, undefined, dataDir);
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');

  await t.test('a banned account is kicked and refused on reconnect', async () => {
    const { c: bad } = await join(server, 'Griefer');
    assert.match(await slash(owner, '/ban Griefer spawn camping', /Banned Griefer: spawn camping/), /Banned Griefer: spawn camping/);
    const kicked = await bad.waitDisconnect('BANNED');
    assert.match(String(kicked['detail']), /spawn camping/);
    await bad.closed;

    const again = await TestClient.connect(server.port);
    again.hello();
    await again.waitJson('SessionHelloOk');
    again.login('Griefer', 'hunter22');
    await again.waitDisconnect('BANNED');
    again.close();
    await again.closed;
  });

  await t.test('the ban survives a restart and re-registration is refused too', async () => {
    await server.flush();
    await server.close();
    const restarted = await startServer({
      dataDir, port: 0, host: '127.0.0.1',
      configOverride: { time: { scale: 0 }, limits: { maxConnsPerIp: 64, loginPerMinPerIp: 240 } },
    });
    t.after(() => restarted.close());
    const c = await TestClient.connect(restarted.port);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.register('Griefer', 'hunter22'); // the account exists; a re-register must not slip past
    await c.waitDisconnect('BANNED');
    c.close();
    await c.closed;

    // And unbanning lets them back in.
    const { c: owner2 } = await join(restarted, 'Owner2');
    await restarted.api.world.promoteOwner('Owner2');
    assert.match(await slash(owner2, '/unban Griefer', /Unbanned Griefer/), /Unbanned Griefer/);
    const back = await TestClient.connect(restarted.port);
    back.hello();
    await back.waitJson('SessionHelloOk');
    back.login('Griefer', 'hunter22');
    await back.waitJson('SessionWelcome');
    back.close(); owner2.close();
    await back.closed; await owner2.closed;
  });
});

test('ip bans are refused at accept', async (t) => {
  const { server } = await boot(t);
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');
  const { c: target } = await join(server, 'Target');

  // Every test client shares 127.0.0.1, so banning the target's address also kicks the
  // admin who issued it — the real-world footgun, and the honest assertion: an IP ban
  // takes effect on every session from that address, including the actor's own.
  owner.sendEvent('ChatSend', { text: '/ipban Target proxy abuse' });
  await target.waitDisconnect('BANNED');
  await owner.waitDisconnect('BANNED');
  await target.closed;
  await owner.closed;

  const blocked = await TestClient.connect(server.port);
  const closed = await blocked.closed; // refused before Hello: no parsing, no argon2
  assert.equal(closed.reason, 'BANNED');
  assert.ok(blocked.inbox.json.some((m) => m['t'] === 'SessionDisconnect' && m['code'] === 'BANNED'));
});

test('session resume', async (t) => {
  const { server } = await boot(t, { login: { resumeWindowSec: 60 } });

  await t.test('a dropped session rejoins in place with a full re-sync', async () => {
    const first = await TestClient.connect(server.port);
    const w = await first.joinAsNew('Wanderer');
    await first.waitEvent('PlayerList');
    const token = w.welcome['sessionToken'] as string;
    first.sendCellChange('7,7', 100, 200, 300);
    await first.waitEvent('WorldCellState');
    // A peer who stays connected must see the rejoin.
    const { c: peer } = await join(server, 'Peer');

    first.close();
    await first.closed;

    const back = await TestClient.connect(server.port);
    back.hello();
    await back.waitJson('SessionHelloOk');
    back.sendJson({ t: 'SessionResume', token });
    const welcome = await back.waitJson('SessionWelcome');
    assert.ok(typeof welcome['sessionToken'] === 'string' && welcome['sessionToken'] !== token,
      'a resumed session mints a fresh token');
    back.sendJson({ t: 'SessionReady' });

    // Completeness: everything a fresh join gets, plus the cell it left off in.
    await back.waitEvent('PlayerList');
    await back.waitEvent('JournalSync');
    await back.waitEvent('WorldTime');
    await back.waitEvent('RecordsSync');
    const cellState = (await back.waitEvent('WorldCellState')).value as { cellKey: string };
    assert.equal(cellState.cellKey, '7,7', 'the cell it left off in is replayed');
    await back.waitEvent('ActorAuthorityGrant', (v) => (v as { cellKey: string }).cellKey === '7,7');
    // Peers are told where the resumed player is.
    const seen = (await peer.waitEvent('PlayerCellChange', (v) =>
      (v as { cellKey: string }).cellKey === '7,7')).value as { x: number };
    assert.equal(seen.x, 100);

    // Single use: the ticket was consumed by the resume above.
    const replay = await TestClient.connect(server.port);
    replay.hello();
    await replay.waitJson('SessionHelloOk');
    replay.sendJson({ t: 'SessionResume', token });
    await replay.waitDisconnect('AUTH_FAILED');
    replay.close();
    await replay.closed;

    back.close(); peer.close();
    await back.closed; await peer.closed;
  });

  await t.test('a resume cannot bypass content policy', async () => {
    // Content policy is adopt-first-canonical and is released when the server empties, so
    // an anchor client stays connected while the resuming one reconnects.
    const { c: anchor } = await join(server, 'Anchor');
    const first = await TestClient.connect(server.port);
    const w = await first.joinAsNew('Policy');
    await first.waitEvent('PlayerList');
    const token = w.welcome['sessionToken'] as string;
    first.close();
    await first.closed;

    const back = await TestClient.connect(server.port);
    back.hello([{ name: 'Totally Different.esm', size: 1, idx: 0 }]); // wrong load order
    await back.waitDisconnect('BAD_CONTENT'); // refused at Hello, before SessionResume
    back.close();
    await back.closed;

    // The ticket is still valid for a client that DOES match.
    const ok = await TestClient.connect(server.port);
    ok.hello(MANIFEST);
    await ok.waitJson('SessionHelloOk');
    ok.sendJson({ t: 'SessionResume', token });
    await ok.waitJson('SessionWelcome');
    ok.close(); anchor.close();
    await ok.closed; await anchor.closed;
  });

  await t.test('resuming an account connected elsewhere still supersedes', async () => {
    const live = await TestClient.connect(server.port);
    const w = await live.joinAsNew('Doubled');
    await live.waitEvent('PlayerList');
    const token = w.welcome['sessionToken'] as string;
    live.close(); // parks the ticket
    await live.closed;

    const a = await TestClient.connect(server.port);
    a.hello();
    await a.waitJson('SessionHelloOk');
    a.login('Doubled', 'hunter22');
    await a.waitJson('SessionWelcome');
    a.sendJson({ t: 'SessionReady' });
    await a.waitEvent('PlayerList');

    const b = await TestClient.connect(server.port);
    b.hello();
    await b.waitJson('SessionHelloOk');
    b.sendJson({ t: 'SessionResume', token });
    await b.waitJson('SessionWelcome');
    await a.waitDisconnect('SUPERSEDED');
    a.close(); b.close();
    await a.closed; await b.closed;
  });
});

test('resume outside the window is refused', async (t) => {
  const { server } = await boot(t, { login: { resumeWindowSec: 1 } });
  const first = await TestClient.connect(server.port);
  const w = await first.joinAsNew('Expired');
  await first.waitEvent('PlayerList');
  const token = w.welcome['sessionToken'] as string;
  first.close();
  await first.closed;
  await new Promise((r) => setTimeout(r, 1200)); // past resumeWindowSec

  const back = await TestClient.connect(server.port);
  back.hello();
  await back.waitJson('SessionHelloOk');
  back.sendJson({ t: 'SessionResume', token });
  const msg = await back.waitDisconnect('AUTH_FAILED');
  assert.match(String(msg['detail']), /expired or unknown/);
  back.close();
  await back.closed;

});

test('resume disabled by config', async (t) => {
  const { server } = await boot(t, { login: { resumeWindowSec: 0 } });
  const first = await TestClient.connect(server.port);
  const w = await first.joinAsNew('NoResume');
  await first.waitEvent('PlayerList');
  const token = w.welcome['sessionToken'] as string;
  first.close();
  await first.closed;

  const back = await TestClient.connect(server.port);
  back.hello();
  await back.waitJson('SessionHelloOk');
  back.sendJson({ t: 'SessionResume', token });
  const msg = await back.waitDisconnect('AUTH_FAILED');
  assert.match(String(msg['detail']), /disabled/);
  back.close();
  await back.closed;
});

test('the /status lobby payload', async (t) => {
  const { server } = await boot(t, { server: { name: 'Lobby Test', motd: 'hello world' } });
  const empty = await status(server);
  assert.equal(empty['name'], 'Lobby Test');
  assert.equal(empty['motd'], 'hello world');
  assert.equal(empty['playerCount'], 0);
  assert.equal(empty['contentPolicy'], 'names');
  assert.equal(empty['requiresPassword'], false);
  assert.equal(empty['allowsRegistration'], true);
  assert.equal(typeof empty['version'], 'string');
  assert.equal(typeof empty['uptime'], 'number');

  const { c } = await join(server, 'Lister');
  c.sendCellChange('3,3', 0, 0, 0);
  await c.waitEvent('WorldCellState');
  const busy = await status(server);
  assert.equal(busy['playerCount'], 1);
  const players = busy['players'] as { name: string; cellKey: string }[];
  assert.deepEqual(players.map((p) => [p.name, p.cellKey]), [['Lister', '3,3']]);

  // Nothing sensitive may leak into a public endpoint.
  const raw = JSON.stringify(busy);
  assert.doesNotMatch(raw, /127\.0\.0\.1|\bip\b|pwHash|argon2|rank|banned/i);

  // /motd is reflected live.
  await server.api.world.promoteOwner('Lister');
  assert.match(await slash(c, '/motd fresh news', /MOTD set to/), /MOTD set to/);
  assert.equal((await status(server))['motd'], 'fresh news');
  c.close();
  await c.closed;
});

test('erasure removes everything about an account', async (t) => {
  const { deleteAccount } = await import('../src/persist/erase');
  const { readdir } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const dataDir = tmpDataDir();
  const { server } = await boot(t, undefined, dataDir);
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');
  const { c } = await join(server, 'Forgettable');
  c.sendCellChange('2,2', 1, 2, 3);
  await c.waitEvent('WorldCellState');
  await slash(owner, '/ban Forgettable test');
  await c.closed;
  owner.close();
  await owner.closed;
  await server.flush();
  await server.close();

  const report = await deleteAccount(dataDir, 'Forgettable');
  assert.deepEqual(report, { account: true, player: true, bans: true });
  assert.ok(!(await readdir(pjoin(dataDir, 'accounts'))).includes('forgettable.json'));
  assert.ok(!(await readdir(pjoin(dataDir, 'players'))).includes('forgettable.json'));
  // Idempotent: erasing again reports nothing left to erase rather than throwing.
  assert.deepEqual(await deleteAccount(dataDir, 'Forgettable'), { account: false, player: false, bans: false });
});
