// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// MEASURE WHAT A WORLD ACTUALLY COSTS, against a real gateway with real game data.
//
// [worlds] worldCostMb — the number the memory governor divides by — has until now been a
// figure in a config comment: "node ~330 MB + peer ~450 MB". That estimate decides how many
// players a box admits, so it should not be a guess, and this repo has already published
// capacity numbers that were 10x wrong because they were taken on a loaded machine.
//
//   docker run -d --name omw-cap -p 8080:8080 \
//     -v /path/to/Data Files:/data/gamedata:ro -v <datadir>:/data openmw-simpeer:local
//   npx tsx scripts/measure-capacity.ts --port 8080 --world vvardenfell [--players 2]
//
// It connects real protocol clients (which is what makes the gateway spawn a world and the
// world spawn its peer), waits for the peer to actually take a cell, then reads RSS out of the
// container. HOST LOAD IS PRINTED around every phase: do not quote a number taken on a busy
// box — that is exactly how the 10x-wrong figures happened.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { TestClient } from '../test/helpers';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    world: { type: 'string' },
    players: { type: 'string' },
    container: { type: 'string' },
    'settle-sec': { type: 'string' },
  },
});

const PORT = Number(values.port ?? 8080);
const WORLD = values.world ?? 'vvardenfell';
const PLAYERS = Number(values.players ?? 1);
const CONTAINER = values.container ?? 'omw-cap';
const SETTLE_SEC = Number(values['settle-sec'] ?? 90);

const sh = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch {
    return '';
  }
};

/** RSS per process inside the container, in MB, grouped by what the process IS. */
function rss(): { node: number[]; peer: number[]; totalMb: number } {
  // `ps -eo rss=,comm=,args=` — comm alone says "node" for gateway and world alike, and the
  // difference between them is the whole point, so the full argv is read.
  const out = sh('docker', ['exec', CONTAINER, 'ps', '-eo', 'rss=,args=']);
  const node: number[] = [];
  const peer: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const mb = Number(m[1]) / 1024;
    const argv = m[2]!;
    if (/openmw/.test(argv) && !/node/.test(argv)) peer.push(mb);
    else if (/node/.test(argv)) node.push(mb);
  }
  return { node, peer, totalMb: [...node, ...peer].reduce((a, b) => a + b, 0) };
}

const hostLoad = (): string => {
  const out = sh('docker', ['exec', CONTAINER, 'cat', '/proc/loadavg']);
  return out.trim().split(' ').slice(0, 3).join(' ') || 'unknown';
};

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const fmt = (n: number): string => n.toFixed(0);

async function main(): Promise<void> {
  console.log(`# measuring ${CONTAINER}: world=${WORLD} players=${PLAYERS}`);
  console.log(`# host load before anyone connects: ${hostLoad()}`);
  const before = rss();
  console.log(`  idle: ${before.node.length} node (${fmt(sum(before.node))} MB), `
    + `${before.peer.length} peer (${fmt(sum(before.peer))} MB)`);

  const clients: TestClient[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    // Through the GATEWAY path: production publishes no world ports, so /w/<id> is the only
    // address a client ever has, and measuring any other way measures a setup nobody runs.
    const c = await TestClient.connect(PORT, 'omw-mp.1', `/w/${WORLD}`);
    c.hello();
    await c.waitJson('SessionHelloOk');
    c.register(`capbot${i}`, 'cap-measure-pw-1');
    await c.waitJson('SessionWelcome');
    c.sendJson({ t: 'SessionReady' });
    await c.waitEvent('PlayerList');
    // Spread them so each anchors its own cell — one anchor per occupied cell is what the
    // peer actually pays for, so co-locating everyone would measure the cheapest possible case.
    c.sendCellChange(`${i * 2},0`, 0, 0, 0);
    clients.push(c);
    console.log(`  player ${i + 1}/${PLAYERS} in world`);
  }

  // The peer takes tens of seconds to load retail data before it holds anything. Measuring
  // before that is measuring a process that has not started doing its job.
  console.log(`# waiting up to ${SETTLE_SEC}s for the peer to load and take a cell...`);
  const until = Date.now() + SETTLE_SEC * 1000;
  let settled = false;
  while (Date.now() < until) {
    const now = rss();
    // A peer that has finished loading stops growing; two consecutive samples within 5 MB is
    // the cheap proxy for "done", and the ceiling bounds it either way.
    if (now.peer.length > 0) {
      await new Promise((r) => setTimeout(r, 5000));
      const again = rss();
      if (again.peer.length > 0 && Math.abs(sum(again.peer) - sum(now.peer)) < 5) {
        settled = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const after = rss();
  console.log(`# host load at measurement: ${hostLoad()}`);
  if (!settled) console.log('# WARNING: the peer never settled — treat everything below as a floor');
  console.log('');
  console.log(`  node processes : ${after.node.length}  ${fmt(sum(after.node))} MB`);
  console.log(`  sim peers      : ${after.peer.length}  ${fmt(sum(after.peer))} MB`);
  console.log(`  TOTAL          : ${fmt(after.totalMb)} MB`);
  console.log('');
  // The governor divides by the cost of ONE OCCUPIED WORLD, so report it that way: everything
  // except the gateway's own process, over the number of worlds actually up.
  const worlds = Math.max(1, after.node.length - 1); // minus the gateway itself
  const perWorld = (after.totalMb - (before.node.length > 0 ? sum(before.node) : 0)) / worlds;
  console.log(`  => [worlds] worldCostMb ~= ${fmt(perWorld)}  (over ${worlds} world(s))`);
  console.log('     Re-run on an idle box. Do NOT quote a number taken above roughly load 10.');

  for (const c of clients) c.close();
}

void main().then(() => process.exit(0), (err) => {
  console.error(String(err));
  process.exit(1);
});
