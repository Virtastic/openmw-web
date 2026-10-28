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

  // A FRIEND ON THE LAN OVER PLAIN HTTP cannot run the game: the engine needs cross-origin
  // isolation, which browsers grant only to https:// (or this computer's own localhost). Say it
  // here, before they sign in, rather than on the game page after (backlog 508, s179).
  if (!self.isSecureContext) {
    note('This page is plain <b>http://</b>, and the game only runs on a secure page. Use this '
      + "server's <b>https://</b> address, or play on the server machine itself at "
      + '<b>http://localhost</b>.', 'err');
  }

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
    // no-store, like the dashboard's api(): a browser that once cached a 308 for this URL
    // (a proxy's redirect loop) replayed it forever, the read failed, and the page fell back
    // to single player on a multiplayer server, sending a signed-in player to the wrong game.
    const s = await (await fetch('/admin/api/state', { cache: 'no-store' })).json();
    if (s.serverName) { $('#name').textContent = s.serverName; document.title = s.serverName; }
    singlePlayer = s.setup?.deploymentMode !== 'multiplayer';
    hostedData = s.setup?.deliveryModel === 'serve';
  } catch { /* keep the default heading, and the safer mode */ }
  // The launcher's words for the two modes, and its cloud glyph for the single-player one.
  $('#title').textContent = singlePlayer ? 'Sign in to play anywhere' : 'Sign in to play together';
  // Locker servers: players bring the game. Said BEFORE sign-in, or the first they hear of it is
  // the upload wizard after a world was already started for them (prod 2026-10-13, never_joined).
  $('#bring').hidden = hostedData;
  const CLOUD_GLYPH = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">'
    + '<path d="M14 34h20a7 7 0 0 0 .6-13.97A10 10 0 0 0 15.2 18.4 6.6 6.6 0 0 0 14 34z"/>'
    + '<path d="M24 22v10M20 28l4 4 4-4"/></svg>';
  if (singlePlayer) $('#glyph').innerHTML = CLOUD_GLYPH;

  // CHROME OR EDGE ON A COMPUTER, SAID BEFORE SIGN-IN. The engine is a wasm64 build that only
  // Chromium runs; a Firefox or Safari player used to sign in, wait for a download and only then
  // meet "Browser not supported" on the game page. The brand is what decides it (Firefox 134+
  // passes the memory64 probe and still cannot carry the game), the probe catches an old
  // Chromium, and the phone test is the launcher's (engineUnsupported). Insecure pages are
  // already explained above, and they hide the brand list, so they are not judged here.
  const unsupported = (() => {
    if (/[?&]forceUnsupported\b/.test(location.search)) return true;
    const chromium = !!navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium');
    let mem64 = true;
    try { new WebAssembly.Memory({ initial: 1n, maximum: 2n, address: 'i64' }); } catch { mem64 = false; }
    const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const phone = touch && Math.min(innerWidth, innerHeight) < 820 && Math.max(innerWidth, innerHeight) < 1100;
    return !chromium || !mem64 || phone;
  })();
  if (self.isSecureContext && unsupported) {
    $('#options').innerHTML = '<div class="note err">This game runs in <b>Chrome</b> or <b>Edge</b> '
      + 'on a desktop or laptop. Open this page there.</div>'
      + '<button class="btn" type="button" id="copyLink">Copy this link</button>';
    const copy = $('#copyLink');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); copy.textContent = 'Link copied'; }
      catch { copy.textContent = location.href; }
    };
    return;
  }

  let auth = null;
  try { auth = await (await fetch('/auth/providers', { cache: 'no-store' })).json(); } catch { /* handled below */ }
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
  // PASSWORD SIGN-UP. The same form creates an account when the server allows it
  // (POST /auth/password/register): a password-only server had no way in for a new player at
  // all, so an "invite only" server's invite link opened a sign-in form nobody new could pass.
  // The invite field and the password rule show only while creating an account.
  const canSignup = !!(auth.allowPasswordLogin && auth.allowPasswordSignup);
  if (auth.allowPasswordLogin) {
    out += '<form id="pwForm" autocomplete="on">'
      + '<label class="fld"><span>Username</span>'
      + '<input id="pwName" name="username" autocomplete="username" required></label>'
      + '<label class="fld"><span>Password</span>'
      + '<input id="pwPass" name="password" type="password" autocomplete="current-password" required>'
      + '<small id="pwRule" hidden>At least 12 characters, and not your username.</small></label>'
      + (canSignup && auth.inviteRequired
        ? '<label class="fld" id="pwInviteFld" hidden><span>Invite code</span>'
          + '<input id="pwInvite" name="invite" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128"></label>'
        : '')
      + '<button class="btn primary" type="submit" id="pwGo">Play now</button></form>'
      + (canSignup ? '<p class="swap" id="pwSwapLine"><span id="pwSwapText">New player?</span> '
        + '<a href="#" id="pwSwap">Create an account</a></p>' : '');
  }
  // THE INVITE LINK. An invite-only server checks the passphrase when an SSO sign-in would
  // create a new account. Players never type it: it rides in https://<server>/?invite=<code>,
  // the link the dashboard hands out. Kept for the tab, so a redirect that drops the query
  // (the front door bouncing through /join) does not lose it.
  let invited = new URLSearchParams(location.search).get('invite') || '';
  try {
    if (invited) sessionStorage.setItem('omwmp:invite', invited);
    else invited = sessionStorage.getItem('omwmp:invite') || '';
  } catch { /* storage blocked: the query is all there is */ }
  // A REFUSED INVITE IS A STALE ONE, and it must be forgotten BEFORE the links are drawn: the
  // refusal lands back on this page, which re-read the stored code and put it on every provider
  // link again, so the obvious retry sent the same wrong code (s176). Only the storage was
  // cleared, further down, after the links already carried it.
  if (/[#&]mperror=invite_required(&|$)/.test(location.hash)) {
    invited = '';
    try { sessionStorage.removeItem('omwmp:invite'); } catch { /* blocked */ }
  }
  if (providers.length) {
    if (auth.allowPasswordLogin) out += '<div class="rule">or</div>';
    for (const p of providers) {
      out += `<a class="prov" href="/auth/${esc(p)}/start">${ICONS[p] || ''}<span>Continue with ${NICE[p]}</span></a>`;
    }
  }
  box.innerHTML = out;
  // Remembered for a refused 'state' (below): the link that was clicked, invite and all.
  box.addEventListener('click', (e) => {
    const a = e.target.closest('a.prov');
    if (!a) return;
    try { sessionStorage.setItem('omwmp:prov', a.href); } catch { /* blocked */ }
  });
  // One place an invite code goes, whichever field it was typed in: kept for the tab, put on
  // every provider link (the server checks it only when a sign-in would create an account; a
  // returning player's is ignored), and mirrored into the other field.
  const setInvite = (raw, from) => {
    const code = String(raw || '').trim();
    try { if (code) sessionStorage.setItem('omwmp:invite', code); else sessionStorage.removeItem('omwmp:invite'); } catch { /* blocked */ }
    for (const a of box.querySelectorAll('a.prov')) {
      const u = new URL(a.href);
      if (code) u.searchParams.set('invite', code); else u.searchParams.delete('invite');
      a.href = u.href;
    }
    for (const id of ['#inviteCode', '#pwInvite']) {
      const el = $(id);
      if (el && el !== from && el.value.trim() !== code) el.value = code;
    }
  };
  if (auth.inviteRequired && invited) setInvite(invited);

  // WHERE TO GET A CODE: shown on the invite form AND on a refused sign-in. The refusal note
  // replaces the form's note, so it carried no link at all (prod 2026-10-19: 36 refused sign-ins
  // from ~24 people, every one told only to ask "whoever runs it").
  const helpLink = typeof auth.inviteHelpUrl === 'string' && /^https:\/\//.test(auth.inviteHelpUrl)
    ? ` <a href="${esc(auth.inviteHelpUrl)}" rel="noopener">Join our Discord to get the invite code.</a>` : '';
  const help = helpLink || ' Ask whoever runs it for the invite code.';
  if (auth.allowRegistration === false) {
    note('This server is not taking new players: sign-in works for existing accounts, but new '
      + 'ones cannot be created here.');
  } else if (auth.inviteRequired && !invited && providers.length) {
    // NEW PLAYERS TYPE THE CODE. An invite link is not always how a code travels (a Discord
    // post, a friend reading it out), so the code can also be typed here; it then rides on
    // every provider link exactly as an invite link's would. Returning players ignore it.
    const form = document.createElement('form');
    form.id = 'inviteForm';
    form.innerHTML = '<label class="fld"><span>Invite code (new players only)</span>'
      + '<input id="inviteCode" name="invite" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128"></label>';
    box.prepend(form);
    const apply = () => setInvite($('#inviteCode').value, $('#inviteCode'));
    // THE BUTTONS ARE NEVER GREYED. 1.7.6 held them shut until a code was typed or this browser
    // remembered a sign-in, which locked returning players out on any new browser or cleared
    // storage (2026-10-26). The server refuses a new account without a code; that is the gate.
    $('#inviteCode').addEventListener('input', apply);
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
    note('This server is invite-only. New players: enter your invite code above, then pick a sign-in. '
      + 'Returning players sign in as usual.' + help);
  } else if (auth.inviteRequired && !invited && canSignup) {
    // Password only: the code goes in the sign-up form's own field.
    note('This server is invite-only. New players: choose <b>Create an account</b> and enter your '
      + 'invite code. Returning players sign in as usual.' + help);
  } else if (!providers.length && !canSignup) {
    // Password only, sign-up off ([login].allowPasswordSignup): nothing on this page makes an
    // account, so say where one comes from instead of leaving a new player at a sign-in form.
    note('New players: the server owner creates accounts here, so ask them for yours. '
      + 'Returning players sign in as usual.');
  }

  // SIGN IN or CREATE AN ACCOUNT. Starts on "create" for somebody who arrived on an invite link
  // and has never signed in from this browser: that is a new player, and the link was sent so
  // they could join. Everyone else starts on sign-in.
  let signup = false;
  const setSignup = (on) => {
    signup = on;
    $('#pwPass').autocomplete = on ? 'new-password' : 'current-password';
    $('#pwRule').hidden = !on;
    const fld = $('#pwInviteFld');
    if (fld) fld.hidden = !on;
    // The top invite form (there for the provider buttons) would be a second field asking for
    // the same code; the sign-up form's own field feeds the provider links too.
    const top = $('#inviteForm');
    if (top) top.hidden = on && !!fld;
    $('#pwGo').textContent = on ? 'Create account and play' : 'Play now';
    $('#pwSwapText').textContent = on ? 'Already have an account?' : 'New player?';
    $('#pwSwap').textContent = on ? 'Sign in' : 'Create an account';
  };
  if (canSignup && $('#pwForm')) {
    $('#pwSwap').addEventListener('click', (e) => { e.preventDefault(); setSignup(!signup); note(''); });
    const pi = $('#pwInvite');
    if (pi) pi.addEventListener('input', () => setInvite(pi.value, pi));
    let returning = false;
    try { returning = localStorage.getItem('omwmp:returning') === '1'; } catch { /* blocked */ }
    if (auth.allowRegistration !== false && invited && !returning) setSignup(true);
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
    try { localStorage.setItem('omwmp:returning', '1'); } catch { /* blocked */ }
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

    // /join, not /launcher.html: the same multiplayer steps (username, character, world) with
    // the hosted site's demo chooser stripped away. See DOOR MODE in play/launcher.html.
    location.href = '/join'
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
      const creating = signup;
      go.disabled = true; go.textContent = creating ? 'Creating your account…' : 'Signing in…';
      note('');
      try {
        const name = $('#pwName').value.trim();
        const r = await fetch(creating ? '/auth/password/register' : '/auth/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(creating
            ? { name, password: $('#pwPass').value, invite: ($('#pwInvite')?.value || invited || '').trim() }
            : { name, password: $('#pwPass').value }),
        });
        const body = await r.json();
        if (!r.ok) {
          // A refused code is a stale one: forgotten, so a retry is not sent with it again.
          if (body.code === 'invite_required') {
            invited = '';
            try { sessionStorage.removeItem('omwmp:invite'); } catch { /* blocked */ }
          }
          note(esc(body.error || (creating ? 'Could not create the account.' : 'Could not sign in.'))
            + (body.code === 'invite_required' ? help : ''), 'err');
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
    const code = decodeURIComponent(err[1]); // a refused invite was already forgotten, above
    // A LOST STATE COOKIE IS RETRIED ONCE, SILENTLY. The callback came back without the cookie
    // its start set (a phone handing the provider page to another app, Back, a reload): 36 of
    // those in a week, and 30 of the 33 people never tried again. The same link usually works.
    if (code === 'state') {
      let again = '';
      try {
        const last = Number(sessionStorage.getItem('omwmp:stateRetry') || 0);
        if (Date.now() - last > 120000) again = sessionStorage.getItem('omwmp:prov') || '';
        if (again) sessionStorage.setItem('omwmp:stateRetry', String(Date.now()));
      } catch { /* blocked: say it instead */ }
      if (again.startsWith(location.origin + '/auth/')) { location.href = again; return; }
    }
    // The codes server/src/auth/routes.ts sends back, in the launcher's words (handleSsoReturn).
    const said = {
      registration_disabled: 'This server is not taking new players.',
      invite_required: 'This server is invite-only, and that sign-in had no working invite code. '
        + 'Enter the code above and sign in again.',
      invite_locked: 'Too many attempts with a wrong invite code. Wait a while before trying again.',
      banned: 'This account is banned from this server.',
      link_conflict: 'That sign-in is already linked to a different account. Sign in with the account it belongs to, or use another provider.',
      provider_disabled: 'That sign-in provider is switched off on this server. Pick another.',
      unknown_provider: 'That sign-in provider is not set up on this server. Pick another.',
      disabled: 'That sign-in provider is switched off on this server. Pick another.',
      provider_refused: 'The sign-in was cancelled, or the provider said no. Pick a sign-in to try again.',
      provider_unreachable: 'The sign-in provider could not be reached. Try again in a moment.',
      discovery: 'The sign-in provider could not be reached. Try again in a moment.',
      network: 'The sign-in provider could not be reached. Try again in a moment.',
      http: 'The sign-in provider answered with an error. Try again in a moment.',
      busy: 'The sign-in provider is busy. Try again in a moment.',
      rate: 'Too many sign-in attempts from your connection. Wait a minute and try again.',
      not_signed_in: 'Your session has ended. Sign in again.',
      state: 'The sign-in did not come back to this browser tab. Sign in again from this page, in this tab.',
      bad_callback: 'The sign-in came back incomplete. Try again.',
      account: 'The server could not set up your account. Try again; if it keeps happening, tell whoever runs this server.',
    }[code];
    note(said ? esc(said) + (code === 'invite_required' ? helpLink : '')
      : `Sign-in did not finish (${esc(code.replace(/_/g, ' '))}). Try again.`, 'err');
  }
})();
