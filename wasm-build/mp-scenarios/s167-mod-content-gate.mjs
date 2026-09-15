// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s167: THE CONTENT GATE, UNDER THE HARNESS (backlog 127).
//
// A TR smoke test needs Tamriel Rebuilt on the builder, which it does not have. What the gate
// actually decides is smaller than TR and testable without it: two real browsers with the same
// plugin list must both get in, and a client whose list carries one plugin the world does not
// have must be refused BAD_CONTENT naming that plugin. The extra plugin is a structurally real
// one-record TES3 file written into the server's gamedata (the same place a dashboard upload
// lands), so a future serve-mode boot can pick it up; the gate itself is exercised by a
// protocol client that reports it. Under `names` (the shipped default) nothing hashes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLUGIN = 'Tiny Gate Test.esp';

/** A TES3 header + one GMST record: enough for esm.ts (headers only) and for openmw to load. */
function tinyEsp() {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const sub = (tag, body) => Buffer.concat([Buffer.from(tag), u32(body.length), body]);
  const rec = (tag, subs) => { const body = Buffer.concat(subs); return Buffer.concat([Buffer.from(tag), u32(body.length), u32(0), u32(0), body]); };
  const master = Buffer.from('Morrowind.esm\0', 'latin1');
  const hedr = Buffer.alloc(300); hedr.writeFloatLE(1.3, 0); hedr.writeUInt32LE(1, 296);
  return Buffer.concat([
    rec('TES3', [sub('HEDR', hedr), sub('MAST', master), sub('DATA', Buffer.alloc(8))]),
    rec('GMST', [sub('NAME', Buffer.from('sMpGateProbe\0')), sub('STRV', Buffer.from('probe\0'))]),
  ]);
}

export default async function run(ctx) {
  const lib = join(ctx.serverDataDir, 'gamedata');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, PLUGIN), tinyEsp());

  // 1. TWO BROWSERS, ONE LIST. The first pins the session's manifest (tier 1 adopt-first);
  //    the second, running the same baked data, must pass the gate it just created.
  const a = await ctx.launchClient('gate-a');
  const b = await ctx.launchClient('gate-b');
  const status = await ctx.serverStatus();
  assert.equal(status.players.length, 2, `both same-content browsers must be in (${status.players.length})`);
  ctx.log('ok: two browsers with the same content list are both in');

  // 2. ONE MORE PLUGIN THAN THE WORLD. A client reporting the browsers' world plus the tiny
  //    plugin is what a modded player looks like to an unmodded world: refused, by name.
  const { TestClient } = await import(pathToFileURL(join(ROOT, 'server', 'dist', 'testpeer.mjs')).href);
  const liar = await TestClient.connect(ctx.serverPort);
  liar.hello([{ name: PLUGIN, size: 0, idx: 0 }]);
  const refused = await liar.waitJson('SessionDisconnect');
  assert.equal(refused.code, 'BAD_CONTENT', `a mismatched list must be BAD_CONTENT, got ${JSON.stringify(refused)}`);
  assert.match(String(refused.detail), new RegExp(PLUGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `the refusal must name the offending plugin: ${refused.detail}`);
  ctx.log(`ok: BAD_CONTENT names the extra plugin: ${refused.detail}`);

  // 3. THE REFUSAL COST THE WORLD NOTHING: both browsers are still in, roster unchanged.
  const after = await ctx.serverStatus();
  assert.equal(after.players.length, 2, 'a refused client must not disturb the players already in');
  a.close(); b.close();
  ctx.log('PASS: same content joins, extra content is refused by name');
}
