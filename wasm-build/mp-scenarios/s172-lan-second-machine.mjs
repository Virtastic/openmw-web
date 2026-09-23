// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s172: A FRIEND ON A SECOND MACHINE, over the LAN, on plain http.
//
// Every other scenario loads the game from 127.0.0.1, which browsers treat as a secure context.
// A friend across the room types http://<host's LAN address>, and that is NOT one: no secure
// context, no cross-origin isolation, no SharedArrayBuffer, no engine. The launcher used to fail
// them with the phone message -- "This needs a desktop browser" -- while they sat at a desktop,
// which sends them hunting for a browser update that cannot help.
//
// The play server listens on loopback only, so a relay on this box's own LAN address stands in
// for the second machine's route to the host: same bytes, a non-loopback origin.
import assert from 'node:assert/strict';
import http from 'node:http';
import { networkInterfaces } from 'node:os';

const PLAY = 8910; // play/server.py's fixed port

export default async function run(ctx) {
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!lan) { ctx.log('SKIP: this box has no non-loopback IPv4 address to play the second machine from'); return; }

  const relay = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: PLAY, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => relay.listen(0, lan, r));
  const port = relay.address().port;
  try {
    // THE CONTROL: the same launcher from loopback is a secure, isolated page and shows no gate.
    const local = await ctx.launchClient('lan-control', '', {
      url: `http://127.0.0.1:${PLAY}/launcher.html`, noAuto: true,
      waitExpr: 'document.readyState === "complete" && !!document.getElementById("unsupported")', waitWhat: 'the launcher loaded',
    });
    const l = await local.eval('({ secure: self.isSecureContext, isolated: self.crossOriginIsolated, gate: !document.getElementById("unsupported").hidden })');
    ctx.log(`loopback launcher: ${JSON.stringify(l)}`);
    assert.deepEqual(l, { secure: true, isolated: true, gate: false }, 'from loopback the launcher must let the player in');

    // THE SECOND MACHINE.
    const far = await ctx.launchClient('lan-friend', '', {
      url: `http://${lan}:${port}/launcher.html`, noAuto: true,
      waitExpr: 'document.readyState === "complete" && !!document.getElementById("unsupported")', waitWhat: 'the launcher loaded over the LAN',
    });
    const f = await far.eval(`({ secure: self.isSecureContext, gate: !document.getElementById('unsupported').hidden,
      reason: document.getElementById('unsupported').dataset.reason || '',
      heading: document.querySelector('#unsupported h2').textContent,
      lead: document.querySelector('#unsupported .lead').textContent })`);
    ctx.log(`LAN launcher: ${JSON.stringify(f)}`);
    assert.equal(f.secure, false, 'the fixture must actually be an insecure origin');
    assert.equal(f.gate, true, 'an engine that cannot run here must be said up front, not fail on the game page');
    assert.equal(f.reason, 'insecure', 'the gate must name the insecure page as the reason');
    assert.doesNotMatch(f.heading, /desktop browser/i, 'a desktop player on the LAN was told to find a desktop browser');
    assert.match(f.lead, /https:\/\//, 'the player is told what works: the https:// address');

    // And the game page itself, reached by a direct link, says the same instead of "not supported".
    const game = await ctx.launchClient('lan-game', '', {
      url: `http://${lan}:${port}/index.html#mp=1`, noAuto: true,
      waitExpr: '!!document.getElementById("omw-fatal")', waitWhat: 'the game page gave its verdict',
    });
    const g = await game.eval('document.getElementById("omw-fatal").innerText');
    ctx.log(`LAN game page: ${JSON.stringify(g.slice(0, 160))}`);
    assert.match(g, /HTTPS/, 'the game page must name the insecure page, not the browser');
    ctx.log('ok: a LAN friend on plain http is told to use https:// (or localhost on the host), not to change browsers');
  } finally {
    relay.close();
  }
}
