// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s179: A FRIEND ON A SECOND MACHINE, over the LAN, on plain http.
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
// The front door (/play) is served once setup is done and an owner exists.
export const serverRules = `
[setup]
completed = true
`;

export default async function run(ctx) {
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!lan) { ctx.log('SKIP: this box has no non-loopback IPv4 address to play the second machine from'); return; }

  const relayTo = async (target) => {
    const srv = http.createServer((req, res) => {
      const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
        (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(up);
    });
    await new Promise((r) => srv.listen(0, lan, r));
    return srv;
  };
  const relay = await relayTo(PLAY), door = await relayTo(ctx.serverPort);
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
      url: `http://${lan}:${port}/index.html#mp=1`, noAuto: true, expectStuckLoading: true, // the refusal stops the boot
      waitExpr: '!!document.getElementById("omw-fatal")', waitWhat: 'the game page gave its verdict',
    });
    const g = await game.eval('document.getElementById("omw-fatal").innerText');
    ctx.log(`LAN game page: ${JSON.stringify(g.slice(0, 160))}`);
    assert.match(g, /HTTPS/, 'the game page must name the insecure page, not the browser');
    // THE SERVER'S FRONT DOOR, where a self-host's LAN friend actually arrives (/ -> /play).
    // It must say so BEFORE they sign in; the loopback door must not.
    const owner = await fetch(`http://127.0.0.1:${ctx.serverPort}/admin/api/setup/owner`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lan-owner@example.com', password: 'a-long-enough-passphrase' }) });
    assert.equal(owner.status, 200, `owner creation: ${await owner.text()}`);
    const noteOf = async (name, url) => {
      const c = await ctx.launchClient(name, '', { url, noAuto: true, expectStuckLoading: true,
        waitExpr: 'document.readyState === "complete" && !!document.getElementById("note")', waitWhat: 'the front door loaded' });
      await ctx.sleep(3000); // the page asks the server how it signs people in, then draws
      return c.eval('(function(){ var n = document.getElementById("note"); return n.hidden ? "" : n.innerText; })()');
    };
    const nearDoor = await noteOf('lan-door-local', `http://127.0.0.1:${ctx.serverPort}/play`);
    const farDoor = await noteOf('lan-door-friend', `http://${lan}:${door.address().port}/play`);
    ctx.log(`front door: loopback note ${JSON.stringify(nearDoor)}; LAN note ${JSON.stringify(farDoor)}`);
    assert.doesNotMatch(nearDoor, /plain http/i, 'the loopback front door must not turn its own operator away');
    assert.match(farDoor, /https:\/\//,'the LAN front door must say to use https:// before anyone signs in');
    ctx.log('ok: a LAN friend on plain http is told to use https:// (or localhost on the host), not to change browsers');
  } finally {
    relay.close(); door.close();
  }
}
