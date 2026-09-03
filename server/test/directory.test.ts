// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// F3: the world directory. Driven over real HTTP against a fake-spawned supervisor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WorldSupervisor } from '../src/gateway/worlds';
import { startDirectory } from '../src/gateway/directory';

class FakeChild extends EventEmitter {
  pid = 99;
  kill(sig: string): boolean { queueMicrotask(() => this.emit('exit', 0, sig)); return true; }
}

async function harness(maxWorlds = 5, maxPerOwner = 2) {
  const wdir = mkdtempSync(join(tmpdir(), 'omw-dir-'));
  const worlds = new WorldSupervisor({
    settings: {
      worldsDir: wdir, gatewayPort: 8080,
      serverEntry: '/fake/server.mjs', nodeBin: '/fake/node',
      basePort: 42000, maxWorlds, idleReapMs: 60_000, startTimeoutMs: 1000,
      restartBackoffMs: 1000,
      sharedDir: mkdtempSync(join(tmpdir(), 'omw-shared-')),
    },
    spawner: () => new FakeChild() as unknown as ChildProcess,
    fetchStatus: async (port) => ({ playerCount: 0, connectedCount: 0, maxPlayers: 32, name: `w${port}` }),
  });
  await worlds.poll();
  const dir = await startDirectory({
    worlds, host: '127.0.0.1', port: 0, maxPerOwner, worldsDir: wdir,
    // Production resolves this from the locker session. Here the Bearer token IS the account,
    // so the tests exercise the same rule: who is asking comes from the verified session,
    // never from the request body (which anyone could fabricate to exhaust the world cap).
    resolveAccount: (auth: string) => (auth.startsWith('Bearer ') ? auth.slice(7) : undefined),
    // A WORLD PROCESS has no locker session to present, so this is how it proves it is part
    // of the platform and may act for a player. Without it every in-game create was 401.
    isTrustedServer: (auth: string) => auth === 'Bearer platform-secret',
  });
  const base = `http://127.0.0.1:${dir.port}`;
  return { worlds, dir, base, cleanup: async () => { await dir.close(); worlds.stopAll(); } };
}

test('directory: a stranger sees NO worlds — the friends list is the only door', async () => {
  const h = await harness();
  try {
    // Somebody's world exists...
    await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer alice' },
      body: JSON.stringify({ id: 'alices-game', mode: 'party', account: 'alice' }),
    });
    // ...and an anonymous caller is shown nothing at all. There is no public world and the
    // listing is visibility for OWNERS only; discovery goes through JoinFriend.
    const r = await (await fetch(`${h.base}/worlds`)).json() as { worlds: { id: string }[] };
    assert.equal(r.worlds.length, 0, 'an anonymous caller must see an empty directory');
    // The owner sees their own, addressed by PATH on their own origin, never an address.
    const own = await (await fetch(`${h.base}/worlds?account=alice`)).json() as
      { worlds: (Record<string, unknown> & { id: string; wsPath: string })[] };
    assert.equal(own.worlds.length, 1);
    assert.equal(own.worlds[0]!.wsPath, '/w/alices-game');
    assert.ok(!('host' in own.worlds[0]!), 'must not advertise a host');
    assert.ok(!('port' in own.worlds[0]!), "must not leak the world's internal port");
  } finally { await h.cleanup(); }
});

test('directory: a private world is NOT listed to another account', async () => {
  const h = await harness();
  try {
    const created = await (await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer alice' }, body: JSON.stringify({ id: 'alices-game', mode: 'private', account: 'alice' }),
    })).json() as { id: string };
    assert.equal(created.id, 'alices-game');

    const asBob = await (await fetch(`${h.base}/worlds?account=bob`)).json() as { worlds: { id: string }[] };
    assert.ok(!asBob.worlds.some((w) => w.id === 'alices-game'),
      "bob must not see alice's private session in the lobby");
    const anon = await (await fetch(`${h.base}/worlds`)).json() as { worlds: { id: string }[] };
    assert.ok(!anon.worlds.some((w) => w.id === 'alices-game'), 'nor may an anonymous caller');

    const asAlice = await (await fetch(`${h.base}/worlds?account=alice`)).json() as { worlds: { id: string }[] };
    assert.ok(asAlice.worlds.some((w) => w.id === 'alices-game'), 'but alice must see her own');
  } finally { await h.cleanup(); }
});

test('directory: creating the same session twice re-joins rather than forking a world', async () => {
  const h = await harness();
  try {
    const body = JSON.stringify({ id: 'party7', mode: 'party', account: 'alice' });
    const as_alice = { method: 'POST', headers: { authorization: 'Bearer alice' }, body };
    const a = await (await fetch(`${h.base}/worlds`, as_alice)).json() as { wsPath: string };
    const b = await (await fetch(`${h.base}/worlds`, as_alice)).json() as { wsPath: string };
    assert.equal(a.wsPath, b.wsPath, 'a reconnect must land in the SAME world, not a fresh one');
    assert.equal(h.worlds.running, 1, 'exactly the one party world');
  } finally { await h.cleanup(); }
});

test('directory: a client cannot conjure a public world', async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer mallory' }, body: JSON.stringify({ id: 'fake-official', mode: 'public', account: 'mallory' }),
    });
    assert.equal(r.status, 400, 'the public mode is deleted; only private and party exist');
    const list = await (await fetch(`${h.base}/worlds?account=mallory`)).json() as { worlds: { id: string }[] };
    assert.ok(!list.worlds.some((w) => w.id === 'fake-official'),
      'and no such world may appear as a result');
  } finally { await h.cleanup(); }
});

test('directory: one account cannot exhaust the platform', async () => {
  const h = await harness(10, 2); // per-owner cap 2
  try {
    for (const id of ['s1', 's2']) {
      const r = await fetch(`${h.base}/worlds`, {
        method: 'POST', headers: { authorization: 'Bearer greedy' }, body: JSON.stringify({ id, mode: 'private', account: 'greedy' }),
      });
      assert.equal(r.status, 200);
    }
    const third = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer greedy' }, body: JSON.stringify({ id: 's3', mode: 'private', account: 'greedy' }),
    });
    assert.equal(third.status, 429, 'the third session for one account must be refused');
    // Another account is unaffected — the cap is per owner, not global starvation.
    const other = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer someone-else' }, body: JSON.stringify({ id: 's4', mode: 'private', account: 'someone-else' }),
    });
    assert.equal(other.status, 200, 'a different account must still be able to play');
  } finally { await h.cleanup(); }
});

test('directory: when the platform is full, the refusal is explicit', async () => {
  const h = await harness(1, 10); // room for exactly one world
  try {
    const ok = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer a' }, body: JSON.stringify({ id: 'first', mode: 'private', account: 'a' }),
    });
    assert.equal(ok.status, 200);
    const full = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer b' }, body: JSON.stringify({ id: 'second', mode: 'private', account: 'b' }),
    });
    assert.equal(full.status, 503, 'a player must be told the box is full, not left hanging');
  } finally { await h.cleanup(); }
});

test('directory: malformed input is rejected, not crashed on', async () => {
  const h = await harness();
  try {
    const auth = { authorization: 'Bearer a' };
    const cases: [string, number][] = [
      [JSON.stringify({ mode: 'private' }), 400],                    // no id
      [JSON.stringify({ id: '../../etc/passwd', mode: 'private' }), 400], // path traversal
      ['not json at all', 400],
    ];
    for (const [body, want] of cases) {
      const r = await fetch(`${h.base}/worlds`, { method: 'POST', headers: auth, body });
      assert.equal(r.status, want, `body ${body.slice(0, 40)} must be rejected`);
    }

    // Spawning a world starts an OS process, so it takes a verified session. An account named
    // in the BODY is ignored entirely — that is what let one caller fabricate a new owner per
    // request and exhaust every world slot while the per-owner cap read as satisfied.
    const unauth = await fetch(`${h.base}/worlds`, {
      method: 'POST', body: JSON.stringify({ id: 'ok', mode: 'private', account: 'someone-else' }),
    });
    assert.equal(unauth.status, 401, 'world creation without a session must be refused');
    assert.equal((await fetch(`${h.base}/healthz`)).status, 200, 'and the directory is still serving');
  } finally { await h.cleanup(); }
});

// Deleting a character and creating another asks for a NEW world each time (the id is per
// character), and the played-then-left worlds behind you were still counted against the cap —
// which locked the account out with a 429 after two characters.
test('abandoned worlds do not count against the per-owner cap', async () => {
  const h = await harness(10, 2);
  try {
    for (const id of ['c1', 'c2']) {
      const r = await fetch(`${h.base}/worlds`, {
        method: 'POST', headers: { authorization: 'Bearer player' }, body: JSON.stringify({ id, mode: 'private', account: 'player' }),
      });
      assert.equal(r.status, 200);
    }
    // Both were PLAYED and are now empty: what a deleted character leaves behind.
    for (const w of (h.worlds as unknown as {
      worlds: Map<string, { everConnected?: boolean; idleSince?: number }>;
    }).worlds.values()) {
      w.everConnected = true;
      w.idleSince = Date.now();
    }
    const next = await fetch(`${h.base}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer player' }, body: JSON.stringify({ id: 'c3', mode: 'private', account: 'player' }),
    });
    assert.equal(next.status, 200, 'a new character must not be blocked by worlds nobody is in');
  } finally { await h.cleanup(); }
});

// A deleted character's solo world can never be reached again (the id derives from the
// character), so it must be retired rather than left as a directory forever.
test('deleting a character discards exactly that character\'s world', async () => {
  const h = await harness(10, 4);
  try {
    const owner = { accountKey: 'player', username: 'Control' };
    const charId = 'cffffffffffffffffbb0faaf4';
    const mine = `priv-control-${charId.slice(-8)}`;
    const theirs = `priv-someoneelse-${charId.slice(-8)}`; // same suffix, different account
    for (const id of [mine, theirs]) {
      const r = await fetch(`${h.base}/worlds`, {
        method: 'POST', headers: { authorization: 'Bearer player' }, body: JSON.stringify({ id, mode: 'private', account: 'player' }),
      });
      assert.equal(r.status, 200);
    }
    const gone = await h.worlds.discardForCharacter(owner, charId);
    assert.deepEqual(gone, [mine], 'must discard the exact world, never one that merely shares a suffix');
    assert.ok(h.worlds.list().some((w) => w.id === theirs), 'another account\'s world survived');

    // No username -> the id cannot be derived, so nothing is deleted rather than guessed.
    assert.deepEqual(await h.worlds.discardForCharacter({ accountKey: 'player' }, charId), []);
  } finally { await h.cleanup(); }
});

// A PRIVATE WORLD'S ID IS DERIVED FROM THE CHARACTER, never trusted from the client. A stale
// launcher tab computed it from a character list that no longer matched reality, so worlds
// were minted for characters that did not exist — and the player's real character was then
// refused at that world's door. A ghost character is refused at CREATION instead.
test('POST /worlds derives the private id from the character and refuses ghosts', async () => {
  const h = await harness();
  const dir2 = await startDirectory({
    worlds: h.worlds, host: '127.0.0.1', port: 0, maxPerOwner: 2,
    worldsDir: mkdtempSync(join(tmpdir(), 'omw-dirw-')),
    resolveAccount: (auth) => (auth.startsWith('Bearer ') ? auth.slice(7) : undefined),
    // Mirrors the real rule: a known character or a well-formed PROVISIONAL id derives
    // (new characters have no slot until chargen completes); malformed garbage does not.
    privateWorldIdFor: async (acct, charId) =>
      /^c[0-9a-f]{24}$/.test(charId) ? `priv-${acct}-${charId.slice(-8)}` : undefined,
  });
  try {
    // A real character: the server's derivation wins over whatever the client computed.
    const ok = await fetch(`http://127.0.0.1:${dir2.port}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer alice' },
      body: JSON.stringify({ mode: 'private', id: 'priv-alice-wrongsuf', characterId: 'c'.repeat(25) }),
    });
    const w = await ok.json() as { id?: string; wsPath?: string };
    assert.equal(w.id, 'priv-alice-cccccccc', 'the client-computed id must not survive');
    // Malformed garbage: refused outright, no world minted. (A well-formed unknown id is a
    // PROVISIONAL new character and must derive — refusing those broke character creation.)
    const ghost = await fetch(`http://127.0.0.1:${dir2.port}/worlds`, {
      method: 'POST', headers: { authorization: 'Bearer alice' },
      body: JSON.stringify({ mode: 'private', id: 'priv-alice-deadbeef', characterId: 'not-a-character-id' }),
    });
    assert.equal(ghost.status, 404);
    assert.equal(((await ghost.json()) as { error?: string }).error, 'no_such_character');
  } finally {
    await dir2.close();
    await h.cleanup();
  }
});

// The directory's prefix list IS the router: a path the front door implements but that is
// missing here falls through to the directory's own 404, with no error anywhere to explain
// it. That is exactly how /saves behaved on the live dev server while /locker/* worked
// beside it — the game played fine and every save silently never left the browser.
test('every front-door path reaches the front door, not the directory 404', async () => {
  const h = await harness();
  const seen: string[] = [];
  const dir2 = await startDirectory({
    worlds: h.worlds, host: '127.0.0.1', port: 0, maxPerOwner: 2,
    worldsDir: mkdtempSync(join(tmpdir(), 'omw-dir2-')),
    resolveAccount: () => undefined,
    frontDoor: (_req, res, url) => {
      seen.push(url.pathname);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return true;
    },
  });
  try {
    for (const p of ['/auth/providers', '/locker/files', '/locker/blob/t/k', '/saves', '/saves/download']) {
      const r = await fetch(`http://127.0.0.1:${dir2.port}${p}`);
      assert.equal(r.status, 401, `${p} never reached the front door`);
    }
    assert.equal(seen.length, 5);
  } finally {
    await dir2.close();
    await h.cleanup();
  }
});

test('directory: a trusted world server may create a world for a player it names', async () => {
  const h = await harness();
  try {
    const r = await fetch(`${h.base}/worlds`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-secret' },
      body: JSON.stringify({ id: 'in-game-session', mode: 'private', account: 'alice' }),
    });
    assert.equal(r.status, 200, 'the platform credential is accepted');
    const w = await r.json() as { id: string; ownerAccount: string };
    assert.equal(w.ownerAccount, 'alice', 'the world belongs to the player, not to the server');
  } finally { await h.cleanup(); }
});

test('directory: naming an account is refused without the platform credential', async () => {
  const h = await harness();
  try {
    // THE NEGATIVE CONTROL FOR THE WHOLE MECHANISM. If a body-supplied account were honoured
    // for an anonymous caller, the per-owner cap would be decorative: fabricate a name per
    // request and one caller exhausts every world slot on the host. Mallory presents no
    // credential and no session, and claims to be alice.
    const r = await fetch(`${h.base}/worlds`, {
      method: 'POST',
      body: JSON.stringify({ id: 'stolen', mode: 'private', account: 'alice' }),
    });
    assert.equal(r.status, 401, 'no credential and no session means no world');

    // A WRONG credential is no better than none -- it must not fall through to trusting the
    // body just because an Authorization header was present.
    const r2 = await fetch(`${h.base}/worlds`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-secret' },
      body: JSON.stringify({ id: 'stolen2', mode: 'private', account: 'alice' }),
    });
    const owner2 = r2.status === 200
      ? (await r2.json() as { ownerAccount: string }).ownerAccount : undefined;
    assert.notEqual(owner2, 'alice',
      'a bad credential must never mint a world owned by someone else');
  } finally { await h.cleanup(); }
});

test('directory: the harness session route does not exist unless it was wired', async () => {
  // THE POINT OF THE DESIGN. mintHarnessSession is supplied by main.ts ONLY when the operator
  // has already opted into harness auth, so in production the route is ABSENT rather than
  // present-and-checking-a-flag. A locker session is a full sign-in; a route that mints one on
  // request is an account-takeover path if it ever ships enabled, which is exactly the trap
  // the fixed harness password already documents.
  const h = await harness(); // the default fixture wires no mintHarnessSession
  try {
    const r = await fetch(`${h.base}/harness/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'alice', password: 'harness-pass-1' }),
    });
    assert.notEqual(r.status, 200, 'no token may be minted when the affordance was not wired');
    const body = await r.json().catch(() => ({}));
    assert.equal((body as { token?: string }).token, undefined, 'and certainly no token in the body');
  } finally { await h.cleanup(); }
});

test('at the ceiling the platform REFUSES a new world, with a reason the UI can explain', async () => {
  // "Many worlds at once" was a claim nobody had tested: the capacity governor's ARITHMETIC is
  // covered in worlds.test.ts, but nothing exercised what happens when a real request arrives
  // at the ceiling. A cap that is computed and never enforced is not a cap.
  //
  // maxWorlds 2 = two sessions (there is no always-on world), and a per-owner cap high enough
  // that the PLATFORM limit is what binds rather than the owner limit -- otherwise this would
  // be re-testing the per-owner rule with extra steps.
  const h = await harness(2, 10);
  try {
    const mk = async (id: string, who: string) => (await fetch(`${h.base}/worlds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who}` },
      body: JSON.stringify({ id, mode: 'private', account: who }),
    })).status;

    assert.equal(await mk('one', 'alice'), 200, 'first session fits');
    assert.equal(await mk('two', 'bob'), 200, 'second session fits');

    // The third session would be the third world. It must be refused, and refused as 503 rather
    // than a 500 or a hang: WorldBrowser maps exactly that status to 'platform_full', which is
    // what turns into "The server has no room for another world right now" in the client. A
    // refusal nobody can read is a bug report about the game being broken.
    const status = await mk('three', 'cassia');
    assert.equal(status, 503,
      'over capacity must be 503 — that is the status the client turns into a legible message');
  } finally { await h.cleanup(); }
});
