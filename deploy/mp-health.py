#!/usr/bin/env python3
# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
"""Multiplayer health from the gateway log: what is breaking, for whom, and how often.

    ssh <box> 'python3 - --hours 24' < deploy/mp-health.py

Reads /var/log/openmw-mp/openmw-mp.log (+ .1, and .N.gz) -- the JSON lines the gateway, every world
and the sim peer write, plus each browser's /clientlog lines (errors and the 5 s [telemetry]). Prints
one plain report: the join funnel, smoothness, and every kind of failure ranked by count, so a new
problem shows up as a new line near the top instead of something to go digging for.
stdlib only: the box has python3, not node.
"""
import argparse, glob, gzip, json, re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

ap = argparse.ArgumentParser()
ap.add_argument('--hours', type=float, default=24)
ap.add_argument('--log', default='/var/log/openmw-mp/openmw-mp.log')
args = ap.parse_args()
since = (datetime.now(timezone.utc) - timedelta(hours=args.hours)).strftime('%Y-%m-%dT%H:%M:%S')

def lines():
    for path in sorted(glob.glob(args.log + '*'), reverse=True):
        op = gzip.open if path.endswith('.gz') else open
        try:
            with op(path, 'rt', errors='replace') as f:
                for raw in f:
                    if raw.startswith('{') and raw[7:26] >= since:
                        try: yield json.loads(raw)
                        except ValueError: pass
        except OSError:
            pass

ev = Counter(); warn = Counter(); sso_fail = Counter(); drops = Counter(); reaped = Counter()
client_err = Counter(); peer_err = Counter(); accounts = set(); joined = set()
path95, path_max, snaps, first_unheld, hold_capped = [], [], 0, 0, 0
slow_reads = Counter()
no_pose = Counter()  # windows with a drawn NPC that has no pose stream of its own (npcNoPose), by record
facing_n = facing_bad = 0  # walking NPCs drawn >120 deg off the server's heading (180s)
hitch = hitch_sfs = hidden_w = 0  # visible windows with a frame >= 500 ms; of those, >= 300 ms waiting on streamed reads
hitch_pf = [0, 0]  # those windows' slow streamed reads: [named by the cell prefetch already, never named] (sfsSlowPf)
rtt50, rtt95, switch_ms, self_snaps, play_s = [], [], [], 0, 0.0
npc_worst = Counter()  # visible windows' worst-off NPC (>= 300 u): record (puppet | run locally)
seen_session = set(); lua_errors = 0; err_sessions = defaultdict(set); data_setup = {}
num = lambda s: re.sub(r'\d[\d.:x]*', 'N', s)
f = lambda t, k: (re.search(k + r'=(\S+)', t) or [None, None])[1]

for e in lines():
    name = e.get('event', '?'); ev[name] += 1
    if e.get('level') in ('warn', 'error') and name not in ('client.log', 'simpeer.output'):
        warn[f"{e.get('level')} {name}"] += 1
    if name == 'auth.sso_ok': accounts.add(e.get('account'))
    elif name == 'auth.sso_failed': sso_fail[e.get('code', '?')] += 1
    elif name == 'player.join_world': joined.add(e.get('name'))
    elif name == 'net.rtt':  # server-measured, per player per 5 min (connection.ts flushRtt)
        rtt50.append(e.get('p50', 0)); rtt95.append(e.get('p95', 0))
    elif name == 'world.reaped': reaped[(e.get('reason') or 'idle') + ('' if e.get('played') is None else f" played={e.get('played')}")] += 1
    # A PLAYER's refused action only. The sim peer's own late frames after a hand-off (a burst of
    # ActorEquip / ActorDisposition when a new player takes Seyda Neen, 2026-10-21) are dropped by
    # design and read as a scripting fault here; they stay in the raw warning counts below.
    elif name in ('combat.dropped', 'actor.dropped', 'object.dropped', 'object.out_of_reach', 'state.dropped') \
            and not str(e.get('from', '')).startswith('simpeer'):
        drops[f"{name}: {e.get('why') or e.get('name', '')}" + (f" [{e['spellId']}]" if e.get('spellId') else '')] += 1
    elif name == 'simpeer.output':
        t = e.get('text', '')
        if 'Lua error' in t or "Can't start" in t or ' E]' in t:
            peer_err[num(t.split(']', 1)[-1].strip())[:140]] += 1
            if 'Lua error' in t: lua_errors += 1
    elif name == 'client.log':
        t, s = e.get('text', ''), e.get('session', '?')
        if t.startswith('[telemetry]'):
            if ' hidden=1' not in t:
                play_s += 5
                w = f(t, 'npcWorst')  # index.html: record:distance:p|l
                if w:
                    parts = w.split(':')
                    npc_worst[f"{parts[0]} ({'puppet' if parts[-1] == 'p' else 'run locally'})"] += 1
            m = re.search(r'npcPath p50=\d+ p95=(\d+) max=(\d+)', t)
            sn = f(t, 'snaps')
            if sn and sn.isdigit(): snaps += int(sn)
            if ' hidden=1' in t: hidden_w += 1
            else:
                wf = re.search(r'worstFrameMs=(\d+)', t); ss = re.search(r'sfsStallMs=(\d+)', t)
                if wf and int(wf[1]) >= 500:
                    hitch += 1
                    if ss and int(ss[1]) >= 300: hitch_sfs += 1
                    pf = re.search(r'sfsSlowPf=(\d+)/(\d+)', t)
                    if pf: hitch_pf[0] += int(pf[1]); hitch_pf[1] += int(pf[2])
            mf = re.search(r'npcFacing bad=(\d+) n=(\d+)', t)
            if mf: facing_bad += int(mf[1]); facing_n += int(mf[2])
            if s not in seen_session and ' settling=1' not in t and ' chargen=1' not in t:
                seen_session.add(s)
                if f(t, 'holder') == 'none' and f(t, 'cell') not in (None, '?'): first_unheld += 1
            # A background tab runs no frames while poses keep arriving: its puppets read as off
            # their paths (363 of 1532 windows, 2026-10-16/18). Visible windows only.
            if m and ' hidden=1' not in t: path95.append(int(m[1])); path_max.append(int(m[2]))
            np = f(t, 'npcNoPose')
            if np and np.isdigit() and int(np):
                for rec in (f(t, 'noPoseRec') or '?').split(','): no_pose[rec] += 1
        elif t.startswith('[boot] '):
            v = f(t, 'switchMs')  # click -> playable in the destination world (index.html)
            if v and v.isdigit(): switch_ms.append(int(v))
            # The settle hold let the player in on its +10 s cap, the cell still unheld (index.html).
            if f(t, 'holdCapped'): hold_capped += 1
        elif 'SELF SNAP' in t:
            self_snaps += 1
        elif t.startswith('[sfs] slow read '):
            # The streamed files a player waited on, by name (index.html, 2026-10-21): what to warm next.
            slow_reads[t.split()[3].split('@')[0]] += 1
        elif re.match(r'\[(mw|assets|data|boot)\] |\[[\d:.]+ I\] ', t):
            data_setup[s] = data_setup.get(s, 0) + 1  # info, not an error (#139 ships the boot's data setup)
        elif not t.startswith('[locker]'):
            if 'Lua error' in t: lua_errors += 1
            k = num(t)[:140]; client_err[k] += 1; err_sessions[k].add(s)

def q(a, p): return sorted(a)[min(len(a) - 1, int(p * len(a)))] if a else '-'
def top(c, n=12): return '\n'.join(f'  {v:6d}  {k}' for k, v in c.most_common(n)) or '  (none)'

print(f'== OpenMW-Web multiplayer health, last {args.hours:g} h (since {since}Z)')
print(f'players signed in: {len(accounts)}   joined a world: {len(joined)}   sessions with telemetry: {len(seen_session)}')
print(f"funnel: sso ok {ev['auth.sso_ok']} | profile {ev['frontdoor.profile_set']} | new characters {ev['frontdoor.character_provisional']}"
      f" | worlds started {ev['world.started']} | joins {ev['player.join_world']} | friends added {ev['social.friend_added']}")
print(f"sign-ins refused:\n{top(sso_fail)}")
print(f"worlds reaped:\n{top(reaped)}")
print(f"stuck on the loading screen 5 min (settle timeout): {sum(v for k, v in client_err.items() if 'settle hold released' in k)}")
print(f"smoothness: NPC path p95 per 5 s window -- median {q(path95, .5)}, p90 {q(path95, .9)}, p99 {q(path95, .99)}, max {q(path_max, 1)} u"
      f" ({len(path95)} windows) | snaps {snaps} | sessions whose first window was unheld {first_unheld}"
      f" | let in unheld on the hold's cap {hold_capped}")
print(f"network: round trip (server-measured) median p50 {q(rtt50, .5)} ms, p95 of p95s {q(rtt95, .95)} ms ({len(rtt50)} samples)"
      f" | own body pulled back (SELF SNAP) {self_snaps} = {self_snaps / max(play_s / 3600, 1e-9):.1f}/h over {play_s / 3600:.1f} h played")
print(f"world switches: click to playable p50 {q(switch_ms, .5)} ms, p95 {q(switch_ms, .95)} ms ({len(switch_ms)} switches)")
print(f"NPCs drawn 300 u+ off their server path, worst per visible 5 s window:\n{top(npc_worst, 8)}")
print(f"NPCs drawn with no pose stream of their own (5 s windows, by record):\n{top(no_pose, 6)}")
print(f"hitches: {hitch} visible windows with a frame of 500 ms or more, {hitch_sfs} of them waiting 300 ms+ on streamed game files"
      f" (their slow reads: {hitch_pf[0]} already named by the cell prefetch, {hitch_pf[1]} never named) | {hidden_w} windows in a background tab (not counted)")
print(f"facing: walking NPCs drawn turned round (>120 deg off the server) {facing_bad}/{facing_n} samples" + (f" ({100 * facing_bad / facing_n:.1f}%)" if facing_n else ''))
print(f'Lua errors (peer + clients): {lua_errors}')
print(f"sim peer start failures: {ev['simpeer.start_timeout']}   peer errors:\n{top(peer_err, 8)}")
print(f"refused player actions (a thing a player did that did nothing):\n{top(drops)}")
print(f"streamed files the game waited on (>300 ms), by file:\n{top(slow_reads)}")
# Ranked by how many SESSIONS hit it: one tab left open logged 2,986 copies of one error.
print('browser errors, by sessions that hit them [lines]:')
print('\n'.join(f'  {len(v):4d} sessions [{client_err[k]:5d}]  {k}'
                for k, v in sorted(err_sessions.items(), key=lambda kv: -len(kv[1]))[:12]) or '  (none)')
print(f"server warnings/errors by event:\n{top(warn)}")
