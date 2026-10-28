// OT3-164: who may hurt a story actor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentTable } from '../src/core/content-table';

test('defaults: Fargoth and Caius are story actors nobody may hurt', async () => {
  const t = await ContentTable.load(mkdtempSync(join(tmpdir(), 'ct-')));
  const lic = t.storyLicence([{ id: 7, journal: { a1_1_findspymaster: 10 }, party: [] }]);
  assert.ok(lic.actors.includes('fargoth') && lic.actors.includes('caius cosades'));
  assert.deepEqual(lic.players, { 7: [] }, 'every human listed, licensed for nothing');
});

test('a started kill quest licenses its actor, for the player and their online party', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  writeFileSync(join(dir, 'content-table.json'), JSON.stringify({ storyActors: { 'Dagoth_Ur_1': ['C3_DestroyDagoth'], fargoth: [] } }));
  const t = await ContentTable.load(dir);
  const lic = t.storyLicence([
    { id: 1, journal: { c3_destroydagoth: 5 }, party: [] },
    { id: 2, journal: {}, party: [{ C3_DestroyDagoth: 5 }] },
    { id: 3, journal: { a1_1_findspymaster: 1 }, party: [] },
  ]);
  assert.deepEqual(lic.actors.sort(), ['dagoth_ur_1', 'fargoth']);
  assert.deepEqual(lic.players, { 1: ['dagoth_ur_1'], 2: ['dagoth_ur_1'], 3: [] });
});
