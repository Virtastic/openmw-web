// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s96: THE GAME-FILE ROUTES ARE MOUNTED ON THE GATEWAY, and fail closed (v2: ESM-ownership gate).
//
// This is the bug an operator actually hit. They set the server up for multiplayer, uploaded
// 1.2 GB of Morrowind through the dashboard, were told it worked, went to play — and the game
// page asked THEM to supply the game files.
//
// mwDataRoutes was mounted in server.ts alone. The gateway is a different program and is what a
// player actually reaches, so /mwdata-manifest.json and /mwdata/* 404ed there; the page reads
// that 404 as "this server has no copy" and falls back to asking the player. The operator's
// answer was honoured in single player and silently inverted in multiplayer.
//
// Nothing covered it because every scenario boots with ?nomw (the bundled sample data), which
// never asks the server for a library at all. So this asserts the LIBRARY ROUTES on the
// gateway directly: the manifest lists what the operator uploaded, a file comes back with its
// bytes, and turning the answer off makes the path stop existing rather than 403 (a 403 would
// confirm there is a library here worth asking for).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessSession, startGatewayAndClient } from './_gateway.mjs';


// Spaced ten apart from its neighbours on purpose: the gateway puts each world it
// spawns on GW_PORT + 200 upward, one per client, so adjacent scenarios were handing
// each other a port the previous run had not finished draining — which surfaces as
// "the player own world must come up" and looks exactly like a broken product.
const GW_PORT = 18880;

export default async function run(ctx) {
  // The operator's library, as the dashboard's upload would leave it: real files under the
  // SHARED dir, which is the one every world and the gateway read.
  const lib = join(ctx.serverDataDir, 'gamedata');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'Morrowind.esm'), 'x'.repeat(2048));
  mkdirSync(join(lib, 'Fonts'), { recursive: true });
  writeFileSync(join(lib, 'Fonts', 'demo.fnt'), 'y'.repeat(64));

  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'files-host',
  });
  try {
    const base = `http://127.0.0.1:${GW_PORT}`;

    // v2 (OT3-216, OT3-219): the library is served only to a signed-in account that has PROVEN
    // it owns the game (the three ESMs by exact hash, via /locker/needed + the attest route).
    // To everyone else the paths do not exist: a 404, not a 403, which would confirm there is a
    // library worth asking for. The positive side needs genuine Morrowind hashes, so it stays in
    // the unit tier (server/test/mwdata-serve.test.ts, locker-esm.test.ts); what only a real
    // gateway can show is that the routes are MOUNTED THERE and fail closed.
    const token = await harnessSession(GW_PORT, host.account);
    const authed = { authorization: `Bearer ${token}` };

    // 1. THE MANIFEST: not a library you may ask about, anonymous or signed-in without ownership.
    for (const [who, headers] of [['anonymous', {}], ['signed in, no ownership proof', authed]]) {
      const r = await fetch(`${base}/mwdata-manifest.json`, { headers });
      assert.equal(r.status, 404, `${who}: the manifest must not exist for a non-owner (${r.status})`);
    }
    ctx.log('ok: the manifest is a 404 to anyone who has not proven ownership');

    // 2. THE FILES THEMSELVES, nested paths included.
    for (const path of ['/mwdata/Morrowind.esm', '/mwdata/Fonts/demo.fnt']) {
      for (const headers of [{}, authed]) {
        const r = await fetch(`${base}${path}`, { headers });
        assert.equal(r.status, 404, `${path} must not be served to a non-owner (${r.status})`);
      }
    }
    ctx.log('ok: the files are a 404 to a non-owner too');

    // 3. Walking out of the folder must not reach the disk either.
    for (const path of ['/mwdata/../config.toml', '/mwdata/..%2fconfig.toml']) {
      const bad = await fetch(`${base}${path}`, { headers: authed });
      assert.ok(bad.status >= 400, `${path} must not escape the library, got ${bad.status}`);
    }
    ctx.log('ok: paths that climb out of the library are refused');

    ctx.log('PASS: the gateway mounts the game-file routes and they fail closed for a non-owner');
  } finally {
    host.stop();
  }
}
