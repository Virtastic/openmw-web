// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// THE FRONT DOOR: sign in, then straight into the world.
//
// This page used to link at launcher.html, which is the wrong destination for a self-hosted
// server. The launcher is a CHOOSER, asking whether you want the bundled sample game, your
// own local Morrowind files, or multiplayer, and none of those questions apply to somebody
// who has arrived at your server to play on it. So the sign-in happens here and the game
// page is booted directly.
//
// ONLY THE METHODS THE OPERATOR ENABLED ARE DRAWN. The launcher renders the full provider
// line-up and greys off the ones that are disabled, which suits a storefront advertising
// what is coming. A server's front door is not that: an option nobody here can use is a dead
// end wearing a button.
//
// A separate file because the page's CSP is script-src 'self': inline script does not run.

(async () => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NICE = { google: 'Google', discord: 'Discord', microsoft: 'Microsoft' };
  const ICONS = window.PROVIDER_ICONS || {}; // providers.js; absent = plain labelled buttons

  const note = (msg, kind = '') => {
    const el = $('#note');
    el.className = `note ${kind}`;
    el.innerHTML = msg;
    el.hidden = !msg;
  };

  // The player app is served from the same origin. Absent means no release has been staged,
  // which is the operator's problem to fix and not something to hide from them.
  let hasClient = false;
  try { hasClient = (await fetch('/index.html', { method: 'HEAD' })).ok; } catch { /* stays false */ }
  $('#noclient').hidden = hasClient;

  // WHICH KIND OF SERVER THIS IS. The wizard's answer decides which of the two boot modes the
  // player lands in, and it must be read before anybody signs in, because the mode is baked
  // into the fragment handed over at that moment.
  //
  // Defaulting to multiplayer when this cannot be read would be the wrong way round: it is
  // the mode that needs a running world, and offering it when the state is unknown produces
  // a connection attempt to a server that may not simulate anything. Single player only needs
  // the locker, which is always there.
  let singlePlayer = true;
  // The other wizard answer that changes what the game page is told: 'serve' means the
  // operator's own library is published and nobody uploads anything, 'verify' means each
  // player brings their own copy through their locker.
  let hostedData = false;
  try {
    const s = await (await fetch('/admin/api/state')).json();
    if (s.serverName) { $('#name').textContent = s.serverName; document.title = s.serverName; }
    singlePlayer = s.setup?.deploymentMode !== 'multiplayer';
    hostedData = s.setup?.deliveryModel === 'serve';
  } catch { /* keep the default heading, and the safer mode */ }
  // The launcher's words for the two modes, and its cloud glyph for the single-player one.
  $('#title').textContent = singlePlayer ? 'Sign in to play anywhere' : 'Sign in to play together';
  const CLOUD_GLYPH = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">'
    + '<path d="M14 34h20a7 7 0 0 0 .6-13.97A10 10 0 0 0 15.2 18.4 6.6 6.6 0 0 0 14 34z"/>'
    + '<path d="M24 22v10M20 28l4 4 4-4"/></svg>';
  if (singlePlayer) $('#glyph').innerHTML = CLOUD_GLYPH;

  let auth = null;
  try { auth = await (await fetch('/auth/providers')).json(); } catch { /* handled below */ }
  const box = $('#options');
  if (!auth) {
    box.innerHTML = '<div class="note">Could not reach the server to ask how sign-in works. '
      + 'It may be starting up. Try again in a moment.</div>';
    return;
  }

  // In NICE's order (the launcher's: Google, Discord, Microsoft), not the config's.
  const providers = Object.keys(NICE).filter((p) => (auth.providers || []).includes(p));
  if (!auth.allowPasswordLogin && !providers.length) {
    box.innerHTML = '<div class="note">This server has no sign-in method switched on yet. '
      + 'Its operator can turn one on in the <a href="/admin">admin dashboard</a>.</div>';
    return;
  }

  let out = '';
  if (auth.allowPasswordLogin) {
    out += '<form id="pwForm" autocomplete="on">'
      + '<label class="fld"><span>Username</span>'
      + '<input id="pwName" name="username" autocomplete="username" required></label>'
      + '<label class="fld"><span>Password</span>'
      + '<input id="pwPass" name="password" type="password" autocomplete="current-password" required></label>'
      + '<button class="btn primary" type="submit" id="pwGo">Play now</button></form>';
  }
  // THE INVITE PASSPHRASE. An invite-only server checks it when an SSO sign-in would create a
  // new account, but nothing used to ask for it, so every new player hit invite_required.
  // Prefilled from ?invite=, which makes https://<server>/?invite=<passphrase> the invite link.
  const invited = new URLSearchParams(location.search).get('invite') || '';
  if (providers.length) {
    if (auth.allowPasswordLogin) out += '<div class="rule">or</div>';
    if (auth.inviteRequired) {
      out += '<label class="fld"><span>Invite passphrase</span>'
        + `<input id="invite" autocomplete="off" spellcheck="false" value="${esc(invited)}"></label>`;
    }
    for (const p of providers) {
      out += `<a class="prov" href="/auth/${esc(p)}/start">${ICONS[p] || ''}<span>Continue with ${NICE[p]}</span></a>`;
    }
  }
  box.innerHTML = out;
  if (auth.inviteRequired) {
    // Read at click time, so what was typed is what is sent. The server checks it only when
    // the sign-in would create an account; a returning player's is ignored.
    for (const a of box.querySelectorAll('a.prov')) {
      a.addEventListener('click', () => {
        const u = new URL(a.href);
        const v = $('#invite').value.trim();
        if (v) u.searchParams.set('invite', v); else u.searchParams.delete('invite');
        a.href = u.href;
      });
    }
  }

  if (auth.allowRegistration === false) {
    note('This server is not taking new players: sign-in works for existing accounts, but new '
      + 'ones cannot be created here.');
  } else if (auth.inviteRequired) {
    note('New players need the invite passphrase from whoever runs this server. '
      + 'Returning players can leave it empty.');
  }

  /**
   * Hand the ticket to the game page.
   *
   * Single player: the ticket is the whole handshake, and the game page boots straight away.
   *
   * Multiplayer: this front door is a GATEWAY, and a gateway's socket accepts only /w/<id>
   * (booting #mp=wss://host/ws here dialled a door that does not exist: 502, "could not be
   * reached", forever). The launcher is the page that asks the gateway for a profile, a
   * character list and a world to put them in (/auth/profile, /auth/characters), so the
   * ticket goes there, in the same fragment an SSO round trip comes back with -- its
   * handleSsoReturn takes over from here.
   *
   * In the FRAGMENT, never the query: a ticket is a credential, and a fragment is not sent
   * to a server, written to an access log, or leaked through Referer.
   */
  const enterGame = (res) => {
    const acct = res.account ? `&mpaccount=${encodeURIComponent(res.account)}` : '';
    // The token always rides along: it is what buys server-side saves, whichever library the
    // game data itself comes from. mwdata=1 is what picks the library.
    const lock = res.locker ? `&mplocker=${encodeURIComponent(res.locker)}` : '';
    const data = hostedData ? '&mwdata=1' : '';

    // SINGLE PLAYER IS THE ABSENCE OF mp=, NOT A FLAG. index.html decides it is a multiplayer
    // session purely from mp= being present, so sending one unconditionally — which this did
    // — put a single-player server into multiplayer: the game announced itself as MULTIPLAYER
    // and tried to join a world that, in this mode, nothing is simulating. cloud=1 is what the
    // launcher sends for the same mode, and index.html's own gate looks for it.
    if (singlePlayer) {
      location.href = '/index.html'
        + `#locker=${encodeURIComponent(location.origin)}${lock}${acct}${data}&cloud=1`;
      return;
    }

    location.href = '/launcher.html'
      + `#mpticket=${encodeURIComponent(res.ticket)}`
      + acct
      + lock;
  };

  const form = $('#pwForm');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const go = $('#pwGo');
      const label = go.textContent;
      go.disabled = true; go.textContent = 'Signing in…';
      note('');
      try {
        const r = await fetch('/auth/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: $('#pwName').value.trim(), password: $('#pwPass').value }),
        });
        const body = await r.json();
        if (!r.ok) {
          note(esc(body.error || 'Could not sign in.'), 'err');
        } else if (!hasClient) {
          note('Signed in, but the player app has not been added to this server yet, so '
            + 'there is nothing to launch.', 'err');
        } else {
          enterGame(body);
          return; // navigating away; leave the button as it is
        }
      } catch {
        note('Could not reach the server. It may be restarting.', 'err');
      }
      go.disabled = false; go.textContent = label;
    };
  }

  // An SSO round trip returns here with the ticket in the fragment. Carry it into the game
  // exactly as the password path does, so both doors end in the same place.
  const hash = location.hash || '';
  const tk = /[#&]mpticket=([^&]+)/.exec(hash);
  if (tk) {
    const acct = /[#&]mpaccount=([^&]+)/.exec(hash);
    const lock = /[#&]mplocker=([^&]+)/.exec(hash);
    history.replaceState(null, '', location.pathname);
    if (hasClient) {
      enterGame({
        ticket: decodeURIComponent(tk[1]),
        account: acct ? decodeURIComponent(acct[1]) : '',
        locker: lock ? decodeURIComponent(lock[1]) : '',
      });
    } else {
      note('Signed in, but the player app has not been added to this server yet.', 'err');
    }
  }
  const err = /[#&]mperror=([^&]+)/.exec(hash);
  if (err) {
    history.replaceState(null, '', location.pathname);
    // Words for the codes a player can act on; anything else keeps the code for a bug report.
    const code = decodeURIComponent(err[1]);
    const said = {
      invite_required: 'That invite passphrase was not right. Check it with whoever runs this server.',
      invite_locked: 'Too many invite passphrase attempts. Wait a while before trying again.',
      registration_disabled: 'This server is not taking new players.',
    }[code];
    note(said ? esc(said) : `Sign-in did not finish (${esc(code)}). Try again.`, 'err');
  }
})();
