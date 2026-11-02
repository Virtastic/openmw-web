// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-11 / OT3-14: the quest/phase scanner. Reads a load order's CELL/REFR, DIAL/INFO, SCPT,
// SSCR, GLOB and scripted-object records and writes four tables:
//
//   phase-cells.json     per cell: the quest stages whose effects touch it (its phase keys)
//   phase-quests.json    per quest: kind, eligibility (what the first stage's setter requires),
//                        stages and branches (the finishing stages)
//   phase-stages.json    per stage "<quest>:<index>": journal text, finished flag, and every
//                        world effect that stage triggers, with the script chain it came through
//   script-classes.json  per script: startup / global / local / targeted, who starts and stops it
//
// Attribution. A script body (an INFO result or an SCPT text) is split into blocks: the top
// level and each if/elseif/else body. An effect belongs to
//   - every stage set by a `Journal` / `SetJournalIndex` call in the same block, and
//   - every stage named by a `GetJournalIndex "q" >= N` (or ==, >) condition enclosing it.
// `StartScript X` in a block carries ALL of X's effects (and, transitively, of what X starts)
// to that block's stages; the effect records the chain in `via`. Cycles are cut and reported;
// a StartScript target no loaded SCPT defines is reported as unresolved. Neither stops the scan.
// `StopScript` is recorded as an effect and in the class table; it is not followed.
//
// This is a static, text-level scan of MWScript: it is a table for the server to start from,
// to be spot-checked in game, not a proof of what the engine will do.
//
// Usage:
//   node tools/scan-quests.mjs --out-dir <dir> <content files in load order...>
//   node tools/scan-quests.mjs --out-dir <dir> --data-dir "<Data Files>"
//     (--data-dir: Morrowind.esm, Tribunal.esm, Bloodmoon.esm first, then the other .esm, then
//      .esp, each group by name; a stand-in for openmw.cfg's content= order)

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecords, zstr, sub } from './esm-reader.mjs';

// Commands whose effect changes the world a player sees. Lowercase.
const EFFECTS = new Set([
  'enable', 'disable', 'placeatpc', 'placeatme', 'placeitem', 'placeitemcell', 'additem', 'removeitem',
  'journal', 'setjournalindex', 'setpos', 'position', 'positioncell', 'moveworld', 'modregion',
  'changeweather', 'addtopic', 'startscript', 'stopscript', 'setdelete', 'resurrect', 'kill',
  'set', 'addspell', 'removespell', 'modfactionreaction', 'setfactionreaction', 'raiserank', 'pcraiserank',
  'pcjoinfaction', 'pcexpell', 'pcclearexpelled', 'lock', 'unlock', 'setfight', 'sethello', 'aifollow',
  'aiescort', 'aitravel', 'aiwander', 'aiactivate', 'additemmerchant', 'createmaps', 'setlevel',
]);
const DATA_ORDER = ['morrowind.esm', 'tribunal.esm', 'bloodmoon.esm'];

/** Split a script line into words, keeping quoted strings whole (quotes stripped). */
function words(line) {
  const out = [];
  const re = /"([^"]*)"|([^\s,"]+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

function stripComment(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ';' && !q) return line.slice(0, i);
  }
  return line;
}

const OPS = { '==': 'eq', '=': 'eq', '>=': 'ge', '>': 'gt', '<=': 'le', '<': 'lt', '!=': 'ne' };

/**
 * Parse a script body into blocks of effects. Returns
 *   { effects: [{ op, ref, args, line, stages: [{quest, index}] }], stagesSet: [{quest,index}] }
 * where `stages` are the stages the effect is attributed to (same-block Journal calls and
 * enclosing GetJournalIndex conditions).
 */
export function parseScript(text) {
  const blocks = [{ journals: [], effects: [], conds: [] }];
  const all = [];
  const stack = [{ conds: [] }]; // enclosing if-frames; each has conds for its current branch
  let cur = blocks[0];
  const newBlock = (conds) => { cur = { journals: [], effects: [], conds }; blocks.push(cur); };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, ln) => {
    const line = stripComment(raw).trim();
    if (!line) return;
    const low = line.toLowerCase();
    const head = low.match(/^(if|elseif|else|endif|begin|end)\b/)?.[1];
    if (head === 'if' || head === 'elseif') {
      const outer = head === 'if' ? stack[stack.length - 1].conds : stack[stack.length - 2]?.conds ?? [];
      const m = line.match(/getjournalindex\s*,?\s*"?([^"\s,)]+)"?\s*\)?\s*(==|>=|<=|!=|>|<|=)\s*(-?\d+)/i);
      const conds = [...outer];
      if (m && ['eq', 'ge', 'gt'].includes(OPS[m[2]])) {
        const n = Number(m[3]);
        conds.push({ quest: m[1].toLowerCase(), index: OPS[m[2]] === 'gt' ? n + 1 : n });
      }
      if (head === 'if') stack.push({ conds }); else stack[stack.length - 1].conds = conds;
      newBlock(conds);
      return;
    }
    if (head === 'else') {
      const outer = stack[stack.length - 2]?.conds ?? [];
      stack[stack.length - 1].conds = outer;
      newBlock(outer);
      return;
    }
    if (head === 'endif') {
      if (stack.length > 1) stack.pop();
      newBlock(stack[stack.length - 1].conds);
      return;
    }
    if (head === 'begin' || head === 'end') return;
    // Statement: [ref->]command args...   ref may be quoted.
    let ref = null, rest = line;
    const arrow = line.match(/^("([^"]*)"|[^\s"]+?)\s*->\s*(.*)$/);
    if (arrow) { ref = (arrow[2] ?? arrow[1]).toLowerCase(); rest = arrow[3]; }
    const w = words(rest);
    const op = w[0]?.toLowerCase();
    if (!op || !EFFECTS.has(op)) return;
    const args = w.slice(1).map((a) => a.toLowerCase());
    if (op === 'set' && args[0] === undefined) return;
    const eff = { op, ref, args: op === 'set' ? [args[0], ...args.slice(2)] : args, line: ln + 1, block: cur };
    if ((op === 'journal' || op === 'setjournalindex') && args[0] && /^-?\d+$/.test(args[1] ?? '')) {
      cur.journals.push({ quest: args[0], index: Number(args[1]) });
    }
    cur.effects.push(eff);
    all.push(eff);
  });
  const stagesSet = [];
  for (const e of all) {
    const st = [...e.block.journals, ...e.block.conds];
    const seen = new Set();
    e.stages = st.filter((s) => { const k = `${s.quest}:${s.index}`; if (seen.has(k)) return false; seen.add(k); return true; });
    delete e.block;
  }
  for (const b of blocks) stagesSet.push(...b.journals);
  return { effects: all, stagesSet };
}

/** Pick a load order from a Data Files directory. */
export function loadOrderFrom(dir) {
  const files = readdirSync(dir).filter((f) => /\.(esm|esp|omwaddon)$/i.test(f));
  const rank = (f) => {
    const i = DATA_ORDER.indexOf(f.toLowerCase());
    if (i >= 0) return [0, i];
    return [/\.esm$/i.test(f) ? 1 : 2, 0];
  };
  files.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || a.localeCompare(b); });
  return files.map((f) => join(dir, f));
}

/** Read a load order. Later records replace earlier ones with the same id. */
function load(files) {
  const scripts = new Map();      // id -> text
  const startup = new Set();      // SSCR targets
  const globals = new Map();      // id -> value
  const attached = new Map();     // script id -> [object ids]
  const dials = new Map();        // dial id -> { type, infos: Map(infoId -> info) }
  const cells = new Map();        // cell key -> { refs: Set(objId) }
  const refCells = new Map();     // obj id -> Set(cell key)
  for (const f of files) {
    let dial = null;
    for (const rec of readRecords(f)) {
      const t = rec.type;
      if (t === 'SCPT') {
        const hd = sub(rec, 'SCHD');
        const id = zstr(hd ? hd.subarray(0, 32) : sub(rec, 'NAME')).toLowerCase();
        if (id) scripts.set(id, zstr(sub(rec, 'SCTX')));
      } else if (t === 'SSCR') {
        const id = zstr(sub(rec, 'NAME')).toLowerCase();
        if (id) startup.add(id);
      } else if (t === 'GLOB') {
        const id = zstr(sub(rec, 'NAME')).toLowerCase();
        const v = sub(rec, 'FLTV');
        if (id) globals.set(id, v && v.length >= 4 ? v.readFloatLE(0) : 0);
      } else if (t === 'DIAL') {
        const id = zstr(sub(rec, 'NAME')).toLowerCase();
        const d = sub(rec, 'DATA');
        const type = d && d.length ? d[0] : 0;
        dial = dials.get(id) ?? { id, type, infos: new Map() };
        dial.type = type;
        dials.set(id, dial);
      } else if (t === 'INFO') {
        if (!dial) continue;
        const iid = zstr(sub(rec, 'INAM'));
        const d = sub(rec, 'DATA');
        const conds = [];
        for (let i = 0; i < rec.subs.length; i++) {
          const [k, v] = rec.subs[i];
          if (k !== 'SCVR') continue;
          const s = zstr(v);
          const nx = rec.subs[i + 1];
          let value = null;
          if (nx?.[0] === 'INTV') value = nx[1].readInt32LE(0);
          else if (nx?.[0] === 'FLTV') value = nx[1].readFloatLE(0);
          // index(1) type(1) function(2) comparison(1) name
          conds.push({ type: s[1], fn: s.slice(2, 4), cmp: s[4], name: s.slice(5).toLowerCase(), value });
        }
        dial.infos.set(iid, {
          id: iid,
          index: d && d.length >= 8 ? d.readInt32LE(4) : 0,
          text: zstr(sub(rec, 'NAME')),
          result: zstr(sub(rec, 'BNAM')),
          actor: zstr(sub(rec, 'ONAM')).toLowerCase() || undefined,
          faction: zstr(sub(rec, 'FNAM')).toLowerCase() || undefined,
          rank: d && d.length >= 9 ? d.readInt8(8) : -1,
          cell: zstr(sub(rec, 'ANAM')).toLowerCase() || undefined,
          pcFaction: zstr(sub(rec, 'DNAM')).toLowerCase() || undefined,
          isName: rec.subs.some(([k, v]) => k === 'QSTN' && v.length && v[0]),
          finished: rec.subs.some(([k, v]) => k === 'QSTF' && v.length && v[0]),
          restart: rec.subs.some(([k, v]) => k === 'QSTR' && v.length && v[0]),
          conds,
        });
      } else if (t === 'CELL') {
        const d = sub(rec, 'DATA');
        const flags = d && d.length >= 4 ? d.readUInt32LE(0) : 0;
        const name = zstr(sub(rec, 'NAME'));
        const key = (flags & 1) || !d || d.length < 12 ? name.toLowerCase() : `${d.readInt32LE(4)},${d.readInt32LE(8)}`;
        const cell = cells.get(key) ?? { name: name || key, refs: new Set() };
        cells.set(key, cell);
        // References: after each FRMR, the NAME that follows is the object id.
        let inRef = false;
        for (const [k, v] of rec.subs) {
          if (k === 'FRMR') inRef = true;
          else if (k === 'NAME' && inRef) {
            const obj = zstr(v).toLowerCase();
            cell.refs.add(obj);
            if (!refCells.has(obj)) refCells.set(obj, new Set());
            refCells.get(obj).add(key);
            inRef = false;
          }
        }
      } else {
        // Any record with a SCRI is an object carrying a local script.
        const s = sub(rec, 'SCRI');
        const id = zstr(sub(rec, 'NAME')).toLowerCase();
        if (s && id) {
          const sid = zstr(s).toLowerCase();
          if (!attached.has(sid)) attached.set(sid, []);
          attached.get(sid).push(id);
        }
      }
      if (t !== 'INFO' && t !== 'DIAL') dial = null;
    }
  }
  return { scripts, startup, globals, attached, dials, cells, refCells };
}

/** Scan a load order; returns the four tables and a report. */
export function scan(files) {
  const db = load(files);
  const report = { files, startScriptCalls: 0, startScriptTargets: 0, resolved: 0, unresolved: [], cycles: [] };
  const parsed = new Map();
  const parse = (id) => { if (!parsed.has(id)) parsed.set(id, parseScript(db.scripts.get(id) ?? '')); return parsed.get(id); };

  // Script classes and StartScript accounting.
  const classes = {};
  const cls = (id) => (classes[id] ??= { classes: [], startedBy: [], stoppedBy: [], attachedTo: [] });
  const addClass = (id, c) => { const e = cls(id); if (!e.classes.includes(c)) e.classes.push(c); };
  for (const id of db.scripts.keys()) cls(id);
  for (const id of db.startup) addClass(id, 'startup');
  for (const [sid, objs] of db.attached) { addClass(sid, 'local'); cls(sid).attachedTo.push(...objs); }

  const sources = []; // { from, effects }
  for (const id of db.scripts.keys()) sources.push({ from: `script:${id}`, parsed: parse(id) });
  for (const dial of db.dials.values()) {
    for (const info of dial.infos.values()) {
      if (info.result) sources.push({ from: `info:${dial.id}:${info.id}`, parsed: parseScript(info.result) });
    }
  }
  const unresolvedSeen = new Set(), targets = new Set();
  for (const s of sources) {
    for (const e of s.parsed.effects) {
      const t = e.args[0];
      if (!t || (e.op !== 'startscript' && e.op !== 'stopscript')) continue;
      if (e.op === 'startscript') {
        report.startScriptCalls++;
        targets.add(t);
        if (!db.scripts.has(t)) {
          const k = `${t}|${s.from}`;
          if (!unresolvedSeen.has(k)) { unresolvedSeen.add(k); report.unresolved.push({ target: t, from: s.from, line: e.line }); }
          continue;
        }
        addClass(t, e.ref ? 'targeted' : 'global');
        if (!cls(t).startedBy.includes(s.from)) cls(t).startedBy.push(s.from);
      } else if (db.scripts.has(t) && !cls(t).stoppedBy.includes(s.from)) cls(t).stoppedBy.push(s.from);
    }
  }
  report.startScriptTargets = targets.size;
  report.resolved = [...targets].filter((t) => db.scripts.has(t)).length;

  // Transitive effects of a started script: [{ op, ref, args, via: [...] }].
  const closure = new Map();
  const cycleSeen = new Set();
  const effectsOf = (id, stack) => {
    if (closure.has(id)) return closure.get(id);
    if (stack.includes(id)) {
      const cyc = [...stack.slice(stack.indexOf(id)), id];
      const k = cyc.join('>');
      if (!cycleSeen.has(k)) { cycleSeen.add(k); report.cycles.push(cyc); }
      return null; // cut
    }
    if (!db.scripts.has(id)) return [];
    const out = [];
    let cut = false;
    for (const e of parse(id).effects) {
      out.push({ op: e.op, ref: e.ref, args: e.args, via: [id] });
      if (e.op === 'startscript' && e.args[0]) {
        const sub = effectsOf(e.args[0], [...stack, id]);
        if (sub === null) { cut = true; continue; }
        for (const x of sub) out.push({ ...x, via: [id, ...x.via] });
      }
    }
    if (!cut) closure.set(id, out);
    return out;
  };

  // Stages from journal DIALs.
  const stages = {};
  const quests = {};
  for (const dial of db.dials.values()) {
    if (dial.type !== 4) continue;
    const q = (quests[dial.id] = { name: '', kind: 'side', eligibility: {}, stages: [], branches: [], restarts: [] });
    for (const info of dial.infos.values()) {
      if (info.isName) { q.name = info.text; continue; }
      const key = `${dial.id}:${info.index}`;
      stages[key] = { quest: dial.id, index: info.index, text: info.text, finished: info.finished, effects: [] };
      q.stages.push(info.index);
      if (info.finished) q.branches.push(info.index);
      if (info.restart) q.restarts.push(info.index);
    }
    q.stages.sort((a, b) => a - b);
    q.branches.sort((a, b) => a - b);
  }
  const stageFor = (s) => {
    const key = `${s.quest}:${s.index}`;
    return (stages[key] ??= { quest: s.quest, index: s.index, text: '', finished: false, effects: [], undeclared: true });
  };

  // Attribute every effect (and every followed StartScript's effects) to its stages.
  for (const s of sources) {
    for (const e of s.parsed.effects) {
      if (!e.stages.length) continue;
      const list = [{ op: e.op, ref: e.ref, args: e.args, via: [] }];
      if (e.op === 'startscript' && e.args[0]) {
        const sub = effectsOf(e.args[0], s.from.startsWith('script:') ? [s.from.slice(7)] : []);
        if (sub) list.push(...sub);
      }
      for (const st of e.stages) {
        const stage = stageFor(st);
        for (const x of list) {
          // A stage's own Journal call setting itself is not an effect of that stage.
          if ((x.op === 'journal' || x.op === 'setjournalindex') && x.args[0] === st.quest && Number(x.args[1]) === st.index && !x.via.length) continue;
          stage.effects.push({ op: x.op, ...(x.ref ? { ref: x.ref } : {}), args: x.args, source: s.from, ...(x.via.length ? { via: x.via } : {}) });
        }
      }
    }
  }

  // Eligibility and kind: from the INFOs (any DIAL) whose result sets the quest's first stage.
  const firstSetters = new Map();
  for (const dial of db.dials.values()) {
    for (const info of dial.infos.values()) {
      if (!info.result) continue;
      for (const st of parseScript(info.result).stagesSet) {
        const q = quests[st.quest];
        if (!q || st.index !== q.stages[0]) continue;
        if (!firstSetters.has(st.quest)) firstSetters.set(st.quest, []);
        firstSetters.get(st.quest).push({ dial: dial.id, info });
      }
    }
  }
  for (const [qid, setters] of firstSetters) {
    const q = quests[qid];
    const el = { givers: [], factions: [], minRank: null, cells: [], requires: [], globals: [] };
    const add = (arr, v) => { if (v !== undefined && v !== null && !arr.includes(v)) arr.push(v); };
    for (const { dial, info } of setters) {
      add(el.givers, info.actor ?? `topic:${dial}`);
      add(el.factions, info.faction);
      if (info.faction && info.rank >= 0) el.minRank = el.minRank === null ? info.rank : Math.min(el.minRank, info.rank);
      add(el.cells, info.cell);
      for (const c of info.conds) {
        const cmp = ['==', '!=', '>', '>=', '<', '<='][Number(c.cmp)] ?? '?';
        if (c.type === '4' && c.name !== qid) add(el.requires, `${c.name}${cmp}${c.value}`);
        if (c.type === '2') add(el.globals, `${c.name}${cmp}${c.value}`);
      }
    }
    q.eligibility = el;
    q.kind = el.factions.length ? 'faction' : /^(a1|a2|b\d|c3)_/.test(qid) ? 'main' : 'side';
  }

  // Phase keys per cell: a stage touches a cell when one of its effects names a ref placed there,
  // or names the cell directly (PositionCell / PlaceItemCell / ModRegion-style cell args).
  const cellTable = {};
  const touch = (cellKey, stageKey) => {
    const c = db.cells.get(cellKey);
    const e = (cellTable[cellKey] ??= { name: c?.name ?? cellKey, phaseKeys: [] });
    if (!e.phaseKeys.includes(stageKey)) e.phaseKeys.push(stageKey);
  };
  for (const [key, st] of Object.entries(stages)) {
    for (const e of st.effects) {
      const ids = [e.ref, ...(e.op === 'placeitemcell' || e.op === 'additem' || e.op === 'placeatpc' || e.op === 'placeatme' ? [e.args[0]] : [])];
      for (const id of ids) if (id) for (const ck of db.refCells.get(id) ?? []) touch(ck, key);
      if (e.op === 'positioncell') { const cn = e.args[e.args.length - 1]; if (cn && db.cells.has(cn)) touch(cn, key); }
      if (e.op === 'placeitemcell') { const cn = e.args[1]; if (cn && db.cells.has(cn)) touch(cn, key); }
    }
  }
  for (const c of Object.values(cellTable)) c.phaseKeys.sort();

  return { cells: cellTable, quests, stages, scriptClasses: classes, report };
}

export function writeTables(outDir, t) {
  mkdirSync(outDir, { recursive: true });
  const w = (f, v) => writeFileSync(join(outDir, f), JSON.stringify(v, null, 1) + '\n');
  w('phase-cells.json', t.cells);
  w('phase-quests.json', t.quests);
  w('phase-stages.json', t.stages);
  w('script-classes.json', t.scriptClasses);
  w('phase-scan-report.json', t.report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const outDir = opt('--out-dir');
  const dataDir = opt('--data-dir');
  if (!outDir) { console.error('usage: scan-quests.mjs --out-dir <dir> (--data-dir <Data Files> | <content files...>)'); process.exit(2); }
  const files = dataDir ? loadOrderFrom(dataDir) : args;
  if (!files.length) { console.error('no content files given'); process.exit(2); }
  const t = scan(files);
  writeTables(outDir, t);
  const r = t.report;
  console.log(`${files.length} files: ${Object.keys(t.quests).length} quests, ${Object.keys(t.stages).length} stages, ${Object.keys(t.cells).length} phased cells, ${Object.keys(t.scriptClasses).length} scripts`);
  console.log(`StartScript: ${r.startScriptCalls} calls, ${r.startScriptTargets} targets, ${r.resolved} resolved, ${r.unresolved.length} unresolved, ${r.cycles.length} cycles`);
  for (const u of r.unresolved) console.log(`  unresolved: ${u.target} (from ${u.from} line ${u.line})`);
  for (const c of r.cycles) console.log(`  cycle: ${c.join(' -> ')}`);
}
