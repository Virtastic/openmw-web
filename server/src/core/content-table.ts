// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3/4 content classification: the one table that answers "what is this record to
// the rules engine". Three questions, one artifact, because they are all derived from the
// same content files and share a lifecycle:
//
//   questItems    items that must NEVER deplete from a container (per-character journals
//                 mean the second player still has to find the Puzzle Box)
//   uniqueActors  named/one-of-a-kind NPCs — in PUBLIC they respawn and drop NOTHING, so
//                 an infinite-respawn world cannot mint artifacts
//   notableItems  artifact/enchanted tier — never spawns in public; drives roll-on-rare
//
// SHIPPED AS DATA, NOT DERIVED AT BOOT. Parsing Morrowind.esm on every world start would
// cost seconds and require the game data to be present on the server, which is exactly
// what a bring-your-own-data deployment does not guarantee. Instead the table is a JSON
// file an operator can regenerate (tools/gen-content-table) and the built-in defaults
// cover vanilla's well-known cases so a fresh install behaves correctly out of the box.
//
// A missing table is not an error: every lookup answers "no", which is precisely vanilla
// behaviour. Rules degrade to permissive, never to broken.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';

interface ContentTableDoc {
  questItems?: string[];
  uniqueActors?: string[];
  notableItems?: string[];
  // Every carryable item record id in the deployment's content (tools/gen-content-table.mjs).
  // Absent = no whitelist: inventory ids are taken as declared, as before.
  items?: string[];
  // OT3-9 (same tool): spell id -> its record's largest magnitude and duration; race base
  // attributes per sex and skill bonuses; class favoured attributes, specialization (0 combat,
  // 1 magic, 2 stealth) and skills. Keys are OpenMW Lua ids. Absent = unchecked, as items.
  spells?: Record<string, { mag: number; dur: number }>;
  races?: Record<string, { male: Record<string, number>; female: Record<string, number>; skills: Record<string, number> }>;
  classes?: Record<string, { attributes: string[]; specialization: number; major: string[]; minor: string[] }>;
}

// ESM skill order; a skill's specialization is index / 9 (combat, magic, stealth).
const SKILLS = ['block', 'armorer', 'mediumarmor', 'heavyarmor', 'bluntweapon', 'longblade', 'axe', 'spear', 'athletics',
  'enchant', 'destruction', 'alteration', 'illusion', 'conjuration', 'mysticism', 'restoration', 'alchemy', 'unarmored',
  'security', 'sneak', 'acrobatics', 'lightarmor', 'shortblade', 'marksman', 'mercantile', 'speechcraft', 'handtohand'];
const SPECS = ['combat', 'magic', 'stealth'];

// What chargen alone can make, for the ceiling check: the stat a character may have when
// creation ends. A custom class arrives as its spec (PlayerAppearanceDoc.classSpec).
export interface ChargenPick {
  race: string;
  isMale: boolean;
  class: string;
  classSpec?: { specialization: string; attributes: string[]; majorSkills: string[]; minorSkills: string[] };
}

// Vanilla defaults. Deliberately small and high-confidence: these are the records the
// community's own TES3MP fix scripts had to special-case, plus the artifact set whose
// duplication would break any shared economy. An operator's table REPLACES a list it
// declares, so a total conversion is never stuck with Vvardenfell's assumptions.
const DEFAULT_QUEST_ITEMS = [
  'dwemer puzzle box', // Arkngthand — the canonical "it was gone for my friend" break
  'bk_ajira1', 'bk_ajira2', // Ajira's stolen reports (Learwolf's questFixes special case)
  'misc_soulgem_azura', // Azura's Star
  'bk_lastscabbard', 'bk_chroniclesofnchuleft',
  'misc_dwrv_ark_cube00', 'misc_dwrv_ark_gear00',
];
const DEFAULT_UNIQUE_ACTORS = [
  'vivec_god', 'almalexia', 'sotha sil', 'dagoth_ur_1', 'dagoth_ur_2',
  'caius cosades', 'divayth fyr', 'yagrum bagarn', 'mehra milo', 'crassius curio',
  'trebonius artorius', 'hasphat antabolis', 'sharn gra-muzgob', 'nibani maesa',
  'sul-matuul', 'wulf', 'azura', 'gilvas barelo', 'king hlaalu helseth',
];
const DEFAULT_NOTABLE_ITEMS = [
  // Artifacts + the daedric quest rewards: one-of-a-kind by design.
  'sunder', 'keening', 'wraithguard', 'ring_azura_unique', 'daedric_crescent_unique',
  'bittercup_unique', 'masque_clavicus_unique', 'ring_khajiit_unique',
  'boots_apostle_unique', 'ebony_mail_unique', 'lords_mail_unique',
  'spear_bitter_unique', 'staff_hasedoki_unique', 'umbra_sword', 'goldbrand',
  'mace_molagbal_unique', 'skull_crusher_unique', 'volendrung_unique',
  'warhammer_crusher_unique', 'fork_horripilation_unique', 'ring_mentor_unique',
  'ring_denstagmer_unique', 'ring_phynaster_unique', 'amulet_usheeja_unique',
  'boots_blind_speed_unique', 'cuirass_savior_unique', 'helm_bearclaw_unique',
  'shield_auriel_unique', 'bow_auriel_unique', 'staff_magnus_unique',
];

export class ContentTable {
  readonly questItems: ReadonlySet<string>;
  readonly uniqueActors: ReadonlySet<string>;
  readonly notableItems: ReadonlySet<string>;
  readonly items: ReadonlySet<string> | undefined;
  private readonly doc: ContentTableDoc;

  private constructor(doc: ContentTableDoc) {
    this.doc = doc;
    const lower = (xs: string[]) => new Set(xs.map((s) => s.toLowerCase()));
    this.questItems = lower(doc.questItems ?? DEFAULT_QUEST_ITEMS);
    this.uniqueActors = lower(doc.uniqueActors ?? DEFAULT_UNIQUE_ACTORS);
    this.notableItems = lower(doc.notableItems ?? DEFAULT_NOTABLE_ITEMS);
    this.items = doc.items ? lower(doc.items) : undefined;
  }

  // An engine-minted record (a brewed potion, an enchanted item: "Generated:0x1", "$dynamic3")
  // has no content id to check, so it always passes.
  isKnownItem(recordId: string): boolean {
    if (!this.items || recordId.startsWith('$') || recordId.startsWith('Generated:')) return true;
    return this.items.has(recordId.toLowerCase());
  }

  // A content spell's bounds; undefined for an id the table does not have (or no table).
  spellBounds(id: string): { mag: number; dur: number } | undefined {
    return this.doc.spells?.[id.toLowerCase()];
  }

  // Engine-minted ids pass, as for items; a custom (spellmaker) record is the RecordStore's to judge.
  isKnownSpell(id: string): boolean {
    if (!this.doc.spells || id.startsWith('$') || id.startsWith('Generated:')) return true;
    return id.toLowerCase() in this.doc.spells;
  }

  // The highest base attributes and skills chargen can produce for this race/sex/class:
  // race base +10 per favoured attribute; skill 5 misc, 15 minor, 30 major, +5 in the class's
  // specialization, plus the race bonus. undefined = race or class unknown (no check).
  // ponytail: birthsigns change no BASE stat in vanilla (theirs are abilities), so none counted.
  chargenCeiling(pick: ChargenPick): { attributes: Record<string, number>; skills: Record<string, number> } | undefined {
    const race = this.doc.races?.[pick.race.toLowerCase()];
    const cls = pick.classSpec
      ? { attributes: pick.classSpec.attributes, specialization: SPECS.indexOf(pick.classSpec.specialization),
          major: pick.classSpec.majorSkills, minor: pick.classSpec.minorSkills }
      : this.doc.classes?.[pick.class.toLowerCase()];
    if (!race || !cls) return undefined;
    const attributes = { ...(pick.isMale ? race.male : race.female) };
    for (const a of cls.attributes) if (attributes[a] !== undefined) attributes[a] = attributes[a]! + 10;
    const skills: Record<string, number> = {};
    SKILLS.forEach((s, i) => {
      const base = cls.major.includes(s) ? 30 : cls.minor.includes(s) ? 15 : 5;
      skills[s] = base + (Math.floor(i / 9) === cls.specialization ? 5 : 0) + (race.skills[s] ?? 0);
    });
    return { attributes, skills };
  }

  isQuestItem(recordId: string): boolean {
    return this.questItems.has(recordId.toLowerCase());
  }

  isUniqueActor(recordId: string): boolean {
    return this.uniqueActors.has(recordId.toLowerCase());
  }

  isNotableItem(recordId: string): boolean {
    return this.notableItems.has(recordId.toLowerCase());
  }

  // <dataDir>/content-table.json, else the vanilla defaults. A malformed file is loud and
  // falls back rather than taking the world down: the rules it feeds are gameplay, not
  // safety, and a world that refuses to boot over a mod list is worse than a permissive one.
  static async load(dataDir: string): Promise<ContentTable> {
    try {
      const raw = await readFile(join(dataDir, 'content-table.json'), 'utf8');
      const doc = JSON.parse(raw) as ContentTableDoc;
      const table = new ContentTable(doc);
      log('info', 'content_table.loaded', {
        questItems: table.questItems.size,
        uniqueActors: table.uniqueActors.size,
        notableItems: table.notableItems.size,
        items: table.items?.size ?? 'unchecked',
        spells: doc.spells ? Object.keys(doc.spells).length : 'unchecked',
        races: doc.races ? Object.keys(doc.races).length : 'unchecked',
      });
      return table;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('error', 'content_table.bad_file', { error: String(err) });
      }
      return new ContentTable({});
    }
  }

  static defaults(): ContentTable {
    return new ContentTable({});
  }
}
