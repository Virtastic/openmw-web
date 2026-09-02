#!/usr/bin/env node
// Protocol-level health check: connect, complete the omw-mp.2 hello, expect SessionHelloOk.
// Zero dependencies (Node >= 22 global WebSocket + fetch) so it runs anywhere — including
// inside the production image or a bare runner. Used by deploy-mp.yml as a health gate.
//
// Usage:
//   node healthcheck.mjs [target] [--allow-refusal=CODE[,CODE...]]
//
//   target = ws://host:port/ws     dial a WORLD's socket directly (local dev, tests)
//   target = http://host:port      the REAL client flow: GET /worlds on the gateway, take the
//                                  first world's wsPath (/w/<worldId>) and dial it on the same
//                                  host — through the gateway's upgrade splice, exactly like a
//                                  browser. The gateway itself has no /ws route (502 by
//                                  design; deploy/Caddyfile), so probing the gateway MUST go
//                                  through /w/*.
//   default: ws://127.0.0.1:8080/ws
//
// --allow-refusal: treat a clean SessionDisconnect with one of these codes as healthy. A
// tier-2 world pins the sim peer's content list as canonical, so this data-less bot's empty
// manifest is ALWAYS refused BAD_CONTENT there — after the gateway routed the upgrade,
// spliced to the world, negotiated the subprotocol and parsed the hello. That refusal is the
// protocol working. Opt-in (deploy-mp.yml passes it) so dev-mode checks stay strict.
//
// Exit 0 on HelloOk (or an allowed refusal) within the timeout; nonzero otherwise with a
// reason on stderr.

const args = process.argv.slice(2);
const allowRefusal = new Set(
  args.filter((a) => a.startsWith('--allow-refusal='))
    .flatMap((a) => a.slice('--allow-refusal='.length).split(',').filter(Boolean)),
);
const target = args.find((a) => !a.startsWith('--')) ?? 'ws://127.0.0.1:8080/ws';
const TIMEOUT_MS = 8000;

const fail = (msg) => {
  console.error(`healthcheck FAIL: ${msg}`);
  process.exit(1);
};

const timer = setTimeout(() => fail(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);

// http(s) target: ask the directory where to dial, like the launcher does.
let wsUrl = target;
if (/^https?:\/\//.test(target)) {
  const base = target.replace(/\/+$/, '');
  let dir;
  try {
    const res = await fetch(`${base}/worlds`);
    if (!res.ok) fail(`GET /worlds returned HTTP ${res.status}`);
    dir = await res.json();
  } catch (e) {
    fail(`GET /worlds failed: ${e.message}`);
  }
  const world = (dir.worlds ?? [])[0];
  if (!world?.wsPath) fail('directory lists no worlds (no public world running?)');
  wsUrl = base.replace(/^http/, 'ws') + world.wsPath;
  console.log(`healthcheck: directory says dial ${world.wsPath} (world '${world.id}')`);
}

let ws;
try {
  ws = new WebSocket(wsUrl, ['omw-mp.2']);
} catch (e) {
  fail(`bad url: ${e.message}`);
}

ws.addEventListener('open', () => {
  if (ws.protocol !== 'omw-mp.2') fail(`server accepted wrong subprotocol '${ws.protocol}'`);
  // Empty manifest: with content policy "names" and an empty server this becomes the session's
  // canonical manifest; the bot disconnects immediately after, resetting it. Harmless. On a
  // tier-2 world it is refused BAD_CONTENT instead — see --allow-refusal above.
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
