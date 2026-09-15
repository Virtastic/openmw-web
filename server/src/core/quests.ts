// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// M6 quest layer (PROTOCOL.md §M6): shared journal, MWScript globals/locals, factions,
// crime, and the dialogue lock. Sharing is a POLICY decision and lives in the `sharing`
// plugin — this module asks the hook bus per family and only mechanises the arbitration:
//   journal  monotonic-max per questId (regression relayed only via regressAllowlist)
//   globals  last-write-wins with a per-variable seq (stale seq dropped); the M7 time
//            globals are excluded here entirely
//   locals   cell-scoped, stored in the cell doc
// Individual mode stores per-player and never relays.

import { lToJs, type LTable, type LValue, type JsLike } from '../proto/lser';
import { parseObjRef, type ObjRef } from '../proto/ref';
import type { Player, Roster } from './players';
import { INPUT_DRIVING_MS } from './players';
import { cellsVisible } from './movement';
import { cellMapFull, type CellStore, type FactionState } from '../persist/cellstore';
import type { PlayerDoc, PlayerStore } from '../persist/playerstore';
import { daysPassed } from './worldtime';
import { log } from '../log';

const MAX_ID = 64;
const MAX_JOURNAL_LOG = 2000;
const MAX_CELL_KEY = 128;
const MAX_INDEX = 0x7fffffff;

// M7 owns the clock: these never travel as GlobalVarUpdate.
const TIME_GLOBALS = new Set(['gamehour', 'day', 'month', 'year', 'dayspassed']);

// CLIENT-OWNED globals: never stored, never restored. These describe engine-level state the
// client is authoritative over, and GlobalVarSync applies stored values UNCONDITIONALLY —
// there is no monotonicity check, because quest globals legitimately go both ways.
//
// chargenstate is the tutorial's own progress counter, and it counts DOWN to -1 ("creation
// finished"), so no ordering rule can protect it. Storing it meant a rejoin could write an
// older value back over a finished tutorial, and the Census door then correctly refused to
// let the player out: "I gave the item and clicked duties, and it still says I have to do
// it." The client already latches chargen completion on its own (global.lua chargenTick), so
// there is nothing to restore here and everything to break.
const CLIENT_GLOBALS = new Set(['chargenstate']);

// CHARACTER globals: the vampire/werewolf state the vanilla and Bloodmoon scripts keep in
// globals although it describes ONE BODY (GLOB records of Morrowind.esm / Bloodmoon.esm).
// They used to shadow to the CAMPAIGN doc like every other character global, so a guest
// turning vampire made the host a vampire on the host's next login and the peer's dummy a
// werewolf (backlog #151). Persisted to the writer's OWN character doc, relayed to nobody
// (not even the peer), never seeded from the campaign doc.
const CHARACTER_GLOBALS = new Set([
  'pcvampire', 'vampclan', 'vampkills',
  'pcwerewolf', 'pcknownwerewolf', 'pcknownreset',
]);

// Phase 4: mwscript globals split into WORLD-SHARED and CHARACTER-SHADOWED.
//
// Morrowind gates most quests on globals, not on the journal index. With per-character
// journals, relaying every global world-wide makes two party members at different stages
// fight over the same variable through the 1 s diff sync — each client re-asserting its
// own value, forever. So the default is INVERTED from M6: a global is character-shadowed
// (stored on the character, never relayed) unless it describes the WORLD rather than a
// character's progress.
//
// The world-shared set is deliberately small and conservative, because the failure modes
// are asymmetric: wrongly sharing a progress global causes the ping-pong above and can
// skip a player's quest; wrongly shadowing a world global only means it does not
// propagate, which reads as vanilla single-player behaviour. Operators extend it via
// [sharing].worldGlobals for total conversions that keep world state in globals.
const WORLD_GLOBALS = new Set([
  // Weather/environment the whole realm observes.
  'weather', 'nextweather', 'weatherregion', 'currentweather',
  // Blight/ash storm and the Ghostfence — realm-visible world state in vanilla.
  'blightdisease', 'ghostfence', 'gamehourlast',
  // Vampire clock and the werewolf state are per-character despite the naming; NOT here.
]);

// A dialogue topic id is a record id; the cap on how many can arrive at once is generous
// because a single conversation can turn on several, and mean because TES3MP's version of
// this feature is remembered for packet storms.
const MAX_TOPIC_ID = 64;
const MAX_TOPICS_PER_EVENT = 64;

export type ShareFamily = 'journal' | 'questVars' | 'factions' | 'crime' | 'map';

export const QUEST_EVENTS = new Set([
  'JournalEntry',
  'GlobalVarUpdate',
  'MemberVarUpdate',
  'FactionUpdate',
  'CrimeUpdate',
  'DialogueLock',
  'TopicsLearned',
  'GlobalScriptsUpdate',
]);
// A campaign's running global scripts: vanilla plus the expansions start well under a hundred.
const MAX_SCRIPTS = 256;

export interface QuestCtx {
  roster: Roster;
  cells: CellStore;
  players: PlayerStore;
  // Plugin-owned policy: may this family be relayed/shared at all?
  isShared(family: ShareFamily): boolean;
  // Quest ids permitted to regress (operator config, surfaced via the plugin).
  regressAllowed(questId: string): boolean;
  // Which character doc a journal advance is written to, or undefined for "persist nothing".
  // Three cases, all decided in server.ts where world identity lives:
  //   owned instance     -> the OWNER's doc. One log per instance; guests advance the
  //                         campaign they are visiting and keep nothing of their own.
  //   gateway-run public -> undefined. The lobby persists position and nothing else.
  //   standalone server  -> the SENDER's own doc. No owner exists, but this IS the player's
  //                         real game, so vanilla per-character journals apply.
  // Read through a function because the owner may not be connected when an entry arrives.
  journalTarget(player: Player): string | undefined;
  // The OWNER's character doc when this instance is owned, else undefined. Used only to seed
  // a fresh instance's log. Deliberately NOT journalTarget: on a standalone server that
  // returns the sender's own doc for everyone, and seeding from it would inject the first
  // joiner's history into the shared log the rest of the server then adopts.
  ownerCharId(): string | undefined;
  // Operator additions to the world-shared global set (total conversions).
  worldGlobals?: string[];
  worldPeer?(): Player | undefined;
  // Who simulates a cell (worldstate.ts): the holder hears its cells wherever it stands.
  holderOf?(cellKey: string): number | undefined;
}

type JournalLogEntry = NonNullable<PlayerDoc['journalLog']>[number];

function tbl(v: LValue | undefined): LTable | undefined {
  return v instanceof Map ? v : undefined;
}

function str(v: LValue | undefined, max = MAX_ID): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

function finite(v: LValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function index(v: LValue | undefined): number | undefined {
  const n = finite(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= MAX_INDEX ? n : undefined;
}

export class Quests {
  // refKey -> the player currently holding the conversation, plus where it started.
  private dialogueLocks = new Map<string, { playerId: number; cellKey: string }>();

  constructor(private readonly ctx: QuestCtx) {}

  private drop(player: Player, name: string, why: string): void {
    log('warn', 'quest.dropped', { from: player.name, name, why });
  }

  // Relays exclude the sender: it already applied the change locally, and clients seed
  // their diff caches from applied state (the §M6 echo guard).
  private relayAll(exceptId: number, name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) if (p.id !== exceptId) p.peer.sendEvent(name, body);
  }

  // The same predicate as worldstate.ts hears(): the holder anchors far cells while its own
  // avatar stands elsewhere, and an NPC's locals written in one of them must reach the
  // engine that runs that NPC's script (backlog 222).
  private relayCell(cellKey: string, exceptId: number, name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id === exceptId) continue;
      if (cellsVisible(p.cellKey, cellKey) || (p.system === true && this.ctx.holderOf?.(cellKey) === p.id)) p.peer.sendEvent(name, body);
    }
  }

  handleEvent(player: Player, name: string, value: LValue | undefined): boolean {
    if (!QUEST_EVENTS.has(name)) return false;
    const body = tbl(value);
    if (!body) {
      this.drop(player, name, 'malformed body');
      return true;
    }
    switch (name) {
      case 'JournalEntry': this.journal(player, body); break;
      case 'GlobalVarUpdate': this.globalVar(player, body); break;
      case 'MemberVarUpdate': this.memberVar(player, body); break;
      case 'FactionUpdate': this.faction(player, body); break;
      case 'CrimeUpdate': this.crime(player, body); break;
      case 'TopicsLearned': this.topics(player, body); break;
      case 'DialogueLock': this.dialogueLock(player, body); break;
      case 'GlobalScriptsUpdate': this.scripts(player, body); break;
    }
    return true;
  }

  // ---------------------------------------------------------------- global scripts

  // RUNNING GLOBAL SCRIPTS ARE CAMPAIGN STATE (backlog 219). Sleepers, VampireCheck and
  // MoveMehra are started once by a script and expected to run for the rest of the game; the
  // engine here starts every session with nothing running, so a relog silently ended them.
  // A diff, not a list: two engines (the host and the peer) each report what they run, and
  // a full list from one would erase what the other started. Stopped is honoured too --
  // scripts end themselves (StopScript) and a stale entry would restart them every join.
  private scripts(player: Player, body: LTable): void {
    const ids = (v: LValue | undefined): string[] | undefined => {
      if (v === undefined) return [];
      if (!(v instanceof Map) || v.size > MAX_SCRIPTS) return undefined;
      const out: string[] = [];
      for (const [, id] of v) {
        const s = str(id);
        if (!s) return undefined;
        out.push(s.toLowerCase());
      }
      return out;
    };
    const started = ids(body.get('started')), stopped = ids(body.get('stopped'));
    if (!started || !stopped || (started.length === 0 && stopped.length === 0)) {
      this.drop(player, 'GlobalScriptsUpdate', 'invalid shape');
      return;
    }
    const target = this.ctx.journalTarget(player);
    if (target === undefined) return; // the shared world persists no campaign
    this.ctx.players.update(target, (doc) => {
      const set = new Set(doc.scripts ?? []);
      for (const s of stopped) set.delete(s);
      for (const s of started) set.add(s);
      doc.scripts = [...set].slice(0, MAX_SCRIPTS);
    });
  }

  sendScriptsSync(player: Player): void {
    const source = this.ctx.journalTarget(player);
    const running = source === undefined ? [] : (this.ctx.players.getCached(source)?.scripts ?? []);
    if (running.length === 0) return;
    player.peer.sendEvent('GlobalScriptsSync', { running: [...running] });
  }

  // ---------------------------------------------------------------- journal

  private journal(player: Player, body: LTable): void {
    const questId = str(body.get('questId'));
    const idx = index(body.get('index'));
    const actorRefId = body.get('actorRefId');
    if (!questId || idx === undefined || (actorRefId !== undefined && !str(actorRefId))) {
      this.drop(player, 'JournalEntry', 'invalid shape');
      return;
    }
    // ONE LOG PER INSTANCE, AND IT BELONGS TO THE OWNER.
    //
    // A guest advances the campaign they are visiting and keeps no QUEST STATE of their own:
    // an evening in a friend's world cannot move — or spoil — their own story. In your own
    // Solo world you ARE the owner, so this is the same rule, not a special case. An unowned
    // instance (the shared world) persists nothing, so entries there move the live map and no
    // character at all.
    //
    // "THEIR CHARACTER DOC IS UNTOUCHED FOR THE WHOLE VISIT" is what this used to say, and it
    // is not true — only the quest half is. Inventory, stats, skills, level, spells and
    // equipment all write to the GUEST's own charId (core/playerstate.ts), which is
    // deliberate: Morrowind progression is use-based, so a guest's Long Blade rose because
    // they swung it, and taking that away would make helping a friend pure charity. What is
    // frozen is the quest system, in BOTH halves — journal here, globals/factions/bounty
    // below — because those are what a campaign IS.
    //
    // So the honest one-liner is: a guest keeps what they carry out and what they learned;
    // the quest log belongs to the world's owner.
    //
    // The doc write happens AFTER arbitration, never before: writing first let a stale
    // client put 20 into the owner's save while the instance log correctly kept 40, and the
    // two then disagreed permanently.
    // STANDALONE: the same rule the globals half uses. journalTarget(peer) on an owner-less
    // stack resolves to the peer's own ephemeral doc, so a peer-advanced journal entry was
    // relayed live and then lost -- leaving globals saying "done" and the journal saying
    // stage 10, the exact split the comment above forbids. Persist to every human instead.
    if (player.system === true && this.ctx.ownerCharId() === undefined) {
      for (const h of this.ctx.roster.humansInWorld().filter((q) => !q.bot)) {
        this.ctx.players.update(h.charId, (doc) => {
          const log = (doc.journal ??= {});
          if ((log[questId] ?? -1) < idx) log[questId] = idx;
          this.logEntry(doc, questId, idx);
        });
      }
      this.relayAll(player.id, 'JournalEntry', { questId, index: idx });
      return;
    }
    const ownerChar = this.ctx.journalTarget(player);
    // Phase 3.7: journal advances flush AT THE WRITE, not on the 45 s sweep. A verified
    // TES3MP failure is a disconnect mid-quest permanently corrupting progression
    // (Tribunal MQ, issue #268 — open since 2017): the stage was in memory and the crash
    // took it. A quest step a player has earned must survive the next instant.
    const record = (): void => {
      if (ownerChar === undefined) return;
      this.ctx.players.update(ownerChar, (doc) => {
        (doc.journal ??= {})[questId] = idx;
        this.logEntry(doc, questId, idx);
      }, 'now');
    };
    if (!this.ctx.isShared('journal')) { record(); return; } // individual mode: never relayed

    const shared = this.ctx.cells.sharedQuest();
    const current = shared.journal[questId];
    const advances = current === undefined || idx > current;
    const regressing = !advances && idx < current;
    // THE CAMPAIGN'S OWNER MAY RESTART A QUEST. Monotonic-max was written against a LAGGING
    // client, and a guest still cannot rewind the log -- but a SetJournalIndex to a lower
    // stage from the owner's own dialogue, or from the peer's scripts, is the campaign
    // itself moving (backlog 225). Dropped, it came back on the next login and every later
    // advance below the old maximum was silently lost too.
    const authoritative = player.system === true
      || (this.ctx.ownerCharId() !== undefined && this.ctx.ownerCharId() === player.charId);
    if (regressing && !authoritative && !this.ctx.regressAllowed(questId)) {
      // Monotonic-max arbitration: a lagging client cannot rewind the instance's campaign.
      log('debug', 'quest.journal_regress_blocked', { questId, have: current, got: idx, from: player.name });
      return;
    }
    if (!advances && !regressing) return; // identical index: nothing to do
    shared.journal[questId] = idx;
    this.ctx.cells.saveShared();
    record();
    const out: JsLike = { questId, index: idx, ...(typeof actorRefId === 'string' ? { actorRefId } : {}) };
    this.relayAll(player.id, 'JournalEntry', out);
  }

  // Backlog 257: the dated, ordered log behind the questId->index map. One line per entry
  // the engine would keep (Journal::addEntry ignores a repeat of the same stage).
  private logEntry(doc: { journalLog?: JournalLogEntry[] }, q: string, i: number): void {
    const t = this.ctx.cells.worldM7().time;
    const logList = (doc.journalLog ??= []);
    if (logList.some((e) => e.q === q && e.i === i)) return;
    logList.push({ q, i, d: daysPassed(t), m: t.month, dm: t.day });
    if (logList.length > MAX_JOURNAL_LOG) logList.splice(0, logList.length - MAX_JOURNAL_LOG);
  }

  // creditParty lived here and is GONE. It advanced co-present party members' OWN journals,
  // which the instance-owned model forbids outright: a guest keeps nothing from a visit. Two
  // systems advancing journals is how they end up disagreeing, so it is deleted rather than
  // left switched off next to the new path.

  // Full journal state for a joining client: the shared map, or their own in individual
  // mode. Always sent (an empty map is a valid, meaningful answer).
  // The bounty this world holds the player to, at join (players.ts `bounty` says why it is
  // not the doc's): the party's one record when crime is shared, else the player's own
  // (backlog 147: personal crime seeded a guest with the HOST's bounty; crime() below
  // only ever writes a personal bounty to the player's own doc, so read it from there).
  seedBounty(player: Player): void {
    if (this.ctx.isShared('crime')) {
      player.bounty = this.ctx.cells.sharedQuest().bounty ?? 0;
      return;
    }
    player.bounty = this.ctx.players.getCached(player.charId)?.bounty ?? 0;
  }

  // Backlog 141: the faction ranks a GUEST arrives with. With factions shared, a guest's
  // join/promotion is written to the host's doc and shared.factions (faction() below), but
  // the welcome record came from the guest's own doc: they arrived with their HOME ranks and
  // a relog lost the rank earned here. Host doc first (the persisted campaign), shared map
  // over it (what changed here). undefined = keep the player's own doc.
  guestFactions(player: Player): Record<string, FactionState> | undefined {
    const owner = this.ctx.ownerCharId();
    if (!this.ctx.isShared('factions') || owner === undefined || owner === player.charId) return undefined;
    return { ...(this.ctx.players.getCached(owner)?.factions ?? {}), ...this.ctx.cells.sharedQuest().factions };
  }

  sendJournalSync(player: Player): void {
    this.seedBounty(player);
    if (this.ctx.isShared('journal')) {
      const shared = this.ctx.cells.sharedQuest();
      // Seed a FRESH instance from the owner's campaign. Their world's cell store starts
      // empty, so without this the owner would arrive in their own world to a blank journal
      // and every guest would adopt that blank. Only ever seeds an empty map, so it cannot
      // overwrite progress made here.
      const ownerChar = this.ctx.ownerCharId();
      if (ownerChar !== undefined && player.charId === ownerChar
        && Object.keys(shared.journal).length === 0) {
        const own = this.ctx.players.getCached(ownerChar)?.journal;
        if (own && Object.keys(own).length > 0) {
          Object.assign(shared.journal, own);
          this.ctx.cells.saveShared();
          log('info', 'quest.journal_seeded', { from: ownerChar, quests: Object.keys(own).length });
        }
      }
    }
    // Everyone in the instance reads the SAME log — the owner's. A guest is shown the
    // campaign they are visiting; nothing here touches their own character doc.
    const quests = this.ctx.isShared('journal')
      ? { ...this.ctx.cells.sharedQuest().journal }
      : { ...(this.ctx.players.getCached(player.charId)?.journal ?? {}) };
    // The dated log lives on the doc the entries were recorded to (journalTarget), in order.
    const logChar = this.ctx.journalTarget(player);
    const journalLog = (logChar === undefined ? [] : (this.ctx.players.getCached(logChar)?.journalLog ?? []))
      .map((e) => ({ ...e }));
    // BORROWED: this sync carries a campaign that is not this character's own, so the client
    // must set its own journal aside for the visit and put it back on the way home. The
    // client cannot work this out for itself — it does not know who owns the instance.
    // Driving it off the sync (rather than a "leaving" event) makes it self-correcting: this
    // message is sent on EVERY join, so a missed transition repairs itself on the next one.
    const owner = this.ctx.ownerCharId();
    const borrowed = owner !== undefined && owner !== player.charId;
    player.peer.sendEvent('JournalSync', { quests, borrowed, journalLog });
  }

  // ---------------------------------------------------------------- globals

  // Phase 4E: WHO OWNS AN MWSCRIPT WRITE. Under the one-peer model the peer runs every cell
  // script authoritatively -- but each client's engine runs its LOCAL COPY of the same
  // scripts on the same (puppeted) actors, so the same global or member variable gets
  // written twice, and character globals were last-writer-wins. The peer's write wins: a
  // client write to a name the peer wrote within INPUT_DRIVING_MS is dropped. Names the
  // peer never writes (dialogue-result scripts run only on the client that talked) are
  // untouched, so dialogue-driven quest state stays exactly as it was.
  private peerGlobalAt = new Map<string, number>();
  private peerMemberAt = new Map<string, number>();

  private globalVar(player: Player, body: LTable): void {
    const name = str(body.get('name'));
    const value = finite(body.get('value'));
    const rawSeq = body.get('seq');
    const seq = rawSeq === undefined ? undefined : finite(rawSeq);
    if (!name || value === undefined || (rawSeq !== undefined && seq === undefined)) {
      this.drop(player, 'GlobalVarUpdate', 'invalid shape');
      return;
    }
    const lower = name.toLowerCase();
    if (TIME_GLOBALS.has(lower)) {
      // M7 owns the clock; accepting these here would fight WorldTime.
      log('debug', 'quest.time_global_dropped', { name, from: player.name });
      return;
    }
    if (CLIENT_GLOBALS.has(lower)) {
      log('debug', 'quest.client_global_dropped', { name, from: player.name });
      return;
    }
    if (CHARACTER_GLOBALS.has(lower)) {
      // One body's state: the writer's own doc, nobody else's, and nobody told. The peer's
      // dummy and a bot have no character to keep it for.
      if (player.system !== true && player.bot !== true) {
        this.ctx.players.update(player.charId, (doc) => { (doc.globals ??= {})[name] = value; });
      }
      return;
    }
    // Phase 4: character-shadowed globals are the DEFAULT, and shadowing is PERSISTENCE,
    // not relaying — so it happens whatever the questVars sharing policy says. Store on
    // the character (a rejoin or world hop restores the player's own quest state) and
    // relay to nobody: relaying is what makes two party members at different stages
    // overwrite each other forever.
    const nowMs = Date.now();
    if (player.system === true) {
      this.peerGlobalAt.set(lower, nowMs);
    } else {
      const at = this.peerGlobalAt.get(lower);
      if (at !== undefined && nowMs - at <= INPUT_DRIVING_MS) {
        log('debug', 'quest.global_peer_owned', { name, from: player.name });
        return;
      }
    }
    if (!this.isWorldGlobal(lower)) {
      // The SAME target as the journal, and for the same reason. Morrowind gates most quests
      // on globals rather than the journal index (see above), so shadowing these to the guest
      // while the journal went to the owner advanced a guest's GATES without their log: they
      // went home with globals saying "done" and a journal saying stage 10, which can leave
      // a quest ungiveable or unfinishable in their own campaign. A guest's campaign is
      // frozen in BOTH halves of the quest system or in neither.
      // STANDALONE PERSISTENCE. journalTarget(peer) is the owner's campaign in an owned
      // world -- correct. On a STANDALONE stack (no owner) it resolves to the peer's own
      // ephemeral doc, so every quest global the peer's scripts advanced was relayed live
      // and then lost on relog. Every human in the world got the relay, so every human's
      // doc is the campaign: persist to all of them and return.
      if (player.system === true && this.ctx.ownerCharId() === undefined) {
        // Humans only -- a bot's doc is not a campaign. (The journal half still routes
        // through journalTarget and is lost on an owner-less stack; globals and journal
        // should freeze together, so this is the honest half-fix until standalone gets a
        // campaign doc of its own. Recorded in the audit doc.)
        for (const h of this.ctx.roster.humansInWorld().filter((q) => !q.bot)) {
          this.ctx.players.update(h.charId, (doc) => { (doc.globals ??= {})[name] = value; });
        }
        this.relayAll(player.id, 'GlobalVarUpdate', { name, value });
        return;
      }
      const target = this.ctx.journalTarget(player);
      // Phase 4E: the peer's write is the campaign's authoritative state, so every client
      // in the world receives it LIVE (their local script copies would otherwise hold a
      // stale value until the next login's GlobalVarSync). Relayed even where nothing
      // persists (standalone stack, owner offline) -- live sync and campaign persistence
      // are different jobs.
      //
      // A HUMAN'S write goes the same way (backlog 224). It used to reach the peer only,
      // "to keep one player's dialogue from moving another's engine" -- but there is ONE
      // campaign per instance, the other human's journal already advanced with it, and the
      // guest's Global filters and local script copies sat on the stale value until relog.
      // The ping-pong the old rule feared is what the peer-owned window above is for.
      this.relayAll(player.id, 'GlobalVarUpdate', { name, value });
      if (target === undefined) return; // unowned instance: persists nothing
      this.ctx.players.update(target, (doc) => {
        (doc.globals ??= {})[name] = value;
      });
      return;
    }
    if (!this.ctx.isShared('questVars')) return; // world global, but sharing is off

    const shared = this.ctx.cells.sharedQuest();
    const prev = shared.globals[name];
    if (seq !== undefined && prev !== undefined && seq <= prev.seq) {
      log('debug', 'quest.global_stale_seq', { name, have: prev.seq, got: seq, from: player.name });
      return;
    }
    // Absent seq = plain last-write-wins; keep the stored seq monotonic regardless.
    const nextSeq = seq ?? (prev ? prev.seq + 1 : 1);
    shared.globals[name] = { value, seq: nextSeq };
    this.ctx.cells.saveShared();
    this.relayAll(player.id, 'GlobalVarUpdate', { name, value, seq: nextSeq });
  }

  private isWorldGlobal(lowerName: string): boolean {
    if (WORLD_GLOBALS.has(lowerName)) return true;
    return (this.ctx.worldGlobals ?? []).some((g) => g.toLowerCase() === lowerName);
  }

  // A joining client gets its character's shadowed globals back, so quest state that never
  // travels world-wide still survives a relog or a world hop.
  //
  // The CAMPAIGN's globals, which is the sender's own only on a standalone stack: a guest
  // runs the host's quest scripts and the peer simulates the host's world, and both used to
  // be seeded from their own doc -- a guest's home-campaign values inside the host's world,
  // and the peer's empty ephemeral doc -- so a script gated on a global the host had set
  // ran the other way on the very engine that simulates it.
  sendGlobalSync(player: Player): void {
    const source = this.ctx.journalTarget(player) ?? player.charId;
    const globals = { ...(this.ctx.players.getCached(source)?.globals ?? {}) };
    // Filter on the way OUT too, not just on the way in: characters saved before
    // CLIENT_GLOBALS existed already have a chargenstate on disk, and sending it would
    // re-break exactly the players this fixes. Same for CHARACTER_GLOBALS: a campaign doc
    // written before the split may carry a guest's PCVampire; the player's own doc is the
    // only source for those.
    for (const k of Object.keys(globals)) {
      const l = k.toLowerCase();
      if (CLIENT_GLOBALS.has(l) || CHARACTER_GLOBALS.has(l)) delete globals[k];
    }
    if (player.system !== true) {
      const own = this.ctx.players.getCached(player.charId)?.globals ?? {};
      for (const k of Object.keys(own)) {
        if (CHARACTER_GLOBALS.has(k.toLowerCase())) globals[k] = own[k]!;
      }
    }
    if (Object.keys(globals).length === 0) return;
    player.peer.sendEvent('GlobalVarSync', { globals });
  }

  // Per-object MWScript locals. The body carries no cellKey (it piggybacks on object
  // interaction), so the cell is inferred from the sender's current cell.
  private memberVar(player: Player, body: LTable): void {
    const ref = parseObjRef(body);
    const name = str(body.get('name'));
    const value = finite(body.get('value'));
    const cellKey = player.cellKey;
    // A content ref, or the net id of a runtime actor the holder named (a script-placed NPC
    // runs its own local script like any other).
    if (!ref || !name || value === undefined || !cellKey) {
      this.drop(player, 'MemberVarUpdate', 'invalid shape or no cell');
      return;
    }
    const memberKey = `${cellKey}|${ref.key}|${name}`;
    const nowMs = Date.now();
    if (player.system === true) {
      this.peerMemberAt.set(memberKey, nowMs);
    } else {
      const at = this.peerMemberAt.get(memberKey);
      if (at !== undefined && nowMs - at <= INPUT_DRIVING_MS) {
        log('debug', 'quest.member_peer_owned', { name, ref: ref.key, from: player.name });
        return;
      }
    }
    void this.storeMemberVar(cellKey, ref, name, value, player.name);
    this.relayCell(cellKey, player.id, 'MemberVarUpdate', { ...(lToJs(body) as Record<string, JsLike>) });
  }

  private async storeMemberVar(cellKey: string, ref: ObjRef, name: string, value: number, by: string): Promise<void> {
    const doc = await this.ctx.cells.get(cellKey);
    const vars = (doc.memberVars ??= {});
    const own = (vars[ref.key] ??= {});
    // Capped on STORE, not only on send (worldstate.ts drops the whole map from the snapshot
    // past the cap): a doc that kept growing was still persisted and still too big to ship.
    let total = 0;
    for (const v of Object.values(vars)) total += Object.keys(v).length;
    if (cellMapFull(own, name, cellKey, 'memberVars', by, total)) return;
    own[name] = value;
    this.ctx.cells.markDirty(cellKey);
  }

  // --------------------------------------------------------- factions/crime

  private faction(player: Player, body: LTable): void {
    // The peer's idle dummy is nobody's character: its PCRaiseRank/PCExpell from OnDeath scripts (backlog 215) must not touch the campaign.
    if (player.system) return;
    const factionId = str(body.get('factionId'));
    const rank = finite(body.get('rank'));
    const reputation = body.get('reputation') === undefined ? undefined : finite(body.get('reputation'));
    const expelledRaw = body.get('expelled');
    const expelled = expelledRaw === undefined ? undefined : expelledRaw === true;
    if (
      !factionId || rank === undefined || !Number.isInteger(rank) || rank < -1 || rank > 20 ||
      (body.get('reputation') !== undefined && reputation === undefined) ||
      (expelledRaw !== undefined && typeof expelledRaw !== 'boolean')
    ) {
      this.drop(player, 'FactionUpdate', 'invalid shape');
      return;
    }
    const state = { rank, ...(reputation !== undefined ? { reputation } : {}), ...(expelled !== undefined ? { expelled } : {}) };
    // SAME ROUTING AS THE JOURNAL. Standing used to be written straight to player.charId
    // while journal and globals went through journalTarget, so a guest's guild rank and
    // bounty followed them home out of a campaign their own quest log knew nothing about —
    // and the shared world, which persists no quest progress at all, still ranked them up.
    // A visit either changes your character or it does not; it cannot be half of each.
    const target = this.ctx.journalTarget(player);
    if (target !== undefined) {
      this.ctx.players.update(target, (doc) => {
        (doc.factions ??= {})[factionId] = state;
      });
    } else if (this.ctx.ownerCharId?.() !== undefined || player.charId !== undefined) {
      // Nowhere to put it: the shared world persists no campaign progress (correct), or an
      // owned world's host is offline. The relay below still applies it on every client, so
      // saying nothing leaves the world and the disk disagreeing for the rest of the session
      // with no way to notice.
      log('info', 'quest.standing_not_persisted', { player: player.name, factionId, rank });
    }
    if (!this.ctx.isShared('factions')) return;
    const shared = this.ctx.cells.sharedQuest();
    shared.factions[factionId] = state;
    this.ctx.cells.saveShared();
    this.relayAll(player.id, 'FactionUpdate', { factionId, ...state });
  }

  private crime(player: Player, body: LTable): void {
    const bounty = finite(body.get('bounty'));
    const kind = body.get('kind');
    if (bounty === undefined || bounty < 0 || (kind !== undefined && !str(kind))) {
      this.drop(player, 'CrimeUpdate', 'invalid shape');
      return;
    }
    // Routed like the journal — see factionUpdate above. A bounty earned in someone else's
    // world, or in the shared one, belongs to that world's campaign, not to the visitor.
    const crimeTarget = this.ctx.journalTarget(player);
    // A GUEST'S PERSONAL BOUNTY IS NOT THE HOST'S. With crime personal, the guest's absolute
    // level used to be written over the host's doc (last-writer-wins), and the host inherited
    // the guest's record on relog. Personal means the visitor's number stays the visitor's:
    // held live for the peer's guards, persisted nowhere (they keep loot, not standing).
    if (crimeTarget !== undefined && (this.ctx.isShared('crime') || crimeTarget === player.charId)) {
      this.ctx.players.update(crimeTarget, (doc) => (doc.bounty = bounty));
    } else {
      log('info', 'quest.standing_not_persisted', { player: player.name, bounty });
    }
    player.bounty = bounty;
    if (!this.ctx.isShared('crime')) {
      // Personal: nobody else's number moves, but the PEER still has to hunt this avatar.
      this.ctx.worldPeer?.()?.peer.sendEvent('CrimeUpdate', { bounty, byId: player.id, ...(typeof kind === 'string' ? { kind } : {}) });
      return;
    }
    const shared = this.ctx.cells.sharedQuest();
    shared.bounty = bounty;
    this.ctx.cells.saveShared();
    // ONE record for the party: every avatar is now wanted for it, not just the one who did
    // it -- the clients already apply it to every local player, so the peer must match.
    for (const p of this.ctx.roster.inWorld()) if (!p.system) p.bounty = bounty;
    this.relayAll(player.id, 'CrimeUpdate', {
      bounty,
      ...(typeof kind === 'string' ? { kind } : {}),
      byId: player.id,
      shared: true,
    });
  }

  // Dialogue topics, shared for the same reason the JOURNAL is: a guest's quest state routes
  // through the host's journal, so without this a guest can be looking at a quest in their log
  // with no way to ask anyone about it, because the topic it turns on was learned by someone
  // else. Sharing the journal and not the topics is the inconsistent position.
  //
  // Routed on the JOURNAL family, not a new one: a topic is journal knowledge, and it must
  // follow the same campaign the entries do -- a topic learned in someone else's world belongs
  // to that world, exactly like a quest stage.
  private topics(player: Player, body: LTable): void {
    const list = body.get('topics');
    if (!(list instanceof Map) || list.size === 0 || list.size > MAX_TOPICS_PER_EVENT) {
      this.drop(player, 'TopicsLearned', 'invalid shape');
      return;
    }
    const topics: string[] = [];
    for (const [, v] of list) {
      const id = str(v, MAX_TOPIC_ID);
      if (!id) { this.drop(player, 'TopicsLearned', 'bad topic id'); return; }
      topics.push(id);
    }
    if (!this.ctx.isShared('journal')) return; // topics follow the journal's sharing rule
    this.relayAll(player.id, 'TopicsLearned', { topics, byId: player.id });
  }

  // --------------------------------------------------------- dialogue locks

  // One player may converse with a given NPC at a time; the loser learns who holds it.
  private dialogueLock(player: Player, body: LTable): void {
    const ref = parseObjRef(body);
    const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
    const want = body.get('want');
    // A content ref, or the net id of a runtime actor the holder named (a script-placed
    // quest NPC is one): the lock keys on ref.key either way.
    if (!ref || !cellKey || typeof want !== 'boolean') {
      this.drop(player, 'DialogueLock', 'invalid shape');
      return;
    }
    const held = this.dialogueLocks.get(ref.key);
    if (!want) {
      if (held?.playerId === player.id) {
        this.dialogueLocks.delete(ref.key);
        // A dialogue's consequences land AFTER the window closes -- a taunted NPC or a guard
        // whose arrest was resisted starts combat on "Goodbye" -- and the client's report of
        // that state polls at 1 Hz. Keep "who was just talking to it" for a moment.
        this.recentlyHeld.set(ref.key, { playerId: player.id, at: Date.now() });
      }
      player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: false });
      return;
    }
    if (held && held.playerId !== player.id && this.ctx.roster.get(held.playerId)?.inWorld) {
      player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: false, holderId: held.playerId });
      return;
    }
    this.dialogueLocks.set(ref.key, { playerId: player.id, cellKey });
    player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: true });
  }

  // Release every lock held by a player (disconnect), or only those bound to a cell they
  // just left (cell change) — walking away ends the conversation.
  releaseDialogueLocks(playerId: number, onlyCellKey?: string): void {
    for (const [key, held] of [...this.dialogueLocks]) {
      if (held.playerId !== playerId) continue;
      if (onlyCellKey !== undefined && held.cellKey !== onlyCellKey) continue;
      this.dialogueLocks.delete(key);
    }
  }

  private readonly recentlyHeld = new Map<string, { playerId: number; at: number }>();
  private static readonly RECENT_LOCK_MS = 5_000;
  dialogueHolder(refKey: string): number | undefined {
    const live = this.dialogueLocks.get(refKey)?.playerId;
    if (live !== undefined) return live;
    const recent = this.recentlyHeld.get(refKey);
    if (recent && Date.now() - recent.at <= Quests.RECENT_LOCK_MS) return recent.playerId;
    if (recent) this.recentlyHeld.delete(refKey);
    return undefined;
  }
}

function refBody(ref: ObjRef): JsLike {
  return ref.kind === 'ref' ? { __refnum: { index: ref.index, contentFile: ref.contentFile } } : ref.netId;
}
