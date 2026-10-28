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

import { lToJs, tbl, finite, str, type LTable, type LValue, type JsLike } from '../proto/lser';
import { objRefToJs, parseObjRef, parseRefKey, type ObjRef } from '../proto/ref';
import type { Player, Roster } from './players';
import { INPUT_DRIVING_MS } from './players';

const PEER_MEMBER_TTL_MS = 10 * 60_000; // backlog 196: how long a peer-written member var stays "peer-owned" in memory
import { cellsVisible } from './movement';
import { cellMapFull, type CellStore, type FactionState } from '../persist/cellstore';
import type { PlayerDoc, PlayerStore } from '../persist/playerstore';
import { daysPassed } from './worldtime';
import { log } from '../log';
import { hintGold } from './economy';

// 5000 (backlog 321): 2000 dropped the BEGINNING of a long campaign (Tamriel Rebuilt passes it).
// The bound is the JournalSync frame: an entry is 12 LSER nodes ({q,i,d,m,dm}), so 5000 is
// ~60k of the 65,536-node ceiling with room for a ~2000-quest map beside it (pinned by a
// test: 5000 entries + 700 quests = 61.4k). Past that the sync must be chunked like
// RecordsSync; it is not, yet.
export const MAX_JOURNAL_LOG = 5000;
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
const MAX_TOPICS = 4096; // backlog 51: persisted per campaign doc

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
  'ObjectActivated',
]);
// A campaign's running global scripts: vanilla plus the expansions start well under a hundred.
const MAX_SCRIPTS = 256;

export interface QuestCtx {
  roster: Roster;
  cells: CellStore;
  players: PlayerStore;
  // Quest ids permitted to regress (operator config, surfaced via the plugin).
  regressAllowed(questId: string): boolean;
  // Operator additions to the world-shared global set (total conversions).
  worldGlobals?: string[];
  worldPeer?(): Player | undefined;
  // Who simulates a cell (worldstate.ts): the holder hears its cells wherever it stands.
  holderOf?(cellKey: string): number | undefined;
  // #366: anomaly sink (moderation), same contract as movement/playerstate.
  noteAnomaly?(accountKey: string, kind: string): void;
  // OT3-90: party accounts for an account, itself included (social.ts partyMembers).
  partyMembers?(accountKey: string): string[];
  // OT3-102: run a cell-doc mutation in the world's serial queue (worldstate.inQueue).
  inQueue?(fn: () => Promise<void> | void): Promise<void>;
}

/** OT3-90: a party member who has not pressed anything for this long earns no party credit. */
export const PARTY_CREDIT_AFK_MS = 5 * 60_000;

type JournalLogEntry = NonNullable<PlayerDoc['journalLog']>[number];

function index(v: LValue | undefined): number | undefined {
  const n = finite(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= MAX_INDEX ? n : undefined;
}

export const DIALOGUE_IDLE_MS = 5 * 60_000;

export class Quests {
  // refKey -> everyone talking to that NPC right now (OT3-155: a conversation is not a lock;
  // twenty new players all talk to Fargoth at once), each with the cell it started in.
  // `at`: the talker's last quest activity (OT3-168: a stalled talker stops parking the NPC).
  private dialogueLocks = new Map<string, Map<number, { cellKey: string; ref: ObjRef; at: number }>>();

  constructor(private readonly ctx: QuestCtx) {}

  private drop(player: Player, name: string, why: string): void {
    log('warn', 'quest.dropped', { from: player.name, name, why });
  }

  // A bounty DROP stands only within this long of the player's own dialogue (crime()).
  private static readonly GUEST_WRITE_GRACE_MS = 10_000;
  holdsDialogue(playerId: number): boolean {
    for (const talkers of this.dialogueLocks.values()) if (talkers.has(playerId)) return true;
    return false;
  }
  // Relays exclude the sender: it already applied the change locally, and clients seed
  // their diff caches from applied state (the §M6 echo guard).
  private relayAll(exceptId: number, name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) if (p.id !== exceptId) p.peer.sendEvent(name, body);
  }

  // WHO A PEER WRITE BELONGS TO (OT3-19). The peer runs ONE MWScript state for the whole world,
  // so its journal/global/script writes used to land in every online human's doc. A peer event
  // may name the causing character (`charId`); that human alone is credited. Without one, the
  // fallback decides: the journal credits the humans who already have that quest (the peer is
  // advancing THEIR quest), globals and scripts credit nobody (the shared seed still keeps
  // them for the peer). Never everyone: one player's progress is not another's.
  private peerCredit(body: LTable, fallback: (h: Player) => boolean): Player[] {
    const humans = this.ctx.roster.humansInWorld().filter((q) => !q.bot);
    const named = str(body.get('charId'));
    if (named !== undefined) {
      const h = humans.find((q) => q.charId === named);
      if (!h) log('debug', 'quest.peer_credit_offline', { charId: named });
      return h ? [h] : [];
    }
    return humans.filter(fallback);
  }

  // The same predicate as worldstate.ts hears(): the holder anchors far cells while its own
  // avatar stands elsewhere, and an NPC's locals written in one of them must reach the
  // engine that runs that NPC's script (backlog 222).
  private relayCell(cellKey: string, exceptId: number, name: string, body: JsLike): void {
    for (const p of this.ctx.roster.inWorld()) {
      if (p.id === exceptId) continue;
      // (prod 2026-10-26) No script locals into a character still in creation: see memberVar.
      if (p.inChargen === true) continue;
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
    if (!player.system) this.touchDialogue(player.id, Date.now());
    switch (name) {
      case 'JournalEntry': this.journal(player, body); break;
      case 'GlobalVarUpdate': this.globalVar(player, body); break;
      case 'MemberVarUpdate': this.memberVar(player, body); break;
      case 'FactionUpdate': this.faction(player, body); break;
      case 'CrimeUpdate': this.crime(player, body); break;
      case 'TopicsLearned': this.topics(player, body); break;
      case 'DialogueLock': this.dialogueLock(player, body); break;
      case 'GlobalScriptsUpdate': this.scripts(player, body); break;
      case 'ObjectActivated': this.activated(player, body); break;
    }
    return true;
  }

  // A client activated an object that runs a local MWScript (quests.lua onActivate). Nothing
  // is relayed or stored: it stamps questTriggerAt, so it is reach-gated like every object edit -- you activate what you
  // can see.
  private activated(player: Player, body: LTable): void {
    const ref = parseObjRef(body);
    const cellKey = str(body.get('cellKey'), MAX_CELL_KEY);
    if (!ref || !cellKey) { this.drop(player, 'ObjectActivated', 'invalid shape'); return; }
    if (player.system === true) return;
    if (!cellsVisible(player.cellKey, cellKey)) { this.drop(player, 'ObjectActivated', 'activation from afar'); return; }
    player.questTriggerAt = Date.now();
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
    const apply = (list: string[] | undefined): string[] => {
      const set = new Set(list ?? []);
      for (const s of stopped) set.delete(s);
      for (const s of started) set.add(s);
      return [...set].slice(0, MAX_SCRIPTS);
    };
    // STANDALONE (1.7.1): like its globals, the peer's scripts persist to every human, and the
    // union is kept on the shared state the peer is seeded from (its own doc is throwaway).
    const shared = this.ctx.cells.worldShared();
    shared.scripts = apply(shared.scripts);
    this.ctx.cells.saveShared();
    if (player.system === true) {
      for (const h of this.peerCredit(body, () => false)) {
        this.ctx.players.update(h.charId, (doc) => { doc.scripts = apply(doc.scripts); });
      }
      return;
    }
    this.ctx.players.update(player.charId, (doc) => { doc.scripts = apply(doc.scripts); });
  }

  sendScriptsSync(player: Player): void {
    const running = player.system === true
      ? (this.ctx.cells.worldShared().scripts ?? [])
      : (this.ctx.players.getCached(player.charId)?.scripts ?? []);
    if (running.length === 0) return;
    player.peer.sendEvent('GlobalScriptsSync', { running: [...running] });
  }

  // ---------------------------------------------------------------- journal

  private journal(player: Player, body: LTable): void {
    hintGold(player, 'quest'); // OT3-189: a reward lands in the next declaration
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
    // THE PEER: the same rule the globals half uses. The peer's own doc is ephemeral, so a peer-advanced journal entry was
    // relayed live and then lost -- leaving globals saying "done" and the journal saying
    // stage 10, the exact split the comment above forbids. Persist to every human instead.
    // OT3-51: every journal is the character's own; there is no shared log any more. The peer
    // advances only the characters it credits, and only they hear it.
    if (player.system === true) {
      const credited = this.peerCredit(body,
        (h) => this.ctx.players.getCached(h.charId)?.journal?.[questId] !== undefined);
      // Max: the one peer runs every character's scripts, so its lower stage is another
      // character's state, not this one's restart.
      for (const h of credited) {
        this.ctx.players.update(h.charId, (doc) => {
          const log = (doc.journal ??= {});
          log[questId] = Math.max(log[questId] ?? -1, idx);
          this.logEntry(doc, questId, idx);
        }, 'now');
        h.peer.sendEvent('JournalEntry', { questId, index: idx });
      }
      if (credited.length === 0) log('info', 'quest.peer_journal_unattributed', { questId, index: idx });
      return;
    }
    // THE PLAYER'S OWN LOG (backlog 320), never relayed (OT3-51). Same arbitration the shared log
    // had, against the character's own doc: a lagging client cannot rewind it, and a relog's
    // replay of JournalSync's log (backlog 335) writes nothing.
    const doc0 = this.ctx.players.getCached(player.charId);
    const current = doc0?.journal?.[questId];
    if (current === idx) return;
    const regressing = current !== undefined && idx < current;
    if (regressing && !this.ctx.regressAllowed(questId)) {
      log('debug', 'quest.journal_regress_blocked', { questId, have: current, got: idx, from: player.name });
      return;
    }
    if (regressing && this.inReplayWindow(player) && (doc0?.journalLog ?? []).some((e) => e.q === questId && e.i === idx)) {
      log('debug', 'quest.journal_regress_replay', { questId, have: current, got: idx, from: player.name });
      return;
    }
    // Phase 3.7: journal advances flush AT THE WRITE, not on the 45 s sweep. A verified
    // TES3MP failure is a disconnect mid-quest permanently corrupting progression
    // (Tribunal MQ, issue #268 — open since 2017): the stage was in memory and the crash
    // took it. A quest step a player has earned must survive the next instant.
    this.ctx.players.update(player.charId, (doc) => {
      (doc.journal ??= {})[questId] = idx;
      this.logEntry(doc, questId, idx);
    }, 'now');
    if (!regressing) this.creditParty(player, questId, idx);
  }

  // OT3-90: party credit. A member gets the stage the writer just reached when they are
  // online, co-present (same or visible cell), not AFK, already on the quest (eligibility:
  // a quest they never started, e.g. another faction's, gives nothing) and behind it. Only
  // ever forward: a member at or past the stage keeps theirs, so a branch they already took
  // is never overwritten. Each write is to the member's OWN journal (OT3-51), and their
  // client hears it as the peer-credit path does; its echo then matches and writes nothing.
  // ponytail: "behind on the same quest id" stands in for exclusive-branch detection and the
  // skipped stages' catch-up effects, which need the quest tables (OT3 step 3).
  private creditParty(player: Player, questId: string, idx: number): void {
    const members = this.ctx.partyMembers?.(player.accountKey) ?? [];
    const now = Date.now();
    for (const acct of members) {
      if (acct === player.accountKey) continue;
      const m = this.ctx.roster.activeForAccount(acct);
      if (!m || m.system || !m.inWorld || !cellsVisible(player.cellKey, m.cellKey)) continue;
      if (m.lastInputAt === undefined || now - m.lastInputAt > PARTY_CREDIT_AFK_MS) continue;
      const have = this.ctx.players.getCached(m.charId)?.journal?.[questId];
      if (have === undefined || have >= idx) continue;
      this.ctx.players.update(m.charId, (doc) => {
        (doc.journal ??= {})[questId] = idx;
        this.logEntry(doc, questId, idx);
      }, 'now');
      m.peer.sendEvent('JournalEntry', { questId, index: idx });
      log('info', 'quest.party_credit', { questId, index: idx, from: player.name, to: m.name });
    }
  }

  // The join-time replay window: JournalSync was sent this long ago at most. Echoes of its
  // replayed log arrive a frame or so after the client applies it; a slow boot applies late.
  static REPLAY_WINDOW_MS = 15_000;
  private inReplayWindow(player: Player): boolean {
    return player.journalSyncAt !== undefined && Date.now() - player.journalSyncAt <= Quests.REPLAY_WINDOW_MS;
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

  // The old creditParty (instance-owned model) is gone; OT3-90's creditParty above writes
  // only members' own journals, under the one-world model (OT3-31/51).

  // Full journal state for a joining client: the shared map, or their own in individual
  // mode. Always sent (an empty map is a valid, meaningful answer).
  // The bounty this world holds the player to, at join (players.ts `bounty` says why it is
  // not the doc's): the party's one record when crime is shared, else the player's own
  // (backlog 147: personal crime seeded a guest with the HOST's bounty; crime() below
  // only ever writes a personal bounty to the player's own doc, so read it from there).
  seedBounty(player: Player): void {
    player.bounty = this.ctx.players.getCached(player.charId)?.bounty ?? 0;
  }

  sendJournalSync(player: Player): void {
    this.seedBounty(player);
    // Each character reads its own log (OT3-51).
    const quests = { ...(this.ctx.players.getCached(player.charId)?.journal ?? {}) };
    // The dated log lives on the player's own doc (OT3-31: one world, no owner).
    const journalLog = (this.ctx.players.getCached(player.charId)?.journalLog ?? []).map((e) => ({ ...e }));
    // BORROWED: this sync carries a campaign that is not this character's own, so the client
    // must set its own journal aside for the visit and put it back on the way home. The
    // client cannot work this out for itself — it does not know who owns the instance.
    // Driving it off the sync (rather than a "leaving" event) makes it self-correcting: this
    // message is sent on EVERY join, so a missed transition repairs itself on the next one.
    // One world, no owner (OT3-31): nothing is ever borrowed; the field stays for the client.
    const borrowed = false;
    const topics = [...(this.ctx.players.getCached(player.charId)?.topics ?? [])];
    player.journalSyncAt = Date.now(); // opens the replay window (journal() backlog 335)
    player.peer.sendEvent('JournalSync', { quests, borrowed, journalLog, topics });
  }

  // ---------------------------------------------------------------- globals

  // Phase 4E: WHO OWNS AN MWSCRIPT WRITE. Under the one-peer model the peer runs every cell
  // script authoritatively -- but each client's engine runs its LOCAL COPY of the same
  // scripts on the same (puppeted) actors, so the same global or member variable gets
  // written twice, and character globals were last-writer-wins. The peer's write wins: a
  // client write to a name the peer wrote within INPUT_DRIVING_MS is dropped. Names the
  // peer never writes (dialogue-result scripts run only on the client that talked) are
  // untouched, so dialogue-driven quest state stays exactly as it was.
  //
  // THE REFUSED CLIENT IS TOLD (1.7.1). The drop was silent, and the client's diff cache
  // already held its own value as "sent", so its engine kept the losing value -- its Global
  // filters and script copies ran the other way -- until the next login. The winning value
  // goes back to the refused writer, which applies it like any relay and converges.
  // ponytail: "the peer wins" is wrong for a peer write from a script that reads Player --
  // on the peer that is the parked dummy (GetDistance player, GetItemCount on the dummy), so
  // the peer's value can be the dummy's answer, not the party's. Telling which script wrote a
  // global needs engine-side attribution (the interpreter's current script and whether it
  // touched the player ref); until then such a global converges to the peer's value.
  private peerGlobalAt = new Map<string, { at: number; value: number }>();
  private peerMemberAt = new Map<string, { at: number; value: number }>();
  private peerMemberWrites = 0;

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
      this.peerGlobalAt.set(lower, { at: nowMs, value });
    } else {
      const owned = this.peerGlobalAt.get(lower);
      if (owned !== undefined && nowMs - owned.at <= INPUT_DRIVING_MS) {
        log('debug', 'quest.global_peer_owned', { name, from: player.name });
        if (owned.value !== value) {
          const seqNow = this.isWorldGlobal(lower) ? this.ctx.cells.worldShared().globals[name]?.seq : undefined;
          player.peer.sendEvent('GlobalVarUpdate', { name, value: owned.value, ...(seqNow !== undefined ? { seq: seqNow } : {}) });
        }
        return;
      }
    }
    if (!this.isWorldGlobal(lower)) {
      // STORY GLOBALS ARE THE CHARACTER'S (OT3-51). Morrowind gates most quests on globals,
      // so these follow the journal: the writer's own doc, and no other human hears it --
      // relaying (backlog 224) is what made two players at different stages overwrite each
      // other. The peer hears a human's write (it runs the world's copy of the scripts), and
      // a peer write reaches only the character it credits. The campaign map stays as the
      // peer's seed (OT3-62/116 decide what that union should be).
      if (player.system === true) {
        for (const h of this.peerCredit(body, () => false)) {
          this.ctx.players.update(h.charId, (doc) => { (doc.globals ??= {})[name] = value; });
          h.peer.sendEvent('GlobalVarUpdate', { name, value });
        }
        this.noteCampaignGlobal(name, value);
        return;
      }
      this.ctx.players.update(player.charId, (doc) => {
        (doc.globals ??= {})[name] = value;
      });
      this.ctx.worldPeer?.()?.peer.sendEvent('GlobalVarUpdate', { name, value });
      this.noteCampaignGlobal(name, value); // the peer's seed
      return;
    }

    // WORLD globals (clock-adjacent weather, [sharing].worldGlobals): the one shared state left.
    const shared = this.ctx.cells.worldShared();
    const prev = shared.globals[name];
    if (seq !== undefined && prev !== undefined && seq <= prev.seq) {
      log('debug', 'quest.global_stale_seq', { name, have: prev.seq, got: seq, from: player.name });
      // Answered, not silent (1.7.1): a relogged client's per-name seq restarts at 1 while the
      // stored one survives, and every write it made was refused with no reply. The stored
      // value and seq bring it level; its next write then outbids the store.
      player.peer.sendEvent('GlobalVarUpdate', { name, value: prev.value, seq: prev.seq });
      return;
    }
    // Absent seq = plain last-write-wins; keep the stored seq monotonic regardless.
    const nextSeq = seq ?? (prev ? prev.seq + 1 : 1);
    shared.globals[name] = { value, seq: nextSeq };
    this.ctx.cells.saveShared();
    this.relayAll(player.id, 'GlobalVarUpdate', { name, value, seq: nextSeq });
  }

  // Standalone only: the latest value of every campaign global anyone in the world wrote --
  // what the peer, which simulates that one shared world, is seeded with (sendGlobalSync).
  private noteCampaignGlobal(name: string, value: number): void {
    const shared = this.ctx.cells.worldShared();
    (shared.campaignGlobals ??= {})[name] = value;
    this.ctx.cells.saveShared();
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
    const source = player.charId;
    // The peer's own doc is throwaway; the shared campaign map is its seed (1.7.1).
    const globals = player.system === true
      ? { ...(this.ctx.cells.worldShared().campaignGlobals ?? {}) }
      : { ...(this.ctx.players.getCached(source)?.globals ?? {}) };
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
    // WORLD-SHARED globals too, with their seqs (1.7.1). They live on the shared state, never
    // on a doc, so a joiner was never given them -- and its per-name seq restarts at 1, so
    // every write it made after a relog was refused as stale. `seqs` seeds the client's.
    const seqs: Record<string, number> = {};
    for (const [k, g] of Object.entries(this.ctx.cells.worldShared().globals)) {
      if (TIME_GLOBALS.has(k.toLowerCase()) || !this.isWorldGlobal(k.toLowerCase())) continue;
      globals[k] = g.value;
      seqs[k] = g.seq;
    }
    if (Object.keys(globals).length === 0) return;
    player.peer.sendEvent('GlobalVarSync', { globals, ...(Object.keys(seqs).length > 0 ? { seqs } : {}) });
  }

  // Per-object MWScript locals, filed under the OBJECT's cell.
  private memberVar(player: Player, body: LTable): void {
    const ref = parseObjRef(body);
    const name = str(body.get('name'));
    const value = finite(body.get('value'));
    // The peer names the cell (#217): it watches scripted objects in every cell it holds,
    // which is rarely the one its dummy stands in. A client names it too since 1.7.1 -- an
    // NPC's locals were filed under the cell the PLAYER stood in, so a neighbour-cell NPC's
    // state was stored (and restored) against the wrong cell doc. A client's cell must be
    // one it can see. CL15: naming it is required -- v2 ships no client that omits it.
    const named = str(body.get('cellKey'), MAX_CELL_KEY);
    if (named !== undefined && player.system !== true && !cellsVisible(player.cellKey, named)) {
      this.drop(player, 'MemberVarUpdate', 'cell out of reach');
      return;
    }
    const cellKey = named;
    // A content ref, or the net id of a runtime actor the holder named (a script-placed NPC
    // runs its own local script like any other).
    if (!ref || !name || value === undefined || !cellKey) {
      this.drop(player, 'MemberVarUpdate', 'invalid shape or no cell');
      return;
    }
    // A character still in creation runs the opening's scripts alone (prod 2026-10-26: the
    // dock guard's CharGenRaceNPC `state` is a member var, and since 1.7.1 the peer's copy
    // measures GetDistance Player to the nearest avatar, so its headless engine -- SayDone is
    // always true there -- ran 20 -> -1 in a second and a half while the client still waited
    // on Dock1. The relayed -1 skipped Enableracemenu/EnablePlayerControls: controls stayed
    // off, no race menu, and the stored -1 met every later new character the same way). So:
    // nothing they write is filed, and nothing anyone writes reaches them -- the relay below
    // and worldstate.ts sendCellState both skip an in-chargen player.
    if (player.inChargen === true) {
      log('debug', 'quest.member_in_chargen', { name, ref: ref.key, from: player.name });
      return;
    }
    const memberKey = `${cellKey}|${ref.key}|${name}`;
    const nowMs = Date.now();
    if (player.system === true) {
      this.peerMemberAt.set(memberKey, { at: nowMs, value });
      // Backlog 196: one entry per cell|ref|name the peer ever wrote, never removed -- prune
      // what is long past INPUT_DRIVING_MS (10 min is generous) every few thousand writes,
      // so the map tracks what the peer is CURRENTLY driving rather than everything it has.
      if (++this.peerMemberWrites % 4096 === 0) {
        for (const [k, w] of this.peerMemberAt) if (nowMs - w.at > PEER_MEMBER_TTL_MS) this.peerMemberAt.delete(k);
      }
    } else {
      const owned = this.peerMemberAt.get(memberKey);
      if (owned !== undefined && nowMs - owned.at <= INPUT_DRIVING_MS) {
        log('debug', 'quest.member_peer_owned', { name, ref: ref.key, from: player.name });
        // Told, like a refused global (above): the writer's watch cache thinks its value went out.
        if (owned.value !== value) player.peer.sendEvent('MemberVarUpdate', { ...(lToJs(body) as Record<string, JsLike>), value: owned.value });
        return;
      }
    }
    void this.storeMemberVar(cellKey, ref, name, value, player.name);
    this.relayCell(cellKey, player.id, 'MemberVarUpdate', { ...(lToJs(body) as Record<string, JsLike>) });
  }

  private storeMemberVar(cellKey: string, ref: ObjRef, name: string, value: number, by: string): Promise<void> {
    const work = (): Promise<void> => this.storeMemberVarNow(cellKey, ref, name, value, by);
    return this.ctx.inQueue ? this.ctx.inQueue(work) : work();
  }

  private async storeMemberVarNow(cellKey: string, ref: ObjRef, name: string, value: number, by: string): Promise<void> {
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
    // The character's own standing (OT3-51): nobody else's rank moves with it.
    this.ctx.players.update(player.charId, (doc) => {
      (doc.factions ??= {})[factionId] = state;
    });
  }

  // OT3-115: a crime the PEER saw raises the criminal's bounty server-side, so a client that
  // never reports its own CrimeUpdate is still wanted. The record is the character's own (OT3-51).
  raiseBounty(player: Player, delta: number): void {
    if (delta <= 0) return;
    const bounty = (player.bounty ?? 0) + delta;
    player.bounty = bounty;
    if (player.charId !== undefined) this.ctx.players.update(player.charId, (doc) => (doc.bounty = bounty));
  }

  private crime(player: Player, body: LTable): void {
    const bounty = finite(body.get('bounty'));
    const kind = body.get('kind');
    if (bounty === undefined || bounty < 0 || (kind !== undefined && !str(kind))) {
      this.drop(player, 'CrimeUpdate', 'invalid shape');
      return;
    }
    // #366: ONE RECORD, RAISED BY ANYONE, LOWERED ONLY OUT OF A GUARD'S DIALOGUE. A human's
    // bare drop is the party-wide forgiveness a modified client hands out (bounty 0 ->
    // everyone walks). The peer never lowers a bounty (fines are paid in the guard's dialogue
    // on the client), so "peer-only drops" would mean no fine is ever paid; the cheap
    // correlation is the conversation itself: a drop within 10 s of this player's own
    // DialogueLock traffic (pay the fine / go to jail) stands, any other is refused.
    // The record is the character's own (OT3-51); the peer still has to hunt this avatar.
    const talked = player.lastDialogueAt !== undefined && Date.now() - player.lastDialogueAt <= Quests.GUEST_WRITE_GRACE_MS;
    if (player.system !== true && !talked && bounty < (player.bounty ?? 0)) {
      const have = player.bounty ?? 0;
      log('warn', 'quest.crime_drop_refused', { from: player.name, have, got: bounty });
      this.ctx.noteAnomaly?.(player.accountKey, 'crime_drop');
      // Not silent (backlog 386): the client would otherwise keep 0 while the peer keeps hunting.
      player.peer.sendEvent('CrimeUpdate', { bounty: have });
      return;
    }
    this.ctx.players.update(player.charId, (doc) => (doc.bounty = bounty));
    player.bounty = bounty;
    this.ctx.worldPeer?.()?.peer.sendEvent('CrimeUpdate', { bounty, byId: player.id, ...(typeof kind === 'string' ? { kind } : {}) });
  }

  // Dialogue topics: the character's own knowledge, persisted with its journal (OT3-51).
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
    // Persisted with the journal (backlog 51): relayed live and then forgotten, so a relog
    // greeted every NPC with the topics this character had already learned missing.
    this.ctx.players.update(player.charId, (doc) => {
      const set = new Set(doc.topics ?? []);
      for (const t of topics) set.add(t);
      doc.topics = [...set].slice(-MAX_TOPICS);
    });
  }

  // --------------------------------------------------------- dialogue locks

  // OT3-155: any number of players may converse with one NPC at once. Each conversation runs
  // on its talker's own client against their own character, so nothing is contended; the
  // grant still gates the actor facts a talker may state (worldstate.ts) and parks the NPC.
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
    const talkers = this.dialogueLocks.get(ref.key);
    // #361/#366 (403): lastDialogueAt is stamped only on a GRANTED lock or a real release --
    // a refused request (far cell, held by someone else) is not a conversation and must not
    // buy the same-cell jump or bounty-drop passes.
    if (!want) {
      if (talkers?.has(player.id)) {
        if (!player.system) player.lastDialogueAt = Date.now();
        this.endTalk(ref.key, player.id);
        // A dialogue's consequences land AFTER the window closes -- a taunted NPC or a guard
        // whose arrest was resisted starts combat on "Goodbye" -- and the client's report of
        // that state polls at 1 Hz. Keep "who was just talking to it" for a moment.
        this.recentlyHeld.set(recentKey(ref.key, player.id), { at: Date.now() });
      }
      player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: false });
      return;
    }
    // #367: you talk to what you can see, and to one NPC at a time -- a new request ends the
    // conversation the client claims it is still having (it can only have one window open).
    if (!player.system && !cellsVisible(player.cellKey, cellKey)) {
      this.drop(player, 'DialogueLock', 'lock from afar');
      player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: false });
      return;
    }
    if (!player.system) { this.releaseDialogueLocks(player.id); player.lastDialogueAt = Date.now(); }
    let map = this.dialogueLocks.get(ref.key);
    if (!map) this.dialogueLocks.set(ref.key, (map = new Map()));
    map.set(player.id, { cellKey, ref, at: Date.now() });
    // Parked while anyone talks; it turns to face the latest talker.
    this.holdForDialogue(ref, cellKey, true, player.id);
    player.peer.sendEvent('DialogueLockResult', { ref: refBody(ref), granted: true });
  }

  // #77: in single player the world stops for a conversation; here the holder kept the NPC
  // wandering, so it walked off on everyone else's screen and the talker's copy jumped to
  // wherever it had got to when the window closed. The holder parks the NPC (a distance-0
  // Wander on top of its stack, companion.lua) for as long as the lock is held.
  // `by`: who is talking, so the holder can turn the NPC to face them -- the engine's own
  // greeting turn (actors.cpp updateGreetingState) faces the PEER's dummy player, not them.
  private holdForDialogue(ref: ObjRef, cellKey: string, hold: boolean, by?: number): void {
    const holderId = this.ctx.holderOf?.(cellKey);
    const holder = holderId === undefined ? undefined : this.ctx.roster.get(holderId);
    // Logged both ways: "they walked away while I talked" is either a hold nobody could take
    // (no holder for that cell) or one the peer did not apply (its [mp] dialogue hold line).
    log('info', 'quests.dialogue_hold', { ref: ref.key, cellKey, hold, holder: holder?.inWorld ? holder.name : null });
    if (!holder?.inWorld) return;
    holder.peer.sendEvent('ActorAI', { ...objRefToJs(ref), cellKey, epoch: 0, hold, ...(hold && by !== undefined ? { by } : {}) });
  }

  // Release every lock held by a player (disconnect), or only those bound to a cell they
  // just left (cell change) — walking away ends the conversation.
  releaseDialogueLocks(playerId: number, onlyCellKey?: string): void {
    for (const [key, talkers] of [...this.dialogueLocks]) {
      const mine = talkers.get(playerId);
      if (!mine) continue;
      if (onlyCellKey !== undefined && mine.cellKey !== onlyCellKey) continue;
      this.endTalk(key, playerId);
    }
  }

  // OT3-168: any quest event (topic, journal, disposition-bearing dialogue) is the talker
  // still talking. A conversation with none for DIALOGUE_IDLE_MS is over: an AFK player or a
  // stalled bot no longer parks a quest NPC for everyone. Disconnect already releases.
  private touchDialogue(playerId: number, now: number): void {
    for (const talkers of this.dialogueLocks.values()) {
      const mine = talkers.get(playerId);
      if (mine) mine.at = now;
    }
  }

  expireIdleDialogue(now = Date.now()): void {
    for (const [key, talkers] of [...this.dialogueLocks]) {
      for (const [playerId, t] of [...talkers]) {
        if (now - t.at < DIALOGUE_IDLE_MS) continue;
        log('info', 'quests.dialogue_idle_released', { ref: key, playerId, idleMs: now - t.at });
        this.endTalk(key, playerId);
      }
    }
  }

  // One talker leaves; the NPC is let go when the last one does.
  private endTalk(refKey: string, playerId: number): void {
    const talkers = this.dialogueLocks.get(refKey);
    const mine = talkers?.get(playerId);
    if (!talkers || !mine) return;
    talkers.delete(playerId);
    if (talkers.size) return;
    this.dialogueLocks.delete(refKey);
    this.holdForDialogue(mine.ref, mine.cellKey, false);
  }

  // recentKey(refKey, playerId) -> when that player stopped talking to it (or was forced to).
  private readonly recentlyHeld = new Map<string, { at: number; ttl?: number }>();
  private static readonly RECENT_LOCK_MS = 5_000;
  private static readonly FORCED_DIALOGUE_MS = 120_000;
  // #44: an arrest dialogue is forced onto the wanted player's screen by the peer (no lock is
  // requested, backlog 343), yet "the guard now fights me" needs the holder gate to pass.
  // The peer names the guard and the player; the player counts as its holder for a while.
  noteForcedDialogue(refKey: string, playerId: number): void {
    this.recentlyHeld.set(recentKey(refKey, playerId), { at: Date.now(), ttl: Quests.FORCED_DIALOGUE_MS });
  }
  /** Is (or was, a moment ago) this player talking to this NPC? */
  isDialogueHolder(refKey: string, playerId: number): boolean {
    if (this.dialogueLocks.get(refKey)?.has(playerId)) return true;
    const k = recentKey(refKey, playerId);
    const recent = this.recentlyHeld.get(k);
    if (recent && Date.now() - recent.at <= (recent.ttl ?? Quests.RECENT_LOCK_MS)) return true;
    if (recent) this.recentlyHeld.delete(k);
    return false;
  }

  // ------------------------------------------------- personal disposition (OT3-155)

  /** A conversation changed how an NPC feels about THIS character. Kept on their doc, keyed
   *  by the content ref; runtime (net-id) actors do not outlive the session, so not kept. */
  notePersonalDisposition(player: Player, ref: ObjRef, cellKey: string, disposition: number): void {
    if (ref.kind !== 'ref' || player.system) return;
    this.ctx.players.update(player.charId, (doc) => {
      const all = (doc.dispositions ??= {});
      delete all[ref.key]; // re-inserted last: the cap drops the least recently changed
      all[ref.key] = { cellKey, d: disposition };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DISPOSITIONS))) delete all[k];
    });
  }

  /** On entering a cell: reapply this character's own standing with the NPCs there. */
  sendPersonalDispositions(player: Player, cellKey: string): void {
    const all = this.ctx.players.getCached(player.charId)?.dispositions;
    if (!all) return;
    for (const [key, e] of Object.entries(all)) {
      const ref = e.cellKey === cellKey ? parseRefKey(key) : null;
      if (ref) player.peer.sendEvent('ActorDisposition', { ...objRefToJs(ref), cellKey, epoch: 0, disposition: e.d });
    }
  }
}

const MAX_DISPOSITIONS = 500;
const recentKey = (refKey: string, playerId: number): string => `${refKey}#${playerId}`;

function refBody(ref: ObjRef): JsLike {
  return ref.kind === 'ref' ? { __refnum: { index: ref.index, contentFile: ref.contentFile } } : ref.netId;
}
