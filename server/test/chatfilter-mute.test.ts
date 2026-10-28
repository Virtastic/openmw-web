// OT3-185: public-chat filter and timed, audited moderator mutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChatFilter } from '../src/core/chat';
import { SocialStore } from '../src/core/socialstore';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin } from '../src/core/admin';
import type { Player } from '../src/core/players';

test('the filter masks listed whole words in any case, and links', () => {
  const f = makeChatFilter(['badword'], true)!;
  assert.equal(f('a BadWord here'), 'a ******* here');
  assert.equal(f('badwordy stays'), 'badwordy stays');
  assert.equal(f('go to www.spam.com now'), 'go to ************ now');
  assert.equal(f('see spam.gg/x'), 'see *********');
  assert.equal(makeChatFilter([], false), undefined);
  assert.equal(makeChatFilter([], true)!('badword'), 'badword');
});

test('a timed mute stops counting the moment it expires', () => {
  const store = new SocialStore(mkdtempSync(join(tmpdir(), 'mute-')));
  const S = SocialStore.SERVER_MUTER;
  store.addMute(S, 'bob', 1000, 2000, 'spam');
  assert.equal(store.isMuted('ann', 'bob', 1500), true);
  assert.equal(store.isMuted('ann', 'bob', 2000), false);
  // A repeat mute takes the latest expiry: permanent now.
  store.addMute(S, 'bob', 1600);
  assert.equal(store.isMuted('ann', 'bob', 9_999_999), true);
});

test('/mute and /unmute go to setMuted and land in the audit table', async () => {
  const audit = new AdminAudit(mkdtempSync(join(tmpdir(), 'mute-admin-')));
  const calls: unknown[][] = [];
  const admin = new Admin({
    audit, allow: () => true, motd: () => '', setMotd: () => {},
    roster: { findByName: () => undefined },
    accounts: {
      keyForUsername: (n: string) => n.toLowerCase(),
      get: async (k: string) => (k === 'bob' ? { name: 'Bob', rank: 0 } : undefined),
    },
    setMuted: (...a: unknown[]) => calls.push(a),
  } as never);
  const mod = { id: 1, name: 'Mod', accountKey: 'mod', rank: 1 } as Player;
  const before = Date.now();
  assert.match(String(await admin.exec(mod, 'mute', ['Bob', '30', 'spamming'])), /Muted Bob for 30 min/);
  assert.equal(calls[0]![0], 'bob');
  assert.equal(calls[0]![1], true);
  assert.ok((calls[0]![2] as number) >= before + 30 * 60_000);
  assert.equal(calls[0]![3], 'spamming');
  assert.equal(audit.recent()[0]!.cmd, 'mute');
  assert.match(String(await admin.exec(mod, 'mute', ['Bob', '0'])), /usage/);
  assert.match(String(await admin.exec(mod, 'mute', ['Nobody', 'perm'])), /No account/);
  assert.match(String(await admin.exec(mod, 'unmute', ['Bob'])), /Unmuted Bob/);
  assert.deepEqual(calls.at(-1), ['bob', false]);
  assert.equal(audit.recent()[0]!.cmd, 'unmute');
});
