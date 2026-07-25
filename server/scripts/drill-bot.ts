// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Protocol half of the restore drill (scripts/restore-drill.sh). Uses the same omw-mp/1
// client the test suite uses, so what it proves about a restored data dir is exactly what a
// real client would experience.
//
//   tsx scripts/drill-bot.ts seed   <port>   -> create the account + the known state
//   tsx scripts/drill-bot.ts verify <port>   -> assert that state came back after a restore
//
// Exits nonzero with a reason on stderr on any mismatch: the shell script gates on it.

import { TestClient } from '../test/helpers';

export const DRILL_ACCOUNT = 'RestoreDrill';
export const DRILL_PASSWORD = 'drill-pass-2026';
export const DRILL_CELL = 'drill-cell-9,9';
export const DRILL_POS = { x: 4242, y: -1337, z: 99 };
export const DRILL_APPEARANCE = {
  race: 'dunmer',
  head: 'b_n_dunmer_m_head_01',
  hair: 'b_n_dunmer_m_hair_01',
  class: 'acrobat',
  name: 'Drill Subject',
  isMale: true,
};
export const DRILL_CHAT = 'restore-drill marker line';

function die(msg: string): never {
  console.error(`restore-drill FAIL: ${msg}`);
  process.exit(1);
}

function want(cond: boolean, msg: string): void {
  if (!cond) die(msg);
}

async function seed(port: number): Promise<void> {
  const c = await TestClient.connect(port);
  const { welcome } = await c.joinAsNew(DRILL_ACCOUNT, DRILL_PASSWORD);
  want(typeof welcome['playerId'] === 'number', 'no playerId in SessionWelcome');
  await c.waitEvent('PlayerList');
  // Appearance is what makes the stored doc a real character rather than a position stub —
  // and only a doc WITH an appearance comes back in SessionWelcome.playerRecord, which is
  // what makes the restore verifiable over the protocol instead of by reading files.
  c.sendEvent('PlayerAppearance', DRILL_APPEARANCE);
  await c.waitEvent('PlayerAppearance');
  c.sendCellChange(DRILL_CELL, DRILL_POS.x, DRILL_POS.y, DRILL_POS.z);
  await c.waitEvent('WorldCellState');
  // Exercise the A4 chat log too: the backup has to carry the moderation trail, not just
  // the character.
  c.sendEvent('ChatSend', { text: DRILL_CHAT });
  await c.waitEvent('ChatMessage', (v) => (v as { text: string }).text === DRILL_CHAT);
  c.close();
  await c.closed;
  console.log(`seeded: account=${DRILL_ACCOUNT} cell=${DRILL_CELL} pos=${DRILL_POS.x},${DRILL_POS.y},${DRILL_POS.z}`);
}

async function verify(port: number): Promise<void> {
  const c = await TestClient.connect(port);
  c.hello();
  await c.waitJson('SessionHelloOk');
  c.login(DRILL_ACCOUNT, DRILL_PASSWORD);
  const welcome = await c.waitJson('SessionWelcome'); // a wrong password would disconnect here
  const record = welcome['playerRecord'] as
    | { appearance?: Record<string, unknown>; position?: Record<string, unknown> }
    | null;
  want(record !== null && record !== undefined, 'playerRecord is null — the character document did not survive');
  want(
    record!.appearance?.['name'] === DRILL_APPEARANCE.name,
    `appearance.name = ${JSON.stringify(record!.appearance?.['name'])}, want ${JSON.stringify(DRILL_APPEARANCE.name)}`,
  );
  const pos = record!.position ?? {};
  want(pos['cellKey'] === DRILL_CELL, `position.cellKey = ${JSON.stringify(pos['cellKey'])}, want ${DRILL_CELL}`);
  want(pos['x'] === DRILL_POS.x, `position.x = ${JSON.stringify(pos['x'])}, want ${DRILL_POS.x}`);
  c.sendJson({ t: 'SessionReady' });
  await c.waitEvent('PlayerList');
  c.close();
  await c.closed;
  console.log(`verified: login OK, appearance + position ${DRILL_CELL} @ ${DRILL_POS.x} restored`);
}

const [mode, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`bad port ${portArg}`);
if (mode === 'seed') await seed(port);
else if (mode === 'verify') await verify(port);
else die(`usage: drill-bot.ts seed|verify <port> (got ${mode})`);
