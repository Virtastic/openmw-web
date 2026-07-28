// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Phase 3.8 web admin dashboard. The platform plan's own note is that the admin UI is "a
// client for an API that already exists" — the M8 command set is server-side, rank-gated
// and audited — so this adds the two surfaces that were missing rather than a second
// permission model:
//
//   GET  /admin                  the page (one self-contained HTML file, no build step)
//   GET  /admin/api/overview     world + players + anomaly counters
//   GET  /admin/api/reports      the moderation queue
//   POST /admin/api/action       kick | ban | unban | mute | unmute | broadcast | resetCell
//
// AUTH is a bearer token ([admin].dashboardToken), not an account rank, and empty token
// means the routes do not exist at all. A moderator opening a browser is a different
// threat model from a player typing /kick: this endpoint can act on any account without
// being in the world, so it gets its own credential that an operator can rotate without
// touching anyone's rank.
//
// Actions are deliberately a small closed set. The dashboard is for moderation, not for
// arbitrary server control: /console ships Lua to a player's machine and stays owner-only
// in-game where the audit trail names a person, not a token.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../log';

export interface AdminDashboardDeps {
  token: string;
  overview(): unknown;
  reports(limit: number): Promise<unknown>;
  action(kind: string, target: string, detail: string): Promise<{ ok: boolean; message: string }>;
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// One file, no framework, no CDN: a moderation tool has to work on a phone on bad hotel
// wifi at 2am, and every dependency is one more thing that can be unreachable exactly
// then. The token is held in sessionStorage so a refresh does not lose it, and never in
// the URL where it would land in logs and history.
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>openmw-mp admin</title>
<style>
:root{color-scheme:dark light}
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1rem;max-width:70rem;margin-inline:auto}
h1{font-size:1.1rem;margin:0 0 1rem}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}
th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #8884}
th{font-weight:600;opacity:.7;font-size:.85em}
button{font:inherit;padding:.2rem .5rem;margin-right:.25rem;cursor:pointer}
input{font:inherit;padding:.3rem}
.bad{color:#c33}.ok{color:#2a2}.muted{opacity:.6}
#login{display:flex;gap:.5rem;margin-bottom:1rem}
pre{white-space:pre-wrap;font-size:.85em;background:#8881;padding:.5rem;border-radius:4px}
</style>
<h1>openmw-mp admin</h1>
<div id=login><input id=token type=password placeholder="dashboard token" size=40><button onclick=save()>connect</button></div>
<div id=app hidden>
  <div id=world class=muted></div>
  <h2 style="font-size:1rem">Players</h2><table id=players></table>
  <h2 style="font-size:1rem">Reports</h2><table id=reports></table>
  <div><input id=msg placeholder="broadcast message" size=50><button onclick=act('broadcast','',msg.value)>send</button></div>
  <div id=out></div>
</div>
<script>
const T=()=>sessionStorage.getItem('t')||'';
function save(){sessionStorage.setItem('t',token.value);load()}
async function api(p,o={}){const r=await fetch(p,{...o,headers:{...(o.headers||{}),authorization:'Bearer '+T()}});
  if(r.status===401){out.innerHTML='<p class=bad>bad token</p>';return null}return r.json()}
async function act(kind,target,detail){const r=await api('/admin/api/action',{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({kind,target,detail:detail||''})});
  if(r)out.innerHTML='<p class="'+(r.ok?'ok':'bad')+'">'+esc(r.message)+'</p>';load()}
const esc=s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
async function load(){const o=await api('/admin/api/overview');if(!o)return;
  document.getElementById('app').hidden=false;document.getElementById('login').hidden=true;
  world.textContent=o.world.id+' ('+o.world.mode+') · '+o.players.length+'/'+o.maxPlayers+' players · up '+o.uptime+'s';
  players.innerHTML='<tr><th>name<th>account<th>cell<th>rank<th>anomalies<th>actions'+o.players.map(p=>
    '<tr><td>'+esc(p.name)+'<td class=muted>'+esc(p.account)+'<td>'+esc(p.cellKey||'-')+'<td>'+p.rank+
    '<td>'+(Object.entries(p.anomalies||{}).map(([k,v])=>k+'='+v).join(' ')||'<span class=muted>none</span>')+
    '<td><button onclick="act(\\'kick\\',\\''+esc(p.account)+'\\')">kick</button>'+
    '<button onclick="act(\\'mute\\',\\''+esc(p.account)+'\\')">mute</button>'+
    '<button onclick="act(\\'ban\\',\\''+esc(p.account)+'\\')">ban</button>').join('');
  const rs=await api('/admin/api/reports');if(!rs)return;
  reports.innerHTML='<tr><th>when<th>reporter<th>target<th>reason'+(rs.reports||[]).map(r=>
    '<tr><td class=muted>'+esc(r.ts)+'<td>'+esc(r.reporter)+'<td>'+esc(r.target)+'<td>'+esc(r.reason)).join('');
}
if(T())load();
</script>`;

export function adminDashboardRoutes(deps: AdminDashboardDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!path.startsWith('/admin')) return false;
    if (deps.token === '') return false; // disabled: the route does not exist

    if (req.method === 'GET' && path === '/admin') {
      // The page itself is not secret — it cannot do anything without the token — so it is
      // served unauthenticated. Everything under /admin/api is not.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return true;
    }

    if (!bearerOk(req.headers.authorization, deps.token)) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (req.method === 'GET' && path === '/admin/api/overview') {
      json(res, 200, deps.overview());
      return true;
    }
    if (req.method === 'GET' && path === '/admin/api/reports') {
      json(res, 200, await deps.reports(Number(url.searchParams.get('limit') ?? 20)));
      return true;
    }
    if (req.method === 'POST' && path === '/admin/api/action') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) { json(res, 413, { error: 'too large' }); return true; }
      }
      let parsed: { kind?: string; target?: string; detail?: string };
      try { parsed = JSON.parse(body || '{}') as typeof parsed; }
      catch { json(res, 400, { error: 'bad json' }); return true; }
      const result = await deps.action(String(parsed.kind ?? ''), String(parsed.target ?? ''), String(parsed.detail ?? ''));
      log('info', 'admin.dashboard_action', { kind: parsed.kind, target: parsed.target, ok: result.ok });
      json(res, result.ok ? 200 : 400, result);
      return true;
    }
    json(res, 404, { error: 'not found' });
    return true;
  };
}
