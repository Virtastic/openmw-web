// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s96: THE SERVER HANDS OUT THE GAME FILES — on the multiplayer server too.
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
import { startGatewayAndClient } from './_gateway.mjs';

// The wizard forces this on: the server always supplies the files. Spelled out here because
// the harness writes its own config and a scenario is the only place to say what it needs.
export const serverRules = '[setup]\ndeliveryModel = "serve"';

const GW_PORT = 18866;

export default async function run(ctx) {
  // The operator's library, as the dashboard's upload would leave it: real files under the
  // SHARED dir, which is the one every world and the gateway read.
  const lib = join(ctx.serverDataDir, 'gamedata');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'Morrowind.esm'), 'x'.repeat(2048));
  mkdirSync(join(lib, 'Fonts'), { recursive: true });
  writeFileSync(join(lib, 'Fonts', 'demo.fnt'), 'y'.repeat(64));

  const host = await startGatewayAndClient(ctx, {
    gwPort: GW_PORT, name: 'files-host', ownId: 'priv-files-world',
  });
  try {
    const base = `http://127.0.0.1:${GW_PORT}`;

    // 1. THE MANIFEST. A player's page fetches this once per boot and mounts every entry; a
    // 404 here is the whole bug.
    const r = await fetch(`${base}/mwdata-manifest.json`);
    assert.equal(r.status, 200,
      `the multiplayer server must serve the operator's library (${r.status}) — a 404 here is`
      + ' what asks the player to upload a game the operator already uploaded');
    const files = await r.json();
    const names = files.map((f) => f.p).sort();
    assert.deepEqual(names, ['Fonts/demo.fnt', 'Morrowind.esm'],
      `the manifest must list what is on disk, got ${JSON.stringify(names)}`);
    const esm = files.find((f) => f.p === 'Morrowind.esm');
    assert.equal(esm.s, 2048, 'and each entry carries its real size, which the client mounts by');
    ctx.log(`ok: the manifest lists ${files.length} file(s) the operator uploaded`);

    // 2. THE FILES THEMSELVES, including one in a subdirectory — the client concatenates the
    // manifest path onto mwdata/, so a separator handled wrongly breaks exactly these.
    const one = await fetch(`${base}/mwdata/Morrowind.esm`);
    assert.equal(one.status, 200, `the file itself must be served (${one.status})`);
    assert.equal((await one.text()).length, 2048, 'and be the bytes on disk, whole');
    const nested = await fetch(`${base}/mwdata/Fonts/demo.fnt`);
    assert.equal(nested.status, 200, `a nested path must be served too (${nested.status})`);
    ctx.log('ok: the files themselves come back, nested paths included');

    // 3. NOT A LIBRARY YOU MAY ASK ABOUT. Walking out of the folder must not reach the disk.
    for (const path of ['/mwdata/../config.toml', '/mwdata/..%2fconfig.toml']) {
      const bad = await fetch(`${base}${path}`);
      assert.ok(bad.status >= 400,
        `${path} must not escape the library, got ${bad.status}`);
    }
    ctx.log('ok: paths that climb out of the library are refused');

    ctx.log('PASS: the multiplayer server hands out the game files the operator uploaded');
  } finally {
    host.stop();
  }
}
