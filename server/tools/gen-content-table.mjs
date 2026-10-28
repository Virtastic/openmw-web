// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Write the `items` list of <sharedDir>/content-table.json: every carryable item record id in
// the content files you give it. With it present the server drops inventory entries naming an
// id no content defines (core/content-table.ts isKnownItem). Other keys in an existing table
// are kept.
//
// OT3-9 also writes `spells` (id -> the record's largest magnitude and duration: the server
// refuses unknown spellbook ids and caps a CombatSpellHit at its record), `races` and `classes`
// (the chargen ceiling the server clamps a finished character to). A later file's record
// replaces an earlier one's, as the engine's load order does.
//
// Run it over EVERY content file the deployment loads (masters and mods): an item a mod adds
// that is missing here is dropped from that player's saved inventory.
//
// Usage:
//   node server/tools/gen-content-table.mjs --out <sharedDir>/content-table.json \
//        "/path/Data Files/Morrowind.esm" ".../Tribunal.esm" ".../Bloodmoon.esm" [mods...]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ITEM_TYPES = new Set(['WEAP', 'ARMO', 'CLOT', 'MISC', 'BOOK', 'ALCH', 'INGR', 'APPA', 'LOCK', 'PROB', 'REPA', 'LIGH']);
// OpenMW Lua's ids, in ESM index order.
const ATTRS = ['strength', 'intelligence', 'willpower', 'agility', 'speed', 'endurance', 'personality', 'luck'];
const SKILLS = ['block', 'armorer', 'mediumarmor', 'heavyarmor', 'bluntweapon', 'longblade', 'axe', 'spear', 'athletics',
  'enchant', 'destruction', 'alteration', 'illusion', 'conjuration', 'mysticism', 'restoration', 'alchemy', 'unarmored',
  'security', 'sneak', 'acrobatics', 'lightarmor', 'shortblade', 'marksman', 'mercantile', 'speechcraft', 'handtohand'];

const items = new Set();
const spells = {};
const races = {};
const classes = {};

function scan(path) {
  const b = readFileSync(path);
  if (b.toString('latin1', 0, 4) !== 'TES3') throw new Error(`${path}: not a TES3 file`);
  let n = 0;
  // Record: type(4) size(4) unused(4) flags(4), then `size` bytes of subrecords name(4) len(4) data.
  for (let p = 0; p + 16 <= b.length;) {
    const type = b.toString('latin1', p, p + 4);
    const end = p + 16 + b.readUInt32LE(p + 4);
    if (ITEM_TYPES.has(type) || type === 'SPEL' || type === 'RACE' || type === 'CLAS') {
      let id = '';
      const subs = [];
      for (let q = p + 16; q + 8 <= end;) {
        const name = b.toString('latin1', q, q + 4), len = b.readUInt32LE(q + 4);
        if (name === 'NAME') id = b.toString('latin1', q + 8, q + 8 + len).replace(/\0.*$/s, '').toLowerCase();
        else subs.push([name, q + 8]);
        q += 8 + len;
      }
      if (id) {
        n++;
        const sub = (s) => subs.find(([k]) => k === s)?.[1];
        if (ITEM_TYPES.has(type)) items.add(id);
        else if (type === 'SPEL') {
          // ENAM: effect i16, skill i8, attr i8, range i32, area i32, duration i32, magMin i32, magMax i32.
          let mag = 0, dur = 0;
          for (const [s, o] of subs) if (s === 'ENAM') { dur = Math.max(dur, b.readInt32LE(o + 12)); mag = Math.max(mag, b.readInt32LE(o + 20)); }
          spells[id] = { mag, dur };
        } else if (type === 'RACE') {
          // RADT: 7 x (skill i32, bonus i32), 8 x (male i32, female i32), then height/weight/flags.
          const o = sub('RADT');
          if (o !== undefined) {
            const skills = {}, male = {}, female = {};
            for (let i = 0; i < 7; i++) { const s = SKILLS[b.readInt32LE(o + i * 8)]; if (s) skills[s] = b.readInt32LE(o + i * 8 + 4); }
            ATTRS.forEach((a, i) => { male[a] = b.readInt32LE(o + 56 + i * 8); female[a] = b.readInt32LE(o + 60 + i * 8); });
            races[id] = { male, female, skills };
          }
        } else {
          // CLDT: 2 attrs i32, specialization i32, 5 x (minor i32, major i32), playable, services.
          const o = sub('CLDT');
          if (o !== undefined) {
            const minor = [], major = [];
            for (let i = 0; i < 5; i++) { minor.push(SKILLS[b.readInt32LE(o + 12 + i * 8)]); major.push(SKILLS[b.readInt32LE(o + 16 + i * 8)]); }
            classes[id] = { attributes: [ATTRS[b.readInt32LE(o)], ATTRS[b.readInt32LE(o + 4)]], specialization: b.readInt32LE(o + 8), major, minor };
          }
        }
      }
    }
    p = end;
  }
  return n;
}

const args = process.argv.slice(2);
const o = args.indexOf('--out');
if (o === -1 || !args[o + 1]) { console.error('usage: gen-content-table.mjs --out <file> <content files...>'); process.exit(2); }
const out = args[o + 1];
const files = args.filter((_, i) => i !== o && i !== o + 1);
if (files.length === 0) { console.error('no content files given'); process.exit(2); }

for (const f of files) console.log(`${f}: ${scan(f)} records`);
const doc = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
Object.assign(doc, { items: [...items].sort(), spells, races, classes });
writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
console.log(`${out}: ${doc.items.length} items, ${Object.keys(spells).length} spells, ${Object.keys(races).length} races, ${Object.keys(classes).length} classes`);
