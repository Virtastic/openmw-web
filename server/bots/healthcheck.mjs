#!/usr/bin/env node
// Protocol-level health check: connect, complete the omw-mp.1 hello, expect SessionHelloOk.
// Zero dependencies (Node >= 22 global WebSocket) so it runs anywhere — including inside the
// production image or a bare runner. Used by deploy-mp.yml as the third health gate.
//
// Usage: node healthcheck.mjs [ws://host:port/ws]   (default ws://127.0.0.1:8080/ws)
// Exit 0 on HelloOk within the timeout; nonzero otherwise with a reason on stderr.

const url = process.argv[2] ?? 'ws://127.0.0.1:8080/ws';
const TIMEOUT_MS = 8000;

const fail = (msg) => {
  console.error(`healthcheck FAIL: ${msg}`);
  process.exit(1);
};

const timer = setTimeout(() => fail(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);

let ws;
try {
  ws = new WebSocket(url, ['omw-mp.1']);
} catch (e) {
  fail(`bad url: ${e.message}`);
}

ws.addEventListener('open', () => {
  if (ws.protocol !== 'omw-mp.1') fail(`server accepted wrong subprotocol '${ws.protocol}'`);
  // Empty manifest: with content policy "names" and an empty server this becomes the session's
  // canonical manifest; the bot disconnects immediately after, resetting it. Harmless.
  ws.send(JSON.stringify({ t: 'SessionHello', proto: 1, engineHash: '', lserVersion: 0, manifest: [] }));
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
    console.log(`healthcheck OK: ${url} server='${msg.serverName ?? ''}' policy=${msg.contentPolicy ?? '?'}`);
    ws.close();
    process.exit(0);
  }
  if (msg.t === 'SessionDisconnect') fail(`server refused: ${msg.code} ${msg.detail ?? ''}`);
});

ws.addEventListener('error', () => fail(`connection error to ${url}`));
ws.addEventListener('close', (ev) => fail(`closed before HelloOk (code ${ev.code})`));
