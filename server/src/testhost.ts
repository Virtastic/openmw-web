// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// A world server for the TEST HARNESSES, and nothing else.
//
// WHY THIS FILE EXISTS. main.ts refuses to boot without real game data, a peer binary and a
// server password — correct for a deployment, because a world nobody simulates is a world
// where NPCs stand still and a modified client is the only thing with an opinion. But it is
// fatal for the test harnesses, which spawn a server on a throwaway data dir with none of
// those things. When that mandate landed, `wasm-build/mp-harness.mjs` (40 browser scenarios)
// and `bots/soak.ts` both started failing at startup with "server never became healthy", and
// stayed dead — which is exactly how a round of regressions reached a player instead of a
// test run.
//
// The requireGameData:false seam is deliberately code-only: not a config key, not an env var,
// so no deployment can reach it by editing a file or exporting a variable. That is worth
// keeping. So the harness gets its own ENTRY POINT instead — dist/testhost.mjs, built beside
// dist/server.mjs, never referenced by the Dockerfiles or by main.ts.
//
// A server started this way has NO SIM PEER, so it cannot exercise actor authority. Any
// scenario that needs a peer must stand one up itself (TestClient.simPeer does exactly this).
//
//   node dist/testhost.mjs --data <dir> --port <n> [--max-players N]
//
// Prints "testhost: listening on <port>" once healthy, so a harness can wait on the line
// rather than polling.

import { parseArgs } from 'node:util';
import { startServer } from './server';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    'max-players': { type: 'string' },
    'conns-per-ip': { type: 'string' },
    'metrics-token': { type: 'string' },
    // THE GATEWAY PASSES THESE. It spawns every world with --shared (and --gateway), and
    // parseArgs THROWS on an unknown option — so each world this harness's gateway started
    // died instantly with ERR_PARSE_ARGS_UNKNOWN_OPTION, backed off, and died again. The
    // world list stayed empty forever and every gateway scenario failed on a downstream
    // assertion with no hint of the cause, because the gateway's own output was discarded.
    // These must mirror main.ts or a spawned world cannot start at all.
    shared: { type: 'string' },
    gateway: { type: 'string' },
    // A SERVER PASSWORD, so a scenario can stand up its own sim peer.
    //
    // `system` is client-declared, so connection.ts only believes it when the claim carries the
    // server password — and an UNSET password is not permission, it means no peer can
    // authenticate at all. testhost set none, so no browser scenario could ever produce an
    // authority holder. Since `canSimulate` became `p.system === true` (only the peer may hold a
    // cell), that quietly made s40-npc, s41-authority-handoff, s42-crowded-cell and
    // s51-npc-combat unpassable: they assert a CLIENT holds authority, which cannot happen now,
    // and with no peer available nothing holds it either. Nobody noticed because the wasm engine
    // did not build, so the browser suite had not run.
    //
    // Harness-only, like the rest of this entry point: main.ts and the Dockerfiles never read it.
    'server-password': { type: 'string' },
  },
});

const dataDir = values.data;
if (!dataDir) throw new Error('--data <dir> is required');

const maxPlayers = Number(values['max-players'] ?? 64);
// Every harness client dials from 127.0.0.1, so the production per-IP caps (3 connections,
// 5 logins/min) would refuse the fleet before a single assertion ran. Those limits have their
// own tests; here they would only measure themselves.
const connsPerIp = Number(values['conns-per-ip'] ?? maxPlayers * 4 + 8);

const server = await startServer({
  requireGameData: false,
  dataDir,
  port: Number(values.port ?? 0),
  host: '127.0.0.1',
  ...(values.shared ? { sharedDir: values.shared } : {}),
  configOverride: {
    server: { maxPlayers, ...(values['server-password'] ? { password: values['server-password'] } : {}) },
    // Without this a spawned world has no world browser, so it can neither list nor switch.
    ...(values.gateway ? { gateway: { url: values.gateway } } : {}),
    limits: { maxConnsPerIp: connsPerIp, loginPerMinPerIp: 100000 },
    ...(values['metrics-token']
      ? { metrics: { enabled: true, token: values['metrics-token'] } }
      : {}),
  } as never,
});

console.log(`testhost: listening on ${server.port}`);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
