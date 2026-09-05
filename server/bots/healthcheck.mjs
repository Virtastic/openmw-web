#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// Protocol health check: prove a WORLD answers the wire protocol, the way a player reaches
// one. Exit 0 = healthy, 1 = not.
//
//   node healthcheck.mjs [target] [--server-token-file=PATH | --server-token=TOKEN]
//                                 [--allow-refusal=CODE[,CODE...]] [--probe-id=ID]
//
//   target = ws://host:port/ws     dial this endpoint directly (single-world server)
//   target = http://host:port      the REAL client flow against a gateway: GET /worlds and dial
//                                  the first listed world. NO WORLD RUNS AT BOOT on a correctly
//                                  configured platform ([worlds] publicEnabled is off; players
//                                  get their own on demand), so with an empty directory and a
//                                  platform credential the probe CREATES one -- POST /worlds as
//                                  the platform, exactly what the game does after sign-in --
//                                  which spawns a world process and its sim peer, waits for it
//                                  to come up, dials it and says hello. A fixed --probe-id so
//                                  every run reuses one small world dir; the gateway's
//                                  never-joined reaper stops the process 15 minutes later.
//                                  With NO credential an explicitly empty list is healthy (the
//                                  contract ci/jenkins/smoke-test.sh already encodes) -- the
//                                  protocol path is then simply unexercised, and says so.
//
// --allow-refusal: treat a clean SessionDisconnect with one of these codes as healthy. A
//   probe with an empty manifest is refused BAD_CONTENT by a tier-2 world; the refusal itself
//   proves the hello path -- the world parsed the hello and answered on the protocol.
//
// The credential is the gateway's self-minted `gateway-token` (see [gateway] serverToken in
// config.default.toml). Read from a file so it never appears in a process list.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const allowRefusal = new Set((opt('allow-refusal') ?? '').split(',').filter(Boolean));
const probeId = opt('probe-id') ?? 'deploy-healthcheck';
const target = args.find((a) => !a.startsWith('--')) ?? 'ws://127.0.0.1:8080/ws';
const DIAL_TIMEOUT_MS = 8000;
// A cold world is a node process that must bind its port; its sim peer (a headless engine
// loading retail data) is NOT waited for -- `up` means the world answered a status poll.
const WORLD_UP_TIMEOUT_MS = 60_000;

const fail = (msg) => {
  console.error(`healthcheck FAIL: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = opt('server-token') ?? '';
const tokenFile = opt('server-token-file');
if (tokenFile) {
  try { token = readFileSync(tokenFile, 'utf8').trim(); } catch (e) { fail(`cannot read ${tokenFile}: ${e.message}`); }
  if (!token) fail(`${tokenFile} is empty`);
}

let wsUrl = target;
if (/^https?:\/\//.test(target)) {
  const base = target.replace(/\/+$/, '');
  const getJson = async (path) => {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    return res.json();
  };
  let dir;
  try { dir = await getJson('/worlds'); } catch (e) { fail(e.message); }
  if (!Array.isArray(dir.worlds)) fail(`GET /worlds answered without a worlds list: ${JSON.stringify(dir).slice(0, 200)}`);
  let world = dir.worlds[0];

  if (!world && token) {
    // Create one as the platform. mode=party: no character behind it, so nothing is derived
    // from an account and nothing follows a player home.
    let res;
    try {
      res = await fetch(`${base}/worlds`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: probeId, mode: 'party', account: probeId }),
      });
    } catch (e) { fail(`POST /worlds failed: ${e.message}`); }
    if (res.status === 401) fail("POST /worlds refused the platform credential (401): the token file does not match the gateway's");
    if (res.status === 503) fail('POST /worlds: no capacity for another world (503) -- the host is full before a single player joined');
    if (!res.ok) fail(`POST /worlds returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    world = await res.json();
    console.log(`healthcheck: created probe world '${world.id}' (mode ${world.mode ?? '?'}); waiting for it to come up`);
    const deadline = Date.now() + WORLD_UP_TIMEOUT_MS;
    while (!world.up) {
      if (Date.now() > deadline) fail(`world '${probeId}' did not come up in ${WORLD_UP_TIMEOUT_MS / 1000}s (the world process never answered a status poll -- see 'world.' events in the gateway log)`);
      await sleep(1000);
      try { world = await getJson(`/worlds/${encodeURIComponent(probeId)}`); } catch (e) { fail(`world '${probeId}' vanished while starting: ${e.message}`); }
    }
  }
  if (!world) {
    if (dir.worlds.length === 0) {
      console.log('healthcheck OK: /worlds answers with an empty list (no public world by design; worlds are made on demand). No credential given, so the protocol path was not exercised.');
      process.exit(0);
    }
    fail('directory lists no worlds and none could be created');
  }
  if (!world.wsPath) fail(`world '${world.id}' has no wsPath`);
  wsUrl = base.replace(/^http/, 'ws') + world.wsPath;
  console.log(`healthcheck: dialling ${world.wsPath} (world '${world.id}', up=${world.up})`);
}

const timer = setTimeout(() => fail(`timeout after ${DIAL_TIMEOUT_MS}ms waiting for HelloOk on ${wsUrl}`), DIAL_TIMEOUT_MS);
let ws;
try {
  ws = new WebSocket(wsUrl, ['omw-mp.2']);
} catch (e) {
  fail(`bad url: ${e.message}`);
}
ws.addEventListener('open', () => {
  if (ws.protocol !== 'omw-mp.2') fail(`server accepted wrong subprotocol '${ws.protocol}'`);
  ws.send(JSON.stringify({ t: 'SessionHello', proto: 2, engineHash: '', lserVersion: 0, manifest: [] }));
});
ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
  } catch {
    return; // ignore non-JSON (binary) frames
  }
  if (msg.t === 'SessionHelloOk') {
    clearTimeout(timer);
    console.log(`healthcheck OK: ${wsUrl} server='${msg.serverName ?? ''}' policy=${msg.contentPolicy ?? '?'}`);
    ws.close();
    process.exit(0);
  }
  if (msg.t === 'SessionDisconnect') {
    if (allowRefusal.has(msg.code)) {
      clearTimeout(timer);
      console.log(`healthcheck OK: ${wsUrl} refused ${msg.code} (allowed — protocol path is up)`);
      ws.close();
      process.exit(0);
    }
    fail(`server refused: ${msg.code} ${msg.detail ?? ''}`);
  }
});
ws.addEventListener('error', () => fail(`connection error to ${wsUrl}`));
ws.addEventListener('close', (ev) => fail(`closed before HelloOk (code ${ev.code})`));
