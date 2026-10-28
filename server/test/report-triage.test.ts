// OT3-188: report context is the reporter's and target's own lines; reports carry status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Moderation, reportView } from '../src/core/moderation';
import { AdminAudit } from '../src/core/admin-audit';
import { Admin } from '../src/core/admin';
import type { Player } from '../src/core/players';

const line = (account: string, text: string, channel = 'say') =>
  ({ ts: new Date().toISOString(), playerId: 1, account, name: account, channel, text });

for (const chatLog of [true, false]) {
  test(`context is the reporter's and target's lines across channels (chatLog=${chatLog})`, async () => {
    const mod = new Moderation(mkdtempSync(join(tmpdir(), 'rep-')), { chatLog, retentionDays: 14, contextLines: 3 });
    mod.chat.record(line('griefer', 'you suck', 'world'));
    mod.chat.record(line('bystander', 'hello all'));
    mod.chat.record(line('victim', 'leave me alone', 'whisper'));
    mod.chat.record(line('bystander', 'lol'));
    const ctx = await mod.chat.contextFor(['Victim', 'griefer']);
    assert.deepEqual(ctx.map((l) => l.text), ['you suck', 'leave me alone']);
  });
}

test('/triage claims, closes and reopens; the dashboard row keeps the context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-'));
  const moderation = new Moderation(dir, { chatLog: true, retentionDays: 14, contextLines: 20 });
  await moderation.reports.write({
    ts: new Date().toISOString(),
    reporter: { id: 1, name: 'Victim', account: 'victim' },
    target: { id: 2, name: 'Griefer', account: 'griefer', cellKey: null },
    reason: 'abuse',
    context: [line('griefer', 'you suck', 'world')],
  });
  const audit = new AdminAudit(dir);
  const admin = new Admin({ audit, allow: () => true, motd: () => '', setMotd: () => {}, moderation } as never);
  const staff = { id: 9, name: 'Mod', accountKey: 'mod', rank: 1 } as Player;
  const id = (await moderation.reports.list(1))[0]!.id;

  assert.match(String(await admin.exec(staff, 'reports', [])), new RegExp(`#${id} \\[open\\][\\s\\S]*you suck`));
  assert.match(String(await admin.exec(staff, 'triage', [`#${id}`, 'claim'])), /assigned \(Mod\)/);
  assert.equal((await moderation.reports.list(1, 'assigned')).length, 1);
  await admin.exec(staff, 'triage', [String(id), 'close']);
  const [closed] = await moderation.reports.list(1);
  assert.equal(closed!.status, 'closed');
  assert.equal(closed!.assignee, 'Mod');
  assert.equal(audit.recent()[0]!.cmd, 'triage');
  assert.match(String(await admin.exec(staff, 'triage', ['999', 'close'])), /No report #999/);

  const view = reportView(closed!);
  assert.equal(view.status, 'closed');
  assert.deepEqual(view.context.map((l) => l.text), ['you suck']);
  await admin.exec(staff, 'triage', [String(id), 'open']);
  assert.equal((await moderation.reports.list(1))[0]!.assignee, null);
});
