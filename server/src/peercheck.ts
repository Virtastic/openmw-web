// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// CAN A SIM PEER ACTUALLY START ON THIS BOX? Spawns one through the PRODUCTION supervisor and
// reports whether it lives, then stops it.
//
// This exists because 1.3.3 shipped a peer that could not start at all: after the entrypoint
// dropped privileges it still inherited HOME=/root, OpenMW resolves its user data path from
// HOME before reading a line of config, and it died with "Permission denied" and respawned in
// a loop. Every health gate stayed green -- the container answered /healthz, the protocol
// handshake completed, the edge upgraded to a websocket -- while every player who joined sat
// on "waiting for the world to be simulated" for ever with no NPCs, because a cell only gets
// an authority holder when a peer takes it.
//
// The deploy probe cannot see this. A peer is spawned for an OCCUPIED CELL, and the probe is
// refused BAD_CONTENT by design (an empty manifest), so it never occupies one and no peer ever
// spawns for it. Getting a probe past that means an account, a matching content manifest and
// an engine hash -- a great deal of machinery to answer one question.
//
// So this asks the question directly, through SimPeerSupervisor itself rather than a copy of
// it: the same env, the same argv, the same config file, the same start timeout. If the spawn
// path is broken, this is broken in exactly the same way. It needs no world, no account, no
// content and no player.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimPeerSupervisor, peerAccountName } from './core/simpeer';
import { detectGameData, findPeerBinary, gameDataDir } from './core/gamedata';
import { loadConfig } from './config';

const arg = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const dataDir = arg('data') ?? process.env.OMW_DATA_DIR ?? '/data';
const waitMs = Number(arg('timeout') ?? 120_000);

function say(ok: boolean, event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ok, ...detail })}\n`);
}

async function main(): Promise<number> {
  const config = loadConfig(dataDir);
  // RESOLVE IT THE WAY startServer DOES, and do not read config.simPeer.enabled: the parser
  // hardcodes that to false and says so -- "resolved in startServer once the game data has
  // been inspected" -- so a check gated on it reports "nothing to test" on every box in the
  // world, for ever. I wrote exactly that and it passed against a machine whose peer I had
  // watched start ten minutes earlier, which is the same false-signal mistake this whole
  // gate exists to stop.
  const gdDir = gameDataDir(dataDir);
  const gameData = detectGameData(gdDir);
  const binary = findPeerBinary(config.simPeer.binary);
  if (!gameData.ok || !binary) {
    // Genuinely nothing to simulate: no game data, or no headless binary in this image. A
    // valid deployment, reported as its own outcome rather than as a pass.
    say(true, 'peercheck.not_applicable', {
      why: !gameData.ok ? `no game data in ${gdDir}: ${gameData.reason}` : 'no headless openmw binary',
    });
    return 0;
  }

  // Its own scratch dirs, removed on the way out. The real supervisor writes into the world's
  // directory; borrowing that would leave a peer-config folder in a live world.
  const configDir = mkdtempSync(join(tmpdir(), 'omw-peercheck-cfg-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'omw-peercheck-usr-'));
  let output = '';
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const sup = new SimPeerSupervisor({
    settings: { ...config.simPeer, enabled: true, binary, configDir, userDataDir, maxPeers: 1 },
    // NOTHING TO DIAL, ON PURPOSE, and the exit code is what separates the two outcomes.
    //
    // A healthy peer with no server to reach starts, finds nobody, and exits CLEANLY (code 0);
    // measured here at ~500ms. The 1.3.3 failure exited 1 with "Fatal error: filesystem error:
    // status: Permission denied" before it ever opened a socket. So a clean exit is a peer
    // that got far enough to try, and a non-zero one is a peer that could not start -- which
    // is the question, and it needs no server, account or content to answer.
    //
    // An earlier version of this file asserted "the process is still alive after 8 seconds",
    // which fails on every healthy box for exactly the reason above.
    wsUrl: () => 'ws://127.0.0.1:1/ws',
    password: config.server.password,
    // The supervisor still builds the env and the argv -- that is the code under test. This
    // only watches: without it the peer's own fatal goes to the server log this process does
    // not have, and the failure would be a bare exit code with no cause attached.
    spawner: (key, env, args) => {
      const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const grab = (b: Buffer): void => { output += String(b); };
      child.stdout?.on('data', grab);
      child.stderr?.on('data', grab);
      child.on('exit', (code, signal) => { exit = { code, signal }; });
      return child;
    },
  });

  const key = 'peercheck';
  sup.ensure(key);
  const account = peerAccountName(key);

  const started = Date.now();
  const deadline = started + waitMs;
  while (exit === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const aliveMs = Date.now() - started;
  sup.markIdle(key);
  sup.sweep();
  try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }

  // No regex literal, and no backslash escape: core/simpeer.ts carries the same note for the
  // same reason -- an escape in these files has been eaten by tooling repeatedly, and a
  // silently broken pattern in a health check is worse than no health check.
  const fatal = output.split(String.fromCharCode(10)).find((l) => l.includes('Fatal error'));
  if (exit === undefined) {
    // Still running at the deadline. Not a failure -- it plainly started -- but say so rather
    // than calling it a clean start it never demonstrated.
    say(true, 'peercheck.ok', { account, aliveMs, binary, note: 'still running at the deadline' });
    return 0;
  }
  if (exit.code !== 0 || fatal) {
    say(false, 'peercheck.failed', {
      account, aliveMs, exitCode: exit.code, signal: exit.signal,
      ...(fatal ? { fatal } : {}),
      why: 'the sim peer could not start; a world on this box would never be simulated',
    });
    return 1;
  }
  say(true, 'peercheck.ok', {
    account, aliveMs, exitCode: exit.code, binary,
    note: 'started, found no server to dial, and exited cleanly -- which is the expected shape here',
  });
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  say(false, 'peercheck.error', { error: String(err) });
  process.exit(1);
});
