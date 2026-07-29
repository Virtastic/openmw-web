// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A4 moderation: the durable chat log (shape, daily rotation, retention pruning), /report
// including the context lines an admin actually needs, the rank gate on /reports and
// /chatlog at both entry points, and what erasure does to all of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join as pjoin } from 'node:path';
import { startServer, type RunningServer } from '../src/server';
import type { DeepPartial, Config } from '../src/config';
import { ChatLog, ReportStore, type ChatLine, type ReportDoc } from '../src/core/moderation';
import { deleteAccount } from '../src/persist/erase';
import { TestClient, tmpDataDir } from './helpers';

async function boot(t: { after(fn: () => unknown): void }, override?: DeepPartial<Config>, dataDir = tmpDataDir()) {
  const configOverride: DeepPartial<Config> = {
    ...override,
    time: { scale: 0, ...override?.time },
    // Every client dials from 127.0.0.1: a starved limiter would fail later subtests for
    // reasons unrelated to what they assert (see adversarial.test.ts).
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
  await c.waitEvent('ChatMessage', (v) => (v as { channel: string }).channel === 'server'); // motd
  return { c, playerId: w.playerId };
}

async function slash(c: TestClient, line: string, want: RegExp = /.*/): Promise<string> {
  c.sendEvent('ChatSend', { text: line });
  const msg = await c.waitEvent('ChatMessage', (v) => {
    const m = v as { channel: string; text: string };
    return m.channel === 'server' && want.test(m.text);
  });
  return (msg.value as { text: string }).text;
}

// Admin answers are whispered line-by-line: collect exactly `n` of them, in order.
async function slashLines(c: TestClient, line: string, n: number): Promise<string[]> {
  c.sendEvent('ChatSend', { text: line });
  const out: string[] = [];
  while (out.length < n) {
    const m = await c.waitEvent('ChatMessage', (v) => (v as { channel: string }).channel === 'server');
    out.push((m.value as { text: string }).text);
  }
  return out;
}

async function say(c: TestClient, text: string): Promise<void> {
  c.sendEvent('ChatSend', { text });
  await c.waitEvent('ChatMessage', (v) => (v as { text: string }).text === text);
}

const today = (): string => new Date().toISOString().slice(0, 10);

// Chat lives in moderation.db (the persistence consolidation), so the log is READ BACK by
// query rather than by parsing a day file. Same assertions, different storage.
function readChatLog(dataDir: string): ChatLine[] {
  const db = new DatabaseSync(pjoin(dataDir, 'moderation.db'));
  try {
    return db
      .prepare('SELECT ts, playerId, account, name, channel, text FROM chat_lines ORDER BY id')
      .all() as unknown as ChatLine[];
  } finally {
    db.close();
  }
}

function countChatLines(dataDir: string): number {
  const db = new DatabaseSync(pjoin(dataDir, 'moderation.db'));
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM chat_lines').get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function listReports(dataDir: string): { file: string; doc: ReportDoc }[] {
  const db = new DatabaseSync(pjoin(dataDir, 'moderation.db'));
  try {
    return (db.prepare('SELECT file, doc FROM reports ORDER BY file').all() as
      { file: string; doc: string }[]).map((r) => ({ file: r.file, doc: JSON.parse(r.doc) as ReportDoc }));
  } finally {
    db.close();
  }
}

test('chat lines land in the daily file with the documented shape', async (t) => {
  const { server, dataDir } = await boot(t);
  const { c, playerId } = await join(server, 'Talker');
  await say(c, 'hello world');
  await slash(c, '/list', /Talker/);
  await server.flush(); // drains the chat log's append queue

  const lines = readChatLog(dataDir);
  const said = lines.find((l) => l.text === 'hello world');
  assert.ok(said, 'the spoken line is on disk');
  assert.deepEqual(Object.keys(said!).sort(), ['account', 'channel', 'name', 'playerId', 'text', 'ts']);
  assert.equal(said!.channel, 'say');
  assert.equal(said!.name, 'Talker');
  assert.equal(said!.account, 'talker');
  assert.equal(said!.playerId, playerId);
  assert.ok(!Number.isNaN(Date.parse(said!.ts)), 'ts is a parseable timestamp');

  // Slash commands are recorded too (channel 'command') but never broadcast.
  const cmd = lines.find((l) => l.text === '/list');
  assert.ok(cmd, '/list is in the log');
  assert.equal(cmd!.channel, 'command');

  // Everything recorded is in the one table; there are no per-day files to rotate.
  assert.equal(countChatLines(dataDir), lines.length);
  c.close();
  await c.closed;
});

test('chatLog=false keeps the durable stream off entirely', async (t) => {
  const { server, dataDir } = await boot(t, { moderation: { chatLog: false } });
  const { c } = await join(server, 'Quiet');
  await say(c, 'nothing to see');
  await server.flush();
  await assert.rejects(readdir(pjoin(dataDir, 'logs')), /ENOENT/, 'no log dir is created at all');
  c.close();
  await c.closed;
});

test('retention prunes chat lines older than retentionDays', async (t) => {
  void t;
  const dataDir = tmpDataDir();
  const at = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString();
  const log = new ChatLog(dataDir, { chatLog: true, retentionDays: 3, contextLines: 5 });
  for (const back of [0, 1, 3, 4, 30]) {
    log.record({ ts: at(back), playerId: 1, account: 'a', name: 'A', channel: 'say', text: `d${back}` });
  }
  await log.drain();
  await log.prune();
  // Retention is a time window over rows now, not a day-file glob: everything inside the
  // window survives and everything older is gone, with no rounding to whole files.
  const kept = readChatLog(dataDir).map((l) => l.text).sort();
  assert.deepEqual(kept, ['d0', 'd1', 'd3'].sort());
});

test('readRecent windows by minutes and filters by player', async (t) => {
  void t;
  const dataDir = tmpDataDir();
  const log = new ChatLog(dataDir, { chatLog: true, retentionDays: 14, contextLines: 5 });
  const line = (name: string, text: string, agoMin: number): ChatLine => ({
    ts: new Date(Date.now() - agoMin * 60_000).toISOString(),
    playerId: 1,
    account: name.toLowerCase(),
    name,
    channel: 'say',
    text,
  });
  log.record(line('Ann', 'recent ann', 1));
  log.record(line('Bob', 'recent bob', 1));
  log.record(line('Ann', 'old ann', 120));
  await log.drain();

  assert.deepEqual((await log.readRecent(10)).map((l) => l.text).sort(), ['recent ann', 'recent bob']);
  assert.deepEqual((await log.readRecent(10, 'ann')).map((l) => l.text), ['recent ann']);
  assert.deepEqual((await log.readRecent(10, 'ANN')).map((l) => l.text), ['recent ann'], 'name match is case-insensitive');
  assert.equal((await log.readRecent(10, 'Nobody')).length, 0);
  const wide = (await log.readRecent(180, 'Ann')).map((l) => l.text).sort();
  assert.deepEqual(wide, ['old ann', 'recent ann']);
});

test('a torn log line is skipped, not fatal', async (t) => {
  void t;
  const dataDir = tmpDataDir();
  const dir = pjoin(dataDir, 'logs');
  await mkdir(dir, { recursive: true });
  const good = JSON.stringify({ ts: new Date().toISOString(), playerId: 1, account: 'a', name: 'A', channel: 'say', text: 'ok' });
  await writeFile(pjoin(dir, `chat-${today()}.jsonl`), `${good}\n{"ts":"2026-`, 'utf8'); // truncated tail
  const log = new ChatLog(dataDir, { chatLog: true, retentionDays: 14, contextLines: 5 });
  assert.deepEqual((await log.readRecent(60)).map((l) => l.text), ['ok']);
});

test('/report writes a well-formed report with context', async (t) => {
  const { server, dataDir } = await boot(t);
  const { c: reporter } = await join(server, 'Reporter');
  const { c: griefer, playerId: grieferId } = await join(server, 'Griefer');
  griefer.sendCellChange('12,12', 5, 6, 7);
  await griefer.waitEvent('WorldCellState');
  await say(griefer, 'give me your gold or else');
  await say(reporter, 'no');

  assert.match(await slash(reporter, '/report Griefer extortion in chat', /Report filed/), /Report filed against Griefer/);
  await server.flush();

  const filed = listReports(dataDir);
  assert.equal(filed.length, 1);
  // The id keeps the old filename shape so an operator still has a readable handle per report.
  assert.match(filed[0]!.file, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-Reporter\.json$/, `unexpected report id ${filed[0]!.file}`);
  const doc = filed[0]!.doc;
  assert.equal(doc.reporter.name, 'Reporter');
  assert.equal(doc.reporter.account, 'reporter');
  assert.equal(doc.target.name, 'Griefer');
  assert.equal(doc.target.account, 'griefer');
  assert.equal(doc.target.id, grieferId);
  assert.equal(doc.target.cellKey, '12,12', 'the reported player\'s current cell is captured');
  assert.equal(doc.reason, 'extortion in chat');
  // Context is the point of the whole feature: the reason alone is not actionable.
  assert.ok(doc.context.some((l) => l.text === 'give me your gold or else'), 'the offending line is attached');
  assert.ok(doc.context.some((l) => l.text === 'no'), 'the reply is attached');

  await t.test('bad usage is refused without writing a file', async () => {
    assert.match(await slash(reporter, '/report', /usage: \/report/), /usage: \/report/);
    assert.match(await slash(reporter, '/report Griefer', /usage: \/report/), /usage: \/report/);
    await server.flush();
    assert.equal(listReports(dataDir).length, 1);
  });

  await t.test('an offline target is still reportable', async () => {
    assert.match(await slash(reporter, '/report Ghost logged off after griefing', /Report filed/), /Report filed/);
    await server.flush();
    const ghost = listReports(dataDir).map((r) => r.doc).find((d) => d.target.name === 'Ghost');
    assert.ok(ghost, 'a report naming an offline player is written');
    assert.equal(ghost!.target.id, null);
    assert.equal(ghost!.target.account, null);
    assert.equal(ghost!.target.cellKey, null);
  });

  reporter.close(); griefer.close();
  await reporter.closed; await griefer.closed;
});

test('/reports and /chatlog are rank-gated and work at rank 1', async (t) => {
  const { server } = await boot(t, { admin: { owners: ['Owner'] } });
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');
  const { c: mod } = await join(server, 'Mod');
  const { c: loud } = await join(server, 'Loud');
  await say(loud, 'first offensive thing');
  await say(loud, 'second offensive thing');
  await slash(mod, '/report Loud being loud', /Report filed/);

  await t.test('rank 0 is refused at both entry points, with the same wording', async () => {
    assert.match(await slash(mod, '/reports', /requires rank 1/), /requires rank 1/);
    assert.match(await slash(mod, '/chatlog Loud', /requires rank 1/), /requires rank 1/);
    mod.sendEvent('AdminCommand', { cmd: 'reports', args: [] });
    assert.match(((await mod.waitEvent('AdminResult')).value as { text: string }).text, /requires rank 1/);
    mod.sendEvent('AdminCommand', { cmd: 'chatlog', args: ['Loud'] });
    assert.match(((await mod.waitEvent('AdminResult')).value as { text: string }).text, /requires rank 1/);
  });

  await t.test('rank 1 may list reports and read chat', async () => {
    assert.match(await slash(owner, '/setrank Mod 1', /moderator/), /moderator/);
    const listed = await slash(mod, '/reports', /Mod -> Loud/);
    assert.match(listed, /being loud/);
    // A multi-line admin answer is whispered one ChatMessage per line, so collect them.
    const chat = await slashLines(mod, '/chatlog Loud 60', 2);
    assert.match(chat[0]!, /\[say\] Loud: first offensive thing/);
    assert.match(chat[1]!, /\[say\] Loud: second offensive thing/);
    // Only the named player's lines come back.
    assert.ok(chat.every((l) => !/Owner:|Mod:/.test(l)), `other players leaked: ${chat.join(' | ')}`);
  });

  await t.test('arguments are validated rather than trusted', async () => {
    assert.match(await slash(mod, '/chatlog', /usage: \/chatlog/), /usage: \/chatlog/);
    assert.match(await slash(mod, '/chatlog Loud 0', /minutes must be an integer/), /minutes must be an integer/);
    assert.match(await slash(mod, '/chatlog Loud 99999999', /minutes must be an integer/), /minutes must be an integer/);
    assert.match(await slash(mod, '/chatlog Nobody 5', /No chat from "Nobody"/), /No chat from "Nobody"/);
    assert.match(await slash(mod, '/reports 0', /usage: \/reports/), /usage: \/reports/);
    assert.match(await slash(mod, '/reports notanumber', /usage: \/reports/), /usage: \/reports/);
  });

  owner.close(); mod.close(); loud.close();
  await owner.closed; await mod.closed; await loud.closed;
});

test('/reports says so plainly when there is nothing on file', async (t) => {
  const { server } = await boot(t, { admin: { owners: ['Owner'] } });
  const { c: owner } = await join(server, 'Owner');
  await server.api.world.promoteOwner('Owner');
  assert.match(await slash(owner, '/reports', /No reports on file/), /No reports on file/);
  owner.close();
  await owner.closed;
});

test('erasure removes chat lines and reports naming the account', async (t) => {
  const dataDir = tmpDataDir();
  const { server } = await boot(t, undefined, dataDir);
  const { c: a } = await join(server, 'Erasable');
  const { c: b } = await join(server, 'Bystander');
  await say(a, 'something erasable said');
  await say(b, 'something the bystander said');
  await slash(b, '/report Erasable please remove them', /Report filed/);
  await slash(a, '/report Bystander a counter-report', /Report filed/);
  a.close(); b.close();
  await a.closed; await b.closed;
  await server.flush();
  await server.close();

  assert.equal(listReports(dataDir).length, 2);
  const report = await deleteAccount(dataDir, 'Erasable');
  assert.equal(report.account, true);
  assert.ok(report.chatLines >= 1, `expected chat lines removed, got ${report.chatLines}`);
  // Both reports name the account: one filed BY it, one ABOUT it.
  assert.equal(report.reports, 2);
  assert.equal(listReports(dataDir).length, 0);

  // The bystander's conversation is untouched — one player's erasure is not everyone's.
  const left = readChatLog(dataDir);
  assert.ok(left.some((l) => l.text === 'something the bystander said'), 'other players\' lines survive');
  assert.ok(!left.some((l) => l.account === 'erasable'), 'no line from the erased account remains');

  // Idempotent.
  const again = await deleteAccount(dataDir, 'Erasable');
  assert.deepEqual(again, { account: false, player: false, bans: false, identities: 0, chatLines: 0, reports: 0 });
});

test('an unreadable report does not hide the readable ones', async (t) => {
  void t;
  const dataDir = tmpDataDir();
  const store = new ReportStore(dataDir, 14);
  await store.write({
    ts: new Date().toISOString(),
    reporter: { id: 1, name: 'A', account: 'a' },
    target: { id: 2, name: 'B', account: 'b', cellKey: '1,1' },
    reason: 'test',
    context: [],
  });
  // A corrupt row (hand-edited, or a torn write on older storage) must not hide the rest.
  {
    const db = new DatabaseSync(pjoin(dataDir, 'moderation.db'));
    db.prepare('INSERT INTO reports (file, tsMs, doc) VALUES (?, ?, ?)')
      .run('zz-corrupt.json', Date.now(), '{not json');
    db.close();
  }
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.doc.reason, 'test');
});
