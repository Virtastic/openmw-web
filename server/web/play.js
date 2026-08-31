// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The sign-in landing page's logic. A separate file because the page's CSP is
// script-src 'self': inline script does not run, and the login options are the one part
// of that page that cannot be static.
(async () => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The game client (launcher.html and the engine) is staged separately from the server.
  // Present: every option leads into it. Absent: say so honestly instead of a dead link.
  let hasClient = false;
  try { hasClient = (await fetch('/launcher.html', { method: 'HEAD' })).ok; } catch { /* stays false */ }
  $('#noclient').hidden = hasClient;

  // Server name for the heading. Best effort; the page works without it.
  try {
    const s = await (await fetch('/admin/api/state')).json();
    if (s.serverName) { $('#name').textContent = s.serverName; document.title = s.serverName; }
  } catch { /* keep the default heading */ }

  const NICE = { discord: 'Discord', google: 'Google', microsoft: 'Microsoft' };
  let auth = null;
  try { auth = await (await fetch('/auth/providers')).json(); } catch { /* handled below */ }

  const box = $('#options');
  if (!auth) {
    box.innerHTML = '<div class="note">Could not reach the server to ask how sign-in works. '
      + 'It may be starting up. Try again in a moment.</div>';
    return;
  }

  let out = '';
  const sso = (auth.providers || []).filter((p) => NICE[p]);

  // THE BUTTON IS SHOWN EVEN WITH NO CLIENT STAGED. It used to be conditional on both the
  // password method AND the client being present, so a server without the game files
  // rendered a heading, a warning, and nothing to click: a sign-in page with no way to sign
  // in. Whether the game is installed is the operator's problem and is already said above;
  // it is not a reason to hide the door.
  if (auth.allowPasswordLogin) {
    out += hasClient
      ? '<a class="btn primary" href="/launcher.html">Play now (username &amp; password)</a>'
      : '<span class="btn primary disabled" aria-disabled="true">Play now (player app not added)</span>';
  }
  if (sso.length) {
    if (auth.allowPasswordLogin) out += '<div class="rule">or continue with</div>';
    for (const p of sso) {
      out += `<a class="btn" href="/auth/${esc(p)}/start">Continue with ${NICE[p]}</a>`;
    }
  }
  if (!auth.allowPasswordLogin && !sso.length) {
    out = '<div class="note">This server has no sign-in method switched on yet. '
      + 'Its operator can fix that in the <a href="/admin">admin dashboard</a>.</div>';
  } else if (auth.allowRegistration === false) {
    out += '<p class="sub" style="margin-top:1rem">This server is invite-only: sign-in works '
      + 'for existing accounts, but new ones cannot be created.</p>';
  }
  box.innerHTML = out;
})();
