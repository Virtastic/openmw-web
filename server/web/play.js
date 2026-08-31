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

  const NICE = { discord: 'Discord', google: 'Google', microsoft: 'Microsoft' };

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

  try {
    const s = await (await fetch('/admin/api/state')).json();
    if (s.serverName) { $('#name').textContent = s.serverName; document.title = s.serverName; }
  } catch { /* keep the default heading */ }

  let auth = null;
  try { auth = await (await fetch('/auth/providers')).json(); } catch { /* handled below */ }
  const box = $('#options');
  if (!auth) {
    box.innerHTML = '<div class="note">Could not reach the server to ask how sign-in works. '
      + 'It may be starting up. Try again in a moment.</div>';
    return;
  }

  const providers = (auth.providers || []).filter((p) => NICE[p]);
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
  if (providers.length) {
    if (auth.allowPasswordLogin) out += '<div class="rule">or</div>';
    for (const p of providers) {
      out += `<a class="btn" href="/auth/${esc(p)}/start">Continue with ${NICE[p]}</a>`;
    }
  }
  box.innerHTML = out;

  if (auth.allowRegistration === false) {
    note('This server is invite-only: sign-in works for existing accounts, but new ones '
      + 'cannot be created here.');
  }

  /**
   * Hand the ticket to the game page.
   *
   * A self-hosted server is ONE world, so none of the launcher's platform steps apply: it
   * asks a gateway for a profile, a character list and a world to put them in, and those
   * routes (/auth/profile, /auth/characters) exist only in the gateway build. Here the
   * ticket is the whole handshake, because that is all the connection path wants: the engine
   * sends SessionLoginTicket and the server answers SessionWelcome.
   *
   * In the FRAGMENT, never the query: a ticket is a credential, and a fragment is not sent
   * to a server, written to an access log, or leaked through Referer.
   */
  const enterGame = (res) => {
    const ws = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    location.href = '/index.html'
      + `#mp=${encodeURIComponent(ws)}`
      + `&mpticket=${encodeURIComponent(res.ticket)}`
      + (res.account ? `&mpaccount=${encodeURIComponent(res.account)}` : '')
      + `&locker=${encodeURIComponent(location.origin)}`
      + (res.locker ? `&mplocker=${encodeURIComponent(res.locker)}` : '')
      + (res.name ? `&mpcharname=${encodeURIComponent(res.name)}` : '');
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
    note(`Sign-in did not finish (${esc(decodeURIComponent(err[1]))}). Try again.`, 'err');
  }
})();
