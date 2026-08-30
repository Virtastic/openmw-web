// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// The admin dashboard, as one vanilla ES module. No framework and no build step: this file
// is served exactly as it is written, which means what you read here is what runs, and a
// stack trace points at a real line. The server is the only source of truth — this page
// holds no state a reload would not rebuild.
//
// The session token lives in sessionStorage, never a cookie: nothing is auto-attached by
// the browser, so there is no cross-site request forgery surface to defend against.

// ---------------------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tagged template that escapes every interpolation. Opt out deliberately with raw(). */
const html = (strings, ...vals) => strings.reduce(
  (out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
const raw = (s) => ({ __raw: s });

const $ = (sel) => document.querySelector(sel);
const view = () => $('#view');

// ---------------------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------------------
const TOKEN_KEY = 'omwmp_admin_token';
const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) || '',
  set: (t) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

let state = { firstRun: true, authed: false, role: null, name: null, maintenance: { on: false } };

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token.get()) headers.authorization = `Bearer ${token.get()}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/admin/api${path}`, {
    ...opts,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && token.get()) {
    // The session died under us — expired, revoked, or the account was demoted. Send the
    // operator back to the door rather than leaving a page that silently does nothing.
    token.clear();
    await refreshState();
    go('#login');
    throw new Error('signed out');
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty body is fine for some 2xx */ }
  if (!res.ok) throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

async function refreshState() {
  try {
    state = await api('/state');
  } catch {
    state = { firstRun: false, authed: false, role: null, name: null, maintenance: { on: false } };
  }
  paintChrome();
}

// ---------------------------------------------------------------------------------------
// chrome: toasts, confirm, nav
// ---------------------------------------------------------------------------------------
function toast(message, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${kind} border-0`;
  el.setAttribute('role', 'alert');
  el.innerHTML = html`<div class="d-flex"><div class="toast-body">${message}</div>
    <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $('#toasts').append(el);
  const t = new bootstrap.Toast(el, { delay: kind === 'danger' ? 8000 : 4000 });
  t.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

/**
 * One confirmation path for every irreversible action. `typeToConfirm` demands the operator
 * retypes an exact string — reserved for things with no undo at all, where a mis-aimed
 * click on a phone would otherwise be enough.
 */
function confirmAction({ title, body, danger = 'Confirm', typeToConfirm = null }) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').innerHTML = body;
    const wrap = $('#confirmTypeWrap');
    const input = $('#confirmType');
    wrap.hidden = !typeToConfirm;
    input.value = '';
    if (typeToConfirm) $('#confirmTypeLabel').textContent = `Type “${typeToConfirm}” to confirm`;
    const go = $('#confirmGo');
    go.textContent = danger;
    go.disabled = !!typeToConfirm;
    const onInput = () => { go.disabled = input.value !== typeToConfirm; };
    input.addEventListener('input', onInput);

    const modalEl = $('#confirmModal');
    const modal = new bootstrap.Modal(modalEl);
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      input.removeEventListener('input', onInput);
      go.removeEventListener('click', onGo);
      modal.hide();
      resolve(val);
    };
    const onGo = () => finish(true);
    go.addEventListener('click', onGo);
    modalEl.addEventListener('hidden.bs.modal', () => finish(false), { once: true });
    modal.show();
  });
}

const NAV = [
  { group: 'Server', items: [
    { hash: '#overview', label: 'Overview', icon: '▣', role: 'viewer' },
    { hash: '#console', label: 'Players & commands', icon: '⌘', role: 'moderator' },
    { hash: '#mods', label: 'Game data & mods', icon: '⛁', role: 'viewer' },
  ] },
  { group: 'Configuration', items: [
    { hash: '#settings', label: 'Settings', icon: '⚙', role: 'viewer' },
    { hash: '#setup', label: 'Setup wizard', icon: '✦', role: 'owner' },
  ] },
  { group: 'People', items: [
    { hash: '#accounts', label: 'Accounts', icon: '☺', role: 'moderator' },
    { hash: '#sessions', label: 'Admin sessions', icon: '🔑', role: 'owner' },
    { hash: '#security', label: 'My security', icon: '🛡', role: 'viewer' },
  ] },
  { group: 'Diagnostics', items: [
    { hash: '#logs', label: 'Logs', icon: '☰', role: 'moderator' },
    { hash: '#audit', label: 'Audit trail', icon: '✓', role: 'moderator' },
    { hash: '#metrics', label: 'Metrics', icon: '📈', role: 'moderator' },
  ] },
  { group: 'Danger zone', items: [
    { hash: '#maintenance', label: 'Maintenance & restart', icon: '⏻', role: 'owner' },
    { hash: '#help', label: 'Help & docs', icon: '?', role: 'viewer' },
  ] },
];

const RANK = { viewer: 0, moderator: 1, owner: 2 };
const can = (need) => state.authed && RANK[state.role] >= RANK[need];

function paintChrome() {
  const nav = $('#mainNav');
  const current = location.hash || '#overview';
  if (!state.authed) { nav.innerHTML = ''; }
  else {
    nav.innerHTML = NAV.map((g) => {
      const items = g.items.filter((i) => can(i.role));
      if (!items.length) return '';
      return html`<li class="nav-header">${g.group}</li>` + items.map((i) => html`
        <li class="nav-item">
          <a href="${i.hash}" class="nav-link ${raw(i.hash === current ? 'active' : '')}">
            <span class="nav-icon me-2">${i.icon}</span><p>${i.label}</p>
          </a>
        </li>`).join('');
    }).join('');
  }
  $('#btnLogout').hidden = !state.authed;
  $('#topUser').textContent = state.authed ? `${state.name} · ${state.role}` : '';
  $('#sidebarFooter').textContent = state.authed ? '' : 'not signed in';

  const m = $('#topMaintenance');
  m.innerHTML = state.maintenance?.on
    ? html`<span class="badge text-bg-warning">maintenance mode</span>` : '';

  // These two slots existed in the markup from the start and nothing ever wrote to them, so
  // the top bar carried a permanent blank gap and the footer an empty version.
  $('#topWorld').textContent = state.serverName || '';
  $('#footVersion').textContent = state.version ? `v${state.version}` : '';

  const banner = $('#banner');
  banner.innerHTML = state.configFallback
    ? html`<div class="alert alert-warning">
        <strong>Configuration was rolled back.</strong> The settings last saved here failed to
        load, so the server started from an earlier version (<code>${state.configFallback}</code>)
        instead. Nothing was lost — review Settings and save again.
      </div>` : '';
}

function setTitle(title, lead = '') {
  $('#pageTitle').textContent = title;
  $('#pageLead').textContent = lead;
}

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ---------------------------------------------------------------------------------------
// first run: the setup wizard
// ---------------------------------------------------------------------------------------
// Order is deliberate and each answer narrows the next question: identity, then what kind of
// server this is, then everything that only makes sense given that answer. A single-player
// deployment never sees the questions that only matter with strangers on the box.
const BLANK_ANSWERS = {
  deploymentMode: null, loginMethods: ['password'], contentProfile: null,
  deliveryModel: null, hosting: null, domain: '', serverName: '', storage: 'local',
  s3: { endpoint: '', bucket: '', region: 'auto' },
};

// Answers and position survive a reload. Setup is the longest uninterrupted stretch of
// typing in the whole product, and losing it to an accidental refresh — or to the restart
// the server itself may perform — would mean starting the questionnaire again.
const WIZ_KEY = 'omwmp_wizard';
function loadWizard() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(WIZ_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      return { answers: { ...BLANK_ANSWERS, ...saved.answers }, step: Number(saved.step) || 0 };
    }
  } catch { /* corrupt or absent: start clean rather than fail */ }
  return { answers: { ...BLANK_ANSWERS }, step: 0 };
}
function saveWizard() {
  try { sessionStorage.setItem(WIZ_KEY, JSON.stringify({ answers, step })); } catch { /* private mode */ }
}
function clearWizard() {
  try { sessionStorage.removeItem(WIZ_KEY); } catch { /* nothing to do */ }
}

const restored = loadWizard();
const answers = restored.answers;
let step = restored.step;

const wizardSteps = () => {
  const mp = answers.deploymentMode === 'multiplayer';
  return [
    'owner',
    'mode',
    ...(mp ? ['login', 'admins'] : []),
    'content',
    'delivery',
    ...(mp ? ['hosting'] : []),
    ...(mp ? ['name'] : []),
    'storage',
    'files',
    'review',
  ];
};

function wizardShell(inner, { back = true, next = 'Continue', onNext = null, disabled = false } = {}) {
  const steps = wizardSteps();
  const bar = steps.map((_, i) =>
    `<span class="${i < step ? 'done' : i === step ? 'now' : ''}"></span>`).join('');
  view().innerHTML = html`
    <div class="vt-wizard">
      <div class="vt-steps">${raw(bar)}</div>
      <div class="card"><div class="card-body p-4">${raw(inner)}</div></div>
      <div class="d-flex justify-content-between mt-3">
        <button class="btn btn-outline-secondary" id="wzBack" ${raw(back && step > 0 ? '' : 'hidden')}>Back</button>
        <button class="btn btn-primary ms-auto" id="wzNext" ${raw(disabled ? 'disabled' : '')}>${next}</button>
      </div>
    </div>`;
  $('#wzBack').onclick = () => { step = Math.max(0, step - 1); renderWizard(); };
  $('#wzNext').onclick = onNext || (() => { step++; renderWizard(); });
}

function choice(name, value, title, blurb) {
  const sel = answers[name] === value ? 'sel' : '';
  return html`<button class="vt-choice ${raw(sel)}" data-choice="${name}" data-value="${value}">
    <strong>${title}</strong><small>${blurb}</small></button>`;
}

function wireChoices(onPick) {
  view().querySelectorAll('[data-choice]').forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.choice;
      const value = el.dataset.value;
      // CHANGING THE DEPLOYMENT MODE DISCARDS THE ANSWERS THAT ONLY EXIST FOR THE OTHER ONE.
      //
      // The multiplayer path asks about sign-in methods, public hosting and a server name;
      // single-player skips all three. Without this, someone who picks multiplayer, answers
      // those, then changes their mind still had them applied at the end — a "just me"
      // server quietly configured with SSO providers it never offered to anyone. The
      // questions are hidden on the way back but the values were not.
      if (key === 'deploymentMode' && answers.deploymentMode !== value) {
        answers.loginMethods = ['password'];
        answers.hosting = null;
        answers.domain = '';
        answers.serverName = '';
      }
      answers[key] = value;
      if (onPick) onPick();
      saveWizard();
      renderWizard();
    };
  });
}

function renderWizard() {
  // Persist here rather than at each mutation site: every path that changes an answer or the
  // step ends up calling this, so one line covers all of them. The first version saved only
  // from the choice-tile handler, which meant every typed answer — server name, domain, S3
  // bucket — was lost on a reload while the clicked ones survived. A half-restored form is
  // worse than none.
  saveWizard();
  const steps = wizardSteps();
  const name = steps[Math.min(step, steps.length - 1)];
  setTitle('Set up this server', 'A few questions. Everything here can be changed later.');

  if (name === 'owner') return stepOwner();
  if (name === 'mode') return stepMode();
  if (name === 'login') return stepLogin();
  if (name === 'admins') return stepAdmins();
  if (name === 'content') return stepContent();
  if (name === 'delivery') return stepDelivery();
  if (name === 'hosting') return stepHosting();
  if (name === 'name') return stepName();
  if (name === 'storage') return stepStorage();
  if (name === 'files') return stepFiles();
  return stepReview();
}

/**
 * The one-time key from /admin#setup=… , kept so it survives the hash being cleared.
 *
 * A cached key can go stale — the server mints a new one if setup never completed and the
 * data folder was reset, which is exactly what happens while someone is trying things out.
 * When that happens the key must be forgettable, or the manual-entry field stays hidden
 * (there IS a key, just the wrong one) and the operator is stuck on "wrong setup key" with
 * nowhere to type the right one. See the 401 handler in stepOwner.
 */
const SETUP_KEY_STORE = 'omwmp_setup_key';
function readSetupKey() {
  const m = /^#setup=(.+)$/.exec(location.hash);
  if (m) {
    const key = decodeURIComponent(m[1]);
    try { sessionStorage.setItem(SETUP_KEY_STORE, key); } catch { /* private mode */ }
    // Out of the address bar: it is a credential, and the address bar is the most
    // screenshotted, most shoulder-surfed, most pasted-into-a-support-thread part of a
    // browser. The value is already saved above, so nothing is lost.
    history.replaceState(null, '', location.pathname + location.search);
    return key;
  }
  try { return sessionStorage.getItem(SETUP_KEY_STORE) || ''; } catch { return ''; }
}
function forgetSetupKey() {
  try { sessionStorage.removeItem(SETUP_KEY_STORE); } catch { /* nothing to do */ }
  setupKey = '';
}
let setupKey = readSetupKey();

function stepOwner() {
  if (state.authed) { step++; return renderWizard(); }
  wizardShell(html`
    <h5>Create your administrator account</h5>
    <p class="text-secondary small">This is the account you will sign in with. It has full
      control of the server, so give it a real password — you can add a second factor once
      you are in.</p>
    ${raw(setupKey ? '' : html`
      <div class="mb-3">
        <label class="form-label">Setup key</label>
        <input class="form-control vt-mono" id="oKey" autocomplete="off">
        <div class="form-text">Printed in the server's log when it started, and saved as
          <code>setup-token</code> in your data folder. It stops working once this account
          exists. If you started the server with <code>setup.sh</code> or
          <code>setup.ps1</code> this was filled in for you.</div>
      </div>`)}
    <div class="mb-3">
      <label class="form-label">Username</label>
      <input class="form-control" id="oName" autocomplete="username" placeholder="admin">
      <div class="form-text">2–24 characters: letters, numbers, spaces, underscore or hyphen.</div>
    </div>
    <div class="mb-3">
      <label class="form-label">Password</label>
      <input class="form-control" id="oPass" type="password" autocomplete="new-password">
      <div class="form-text">At least 12 characters. Length matters more than symbols.</div>
    </div>
    <div class="mb-2">
      <label class="form-label">Confirm password</label>
      <input class="form-control" id="oPass2" type="password" autocomplete="new-password">
    </div>
    <div id="oErr" class="text-danger small"></div>`,
  { back: false, next: 'Create account', onNext: async () => {
    const n = $('#oName').value.trim(), p = $('#oPass').value, p2 = $('#oPass2').value;
    if (p !== p2) { $('#oErr').textContent = 'The two passwords do not match.'; return; }
    const key = ($('#oKey')?.value.trim() || setupKey || '');
    if (!key) { $('#oErr').textContent = 'The setup key is required.'; return; }
    try {
      const r = await api('/setup/owner', { method: 'POST', body: { name: n, password: p, setupKey: key } });
      token.set(r.token);
      forgetSetupKey(); // spent
      await refreshState();
      step++;
      saveWizard();
      renderWizard();
    } catch (e) {
      // A rejected key is almost always a stale one. Drop it and re-render so the manual
      // field appears — otherwise the operator is told the key is wrong while being given
      // nowhere to put a right one.
      if (e.status === 401 && setupKey) {
        forgetSetupKey();
        renderWizard();
        $('#oName').value = n;
        $('#oErr').textContent = `${e.message} Paste the current one below.`;
        return;
      }
      $('#oErr').textContent = e.message;
    }
  } });
}

function stepMode() {
  wizardShell(html`
    <h5>What kind of server is this?</h5>
    <p class="text-secondary small">This decides which of the remaining questions you are asked.</p>
    ${raw(choice('deploymentMode', 'single', 'Just me',
      'A private world for one person. Registration stays closed and the multiplayer questions are skipped.'))}
    ${raw(choice('deploymentMode', 'multiplayer', 'Multiplayer',
      'Other people will join. You will be asked how they sign in, how they get the game files, and whether the server is reachable from the internet.'))}`,
  { disabled: !answers.deploymentMode });
  wireChoices();
}

function stepLogin() {
  const has = (m) => answers.loginMethods.includes(m);
  const box = (id, label, blurb) => html`
    <label class="vt-choice ${raw(has(id) ? 'sel' : '')}" style="cursor:pointer">
      <input type="checkbox" class="form-check-input me-2" data-login="${id}" ${raw(has(id) ? 'checked' : '')}>
      <strong style="display:inline">${label}</strong><small class="d-block ms-4">${blurb}</small></label>`;
  wizardShell(html`
    <h5>How will players sign in?</h5>
    <p class="text-secondary small">Pick as many as you like — they work side by side, and one
      person can use more than one on the same account.</p>
    ${raw(box('password', 'Username and password', 'Accounts held on this server. Nothing external required.'))}
    ${raw(box('discord', 'Discord', 'Needs a Discord application; you can paste the credentials in Settings afterwards.'))}
    ${raw(box('google', 'Google', 'Needs a Google OAuth client.'))}
    ${raw(box('microsoft', 'Microsoft', 'Needs a Microsoft app registration.'))}
    <div class="vt-section-note mt-3">Single sign-on needs credentials from each provider.
      Tick them here and fill in the details later under Settings → Access; players can use
      passwords in the meantime.</div>`,
  { disabled: answers.loginMethods.length === 0 });
  view().querySelectorAll('[data-login]').forEach((el) => {
    el.onchange = () => {
      const id = el.dataset.login;
      answers.loginMethods = el.checked
        ? [...new Set([...answers.loginMethods, id])]
        : answers.loginMethods.filter((m) => m !== id);
      renderWizard();
    };
  });
}

function stepAdmins() {
  wizardShell(html`
    <h5>Anyone else helping you run this?</h5>
    <p class="text-secondary small">You can skip this and add people later from the Accounts
      page. They need an account on the server first — this only grants dashboard access.</p>
    <div class="vt-section-note">
      <strong>Owner</strong> can change everything, including settings and other people's access.<br>
      <strong>Moderator</strong> can kick, ban, mute and read logs, but cannot change configuration.<br>
      <strong>Viewer</strong> can look, and nothing else.
    </div>
    <p class="small text-secondary mt-3 mb-0">Head to Accounts once setup is finished.</p>`,
  { next: 'Skip for now' });
}

function stepContent() {
  wizardShell(html`
    <h5>Which game content will this server run?</h5>
    <p class="text-secondary small">This decides which files the server checks for in the next steps.</p>
    ${raw(choice('contentProfile', 'morrowind', 'Morrowind',
      'The base game on its own.'))}
    ${raw(choice('contentProfile', 'expansions', 'Morrowind + Tribunal + Bloodmoon',
      'The Game of the Year edition. This is what most people have.'))}
    ${raw(choice('contentProfile', 'tamriel-rebuilt', 'Tamriel Rebuilt',
      'Game of the Year plus the Tamriel Rebuilt landmass. You will add its files in the mod list.'))}`,
  { disabled: !answers.contentProfile });
  wireChoices();
}

function stepDelivery() {
  wizardShell(html`
    <h5>How do players get the game files?</h5>
    <p class="text-secondary small">Morrowind itself is not free to redistribute, so this comes
      down to whether each player already owns a copy.</p>
    ${raw(choice('deliveryModel', 'verify', 'Players bring their own copy',
      'Everyone supplies their own Morrowind files. The server only checks that everybody is running the same thing, so the world stays consistent.'))}
    ${raw(choice('deliveryModel', 'serve', 'The server provides the files',
      'Players receive the data from this server. Only do this if you are entitled to distribute the copy you are hosting.'))}`,
  { disabled: !answers.deliveryModel });
  wireChoices();
}

function stepHosting() {
  wizardShell(html`
    <h5>Will people reach this from the internet?</h5>
    ${raw(choice('hosting', 'internal', 'Local network only',
      'Only machines on your own network can connect. No certificate and no domain needed.'))}
    ${raw(choice('hosting', 'public', 'Yes, from anywhere',
      'The server needs HTTPS. With a domain name pointed here you get a real certificate automatically; without one you get a self-signed certificate and your browser will warn you the first time.'))}
    ${raw(answers.hosting === 'public' ? html`
      <div class="vt-section-note mt-3">
        <strong>One thing this wizard cannot do for you.</strong> HTTPS is handled by the
        proxy in front of this server, which reads its settings from a file called
        <code>.env</code> next to your <code>docker-compose.yml</code> — outside the server,
        so nothing in here can write it.
        <p class="mt-2 mb-1">With a domain pointed at this machine, set:</p>
        <pre class="vt-mono small mb-1">SERVER_DOMAIN=mp.example.com
TLS_MODE=</pre>
        <p class="mb-0">and restart. You get a real certificate automatically. Without a
          domain, leave it alone: the connection is still encrypted, your browser will just
          warn you once because the certificate is self-signed.</p>
      </div>` : '')}`,
  { disabled: !answers.hosting });
  wireChoices();
}

function stepName() {
  wizardShell(html`
    <h5>What is this server called?</h5>
    <p class="text-secondary small">Shown to players when they browse or join.</p>
    <input class="form-control form-control-lg" id="wzName" value="${answers.serverName}"
      placeholder="My Morrowind server" maxlength="64">`,
  { onNext: () => { answers.serverName = $('#wzName').value.trim(); step++; renderWizard(); } });
  setTimeout(() => $('#wzName')?.focus(), 30);
}

function stepStorage() {
  wizardShell(html`
    <h5>Where should uploaded files live?</h5>
    <p class="text-secondary small">Game data and saved games players upload have to go somewhere.</p>
    ${raw(choice('storage', 'local', 'On this server',
      'Stored in the server\'s own data folder. Simplest, and fine until you run low on disk.'))}
    ${raw(choice('storage', 's3', 'S3-compatible storage',
      'Cloudflare R2, AWS S3, Backblaze B2 or MinIO. Keeps large uploads off this machine.'))}
    ${raw(answers.storage === 's3' ? html`
      <div class="row g-2 mt-3">
        <div class="col-12"><label class="form-label small">Endpoint</label>
          <input class="form-control" id="s3e" value="${answers.s3.endpoint}" placeholder="https://….r2.cloudflarestorage.com"></div>
        <div class="col-sm-8"><label class="form-label small">Bucket</label>
          <input class="form-control" id="s3b" value="${answers.s3.bucket}"></div>
        <div class="col-sm-4"><label class="form-label small">Region</label>
          <input class="form-control" id="s3r" value="${answers.s3.region}"></div>
      </div>
      <div class="vt-section-note mt-3">Access keys are read from the environment
        (<code>S3_ACCESS_KEY_ID</code> and <code>S3_SECRET_ACCESS_KEY</code>), never stored in
        configuration — so they cannot end up in a backup or a screenshot of this page.</div>` : '')}`);
  wireChoices();
  const e = $('#s3e'), b = $('#s3b'), r = $('#s3r');
  if (e) e.oninput = () => { answers.s3.endpoint = e.value.trim(); };
  if (b) b.oninput = () => { answers.s3.bucket = b.value.trim(); };
  if (r) r.oninput = () => { answers.s3.region = r.value.trim(); };
}

async function stepFiles() {
  let mods = null;
  try { mods = await api('/mods'); } catch { /* shown as unavailable below */ }
  const profile = mods?.profiles?.[answers.contentProfile];
  const present = new Set([
    ...(mods?.entries || []).map((e) => e.file.toLowerCase()),
    ...(mods?.archives || []).map((a) => a.toLowerCase()),
  ]);
  const rows = (profile?.requires || []).map((f) => {
    const ok = present.has(f.toLowerCase());
    return html`<tr><td class="vt-mono">${f}</td>
      <td class="text-end">${raw(ok
        ? '<span class="badge text-bg-success">found</span>'
        : '<span class="badge text-bg-secondary">missing</span>')}</td></tr>`;
  }).join('');
  const missingCount = (profile?.requires || []).filter((f) => !present.has(f.toLowerCase())).length;

  wizardShell(html`
    <h5>Game data files</h5>
    <p class="text-secondary small">The server needs its own copy of Morrowind to simulate the
      world. Add the files below, or copy them into
      <code>${mods?.dir || 'the game data folder'}</code> yourself.</p>
    ${raw(profile ? html`<table class="table table-sm align-middle">${raw(rows)}</table>` : '')}
    ${raw(profile?.note ? html`<div class="vt-section-note mb-3">${profile.note}</div>` : '')}
    ${raw(mods ? uploadPanel(mods) : '')}
    ${raw(missingCount > 0 ? html`
      <div class="alert alert-warning mb-0">
        ${missingCount} expected file${raw(missingCount === 1 ? ' is' : 's are')} still missing.
        You can finish setup without them — the dashboard keeps working and will tell you what
        it needs — but players cannot join until the server can simulate the world.
      </div>` : html`<div class="alert alert-success mb-0">Everything this profile expects is present.</div>`)}`,
  { next: 'Continue' });
  // Re-render this step after an upload so the found/missing table updates in place.
  wireUpload(() => renderWizard());
}

/** Review the choices back in the words they were offered in, not the stored values. */
const LOGIN_LABEL = {
  password: 'Username and password',
  discord: 'Discord',
  google: 'Google',
  microsoft: 'Microsoft',
};
const CONTENT_LABEL = {
  morrowind: 'Morrowind',
  expansions: 'Morrowind + Tribunal + Bloodmoon',
  'tamriel-rebuilt': 'Tamriel Rebuilt',
};

function stepReview() {
  const line = (k, v) => html`<dt class="col-sm-5 fw-normal text-secondary">${k}</dt>
    <dd class="col-sm-7">${v}</dd>`;
  const mp = answers.deploymentMode === 'multiplayer';
  wizardShell(html`
    <h5>Ready to apply</h5>
    <dl class="row small mt-3">
      ${raw(line('Deployment', mp ? 'Multiplayer' : 'Single player'))}
      ${raw(mp ? line('Server name', answers.serverName || '(unset)') : '')}
      ${raw(mp ? line('Sign-in methods',
        answers.loginMethods.map((m) => LOGIN_LABEL[m] || m).join(', ')) : '')}
      ${raw(line('Content', CONTENT_LABEL[answers.contentProfile] || '(unset)'))}
      ${raw(line('Game files', answers.deliveryModel === 'serve' ? 'Served by this server' : 'Players bring their own'))}
      ${raw(mp ? line('Reachable', answers.hosting === 'public'
        ? 'From the internet — set SERVER_DOMAIN in .env for a real certificate'
        : 'Local network only') : '')}
      ${raw(line('Uploads', answers.storage === 's3' ? `S3 — ${answers.s3.bucket || 'bucket unset'}` : 'On this server'))}
    </dl>
    <div class="vt-section-note">Saving writes these to
      <code>config.dashboard.toml</code>. Your own <code>config.toml</code> is never touched,
      and the server will restart to pick the changes up.</div>`,
  { next: 'Save and restart', onNext: async () => {
    try {
      await api('/setup', { method: 'POST', body: { ...answers, completed: true } });
      clearWizard();
      toast('Settings saved. Restarting the server…');
      await api('/restart', { method: 'POST' });
      waitForRestart();
    } catch (e) { toast(e.message, 'danger'); }
  } });
}

/** Poll until the server answers again, then go to the overview. */
function waitForRestart() {
  setTitle('Restarting…', 'This usually takes a few seconds.');
  view().innerHTML = html`<div class="vt-empty">
    <div class="spinner-border text-secondary mb-3"></div>
    <p>Waiting for the server to come back…</p></div>`;
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const r = await fetch('/admin/api/state');
      if (r.ok) {
        await refreshState();
        // ADMIN SESSIONS DO NOT SURVIVE A RESTART — they live in memory. So the last act of
        // the setup wizard signs you out, and without this the operator answered ten
        // questions, watched a spinner, and landed on a login form under a cheerful green
        // "Server is back up" with nothing saying why. Say it plainly instead.
        if (!state.authed) {
          token.clear();
          pageLogin(false, 'The server restarted, so you have been signed out. '
            + 'Everything you set up was saved — sign in to carry on.');
          return;
        }
        go('#overview');
        toast('Server is back up.');
        return;
      }
    } catch { /* still down, expected */ }
    if (tries > 60) {
      view().innerHTML = html`<div class="alert alert-danger">The server has not come back.
        Check the container logs — if it is not configured to restart automatically you may
        need to start it yourself.</div>`;
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1500);
}

// ---------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------
function pageLogin(totpRequired = false, notice = '') {
  setTitle('Sign in', 'Administration for this openmw-mp server.');
  view().innerHTML = html`
    <div class="vt-wizard" style="max-width:24rem">
      ${raw(notice ? html`<div class="alert alert-info">${notice}</div>` : '')}
      <div class="card"><div class="card-body p-4">
        <div class="mb-3"><label class="form-label">Username</label>
          <input class="form-control" id="liName" autocomplete="username"></div>
        <div class="mb-3"><label class="form-label">Password</label>
          <input class="form-control" id="liPass" type="password" autocomplete="current-password"></div>
        <div class="mb-3" ${raw(totpRequired ? '' : 'hidden')} id="liTotpWrap">
          <label class="form-label">Authenticator code</label>
          <input class="form-control" id="liTotp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
        </div>
        <button class="btn btn-primary w-100" id="liGo">Sign in</button>
        <div id="liErr" class="text-danger small mt-2"></div>
        <div class="mt-3 small"><a href="#" id="liForgot">Forgot your password?</a></div>
        <div id="liForgotBox" class="mt-2" hidden>
          <p class="small text-secondary mb-2">We will email a reset link to the address on
            the account, if it has one and this server can send mail.</p>
          <div class="input-group input-group-sm">
            <input class="form-control" id="liForgotName" placeholder="your username">
            <button class="btn btn-outline-secondary" id="liForgotGo">Send</button>
          </div>
          <div id="liForgotMsg" class="small mt-2"></div>
        </div>
      </div></div>
    </div>`;
  const submit = async () => {
    try {
      const r = await api('/login', { method: 'POST', body: {
        name: $('#liName').value.trim(),
        password: $('#liPass').value,
        totp: $('#liTotp')?.value || '',
      } });
      token.set(r.token);
      await refreshState();
      go('#overview');
    } catch (e) {
      if (e.body?.totpRequired) { $('#liTotpWrap').hidden = false; $('#liTotp').focus(); }
      $('#liErr').textContent = e.message;
    }
  };
  $('#liGo').onclick = submit;
  view().querySelectorAll('#liName, #liPass, #liTotp').forEach((i) => {
    i.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
  });
  $('#liForgot').onclick = (e) => {
    e.preventDefault();
    $('#liForgotBox').hidden = false;
    $('#liForgotName').value = $('#liName').value;
    $('#liForgotName').focus();
  };
  $('#liForgotGo').onclick = async () => {
    const msg = $('#liForgotMsg');
    try {
      const r = await api('/forgot-password', { method: 'POST', body: { name: $('#liForgotName').value.trim() } });
      // Deliberately the same answer either way: the server will not say whether that
      // account exists, and neither will this.
      msg.className = 'small mt-2 text-success';
      msg.textContent = r.message;
    } catch (e) {
      msg.className = 'small mt-2 text-danger';
      msg.textContent = e.status === 501
        ? 'This server has no email configured, so it cannot send a reset link. Ask whoever runs it to use --admin-reset.'
        : e.message;
    }
  };
  setTimeout(() => $('#liName').focus(), 30);
}

/** Reset link landing: /admin#reset=<token>. */
function pageReset(token) {
  setTitle('Choose a new password', '');
  view().innerHTML = html`
    <div class="vt-wizard" style="max-width:24rem">
      <div class="card"><div class="card-body p-4">
        <div class="mb-3"><label class="form-label">New password</label>
          <input class="form-control" id="rsPass" type="password" autocomplete="new-password">
          <div class="form-text">At least 12 characters.</div></div>
        <div class="mb-3"><label class="form-label">Confirm</label>
          <input class="form-control" id="rsPass2" type="password" autocomplete="new-password"></div>
        <button class="btn btn-primary w-100" id="rsGo">Set password</button>
        <div id="rsErr" class="text-danger small mt-2"></div>
      </div></div>
    </div>`;
  $('#rsGo').onclick = async () => {
    if ($('#rsPass').value !== $('#rsPass2').value) {
      $('#rsErr').textContent = 'The two passwords do not match.';
      return;
    }
    try {
      const r = await api('/reset-password', { method: 'POST', body: { token, password: $('#rsPass').value } });
      if (!r.ok) { $('#rsErr').textContent = r.message; return; }
      toast(r.message);
      location.hash = '';
      go('#login');
    } catch (e) { $('#rsErr').textContent = e.message; }
  };
}

// ---------------------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------------------
async function pageOverview() {
  setTitle('Overview', 'What this server is doing right now.');
  const o = await api('/overview');
  const stat = (label, value, sub = '') => html`
    <div class="col-6 col-lg-3">
      <div class="card mb-3"><div class="card-body">
        <div class="text-secondary small text-uppercase">${label}</div>
        <div class="fs-3">${value}</div>
        <div class="small text-secondary">${sub}</div>
      </div></div>
    </div>`;
  const up = Math.round(o.uptime / 60);
  const rows = o.players.length ? o.players.map((p) => html`
    <tr><td>${p.name}</td><td class="text-secondary">${p.account}</td>
      <td>${p.cellKey || "—"}</td><td>${p.rank}</td></tr>`).join('')
    : html`<tr><td colspan="4" class="vt-empty">Nobody is in the world right now.</td></tr>`;

  const checklist = setupChecklist();
  view().innerHTML = html`
    <div class="row">
      ${raw(stat('Players', `${o.players.length}`, `of ${o.maxPlayers} slots`))}
      ${raw(stat('World', o.world.id, o.world.mode))}
      ${raw(stat('Uptime', up < 60 ? `${up}m` : `${Math.round(up / 60)}h`, ''))}
      ${raw(stat('Your role', state.role, state.name))}
    </div>
    ${raw(checklist)}
    <div class="card"><div class="card-header"><h3 class="card-title">In world</h3></div>
      <div class="table-responsive"><table class="table table-hover mb-0">
        <thead><tr><th>Name</th><th>Account</th><th>Location</th><th>Rank</th></tr></thead>
        <tbody>${raw(rows)}</tbody></table></div></div>`;
  wireChecklist();
}

/** Post-onboarding nudges, derived from real state rather than a stored progress flag. */
function setupChecklist() {
  if (localStorage.getItem('omwmp_checklist_hidden') === '1') return '';
  const items = [
    { done: !!state.name, label: 'Create an administrator account' },
    // Owner-only: pointing a viewer at the wizard sent them through every question to a
    // "forbidden" at the end.
    ...(can('owner')
      ? [{ done: state.setupCompleted === true, label: 'Run the setup wizard', hash: '#setup' }]
      : []),
    { done: state.twoFactor === true, label: 'Add two-factor authentication to your account', hash: '#security' },
    { done: localStorage.getItem('omwmp_mods_seen') === '1', label: 'Review the game data and mod list', hash: '#mods' },
  ];
  if (items.every((i) => i.done)) return '';
  return html`<div class="card mb-3"><div class="card-body">
    <div class="d-flex align-items-start">
      <div class="flex-grow-1">
        <h5 class="card-title">Getting started</h5>
        <ul class="list-unstyled mb-0 small">
          ${raw(items.map((i) => html`<li class="py-1">
            ${raw(i.done ? '<span class="text-success">✓</span>' : '<span class="text-secondary">○</span>')}
            ${raw(i.hash && !i.done ? html`<a href="${i.hash}">${i.label}</a>` : html`<span>${i.label}</span>`)}
          </li>`).join(''))}
        </ul>
      </div>
      <button class="btn btn-sm btn-link text-secondary" id="hideChecklist">dismiss</button>
    </div></div></div>`;
}
function wireChecklist() {
  const b = $('#hideChecklist');
  if (b) b.onclick = () => { localStorage.setItem('omwmp_checklist_hidden', '1'); route(); };
}

// ---------------------------------------------------------------------------------------
// console: players, moderation actions, and the full command set
// ---------------------------------------------------------------------------------------
async function pageConsole() {
  setTitle('Players & commands', 'Moderation actions and the full admin command set.');
  const [o, cmds] = await Promise.all([api('/overview'), api('/commands')]);

  const rows = o.players.length ? o.players.map((p) => html`
    <tr><td>${p.name}</td><td class="text-secondary small">${p.account}</td>
      <td>${p.cellKey || "—"}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-secondary" data-act="kick" data-t="${p.account}">kick</button>
        <button class="btn btn-sm btn-outline-secondary" data-act="mute" data-t="${p.account}">mute</button>
        <button class="btn btn-sm btn-outline-danger" data-act="ban" data-t="${p.account}">ban</button>
      </td></tr>`).join('')
    : html`<tr><td colspan="4" class="vt-empty">Nobody is in the world right now.</td></tr>`;

  const cmdRows = cmds.commands.map((c) => html`
    <tr><td><code>${c.usage}</code>${raw(c.inGameOnly
        ? ' <span class="badge text-bg-secondary">in-game only</span>' : '')}</td>
      <td class="small text-secondary">${c.help}</td></tr>`).join('');

  view().innerHTML = html`
    <div class="card mb-3"><div class="card-header"><h3 class="card-title">In world</h3></div>
      <div class="table-responsive"><table class="table table-hover mb-0">
        <tbody>${raw(rows)}</tbody></table></div></div>

    <div class="card mb-3"><div class="card-body">
      <h5 class="card-title">Broadcast a message</h5>
      <div class="input-group">
        <input class="form-control" id="bcast" placeholder="Server restarting in five minutes">
        <button class="btn btn-primary" id="bcastGo">Send</button>
      </div></div></div>

    <div class="card mb-3"><div class="card-body">
      <h5 class="card-title">Command console</h5>
      <p class="text-secondary small">The same commands available in-game, run as you. Type
        <code>/help</code> to list what your role permits.</p>
      <div class="input-group mb-2">
        <span class="input-group-text">/</span>
        <input class="form-control vt-mono" id="cmdLine" placeholder="list" autocomplete="off">
        <button class="btn btn-primary" id="cmdGo">Run</button>
      </div>
      <div class="vt-out vt-mono" id="cmdOut">Ready.</div>
    </div></div>

    <div class="card mb-3"><div class="card-header d-flex align-items-center">
      <h3 class="card-title">Player reports</h3>
      <button class="btn btn-sm btn-outline-secondary ms-auto" id="repRefresh">Refresh</button>
    </div>
    <div class="table-responsive"><table class="table table-sm mb-0">
      <thead><tr><th>When</th><th>From</th><th>About</th><th>Reason</th></tr></thead>
      <tbody id="repBody"><tr><td colspan="4" class="vt-empty">Loading…</td></tr></tbody>
    </table></div></div>

    <div class="card"><div class="card-header"><h3 class="card-title">Available commands</h3></div>
      <div class="table-responsive"><table class="table table-sm mb-0">
        <tbody>${raw(cmdRows)}</tbody></table></div></div>`;

  // The report inbox had a route and settings and help text, and no way to read it — a
  // moderator could switch on chat logging and then never see a filed report.
  const loadReports = async () => {
    try {
      const { reports } = await api('/reports?limit=50');
      $('#repBody').innerHTML = reports.length ? reports.map((r) => html`
        <tr><td class="text-secondary small text-nowrap">${(r.ts || '').replace('T', ' ').slice(0, 16)}</td>
          <td>${r.reporter}</td><td>${r.target}</td>
          <td class="small">${r.reason}</td></tr>`).join('')
        : html`<tr><td colspan="4" class="vt-empty">No reports filed.</td></tr>`;
    } catch (e) {
      $('#repBody').innerHTML = html`<tr><td colspan="4" class="vt-empty">${e.message}</td></tr>`;
    }
  };
  $('#repRefresh').onclick = loadReports;
  void loadReports();

  view().querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const { act, t } = b.dataset;
      if (act === 'ban') {
        const ok = await confirmAction({
          title: `Ban ${t}?`,
          body: html`<p>They will be disconnected and unable to log in again until unbanned.</p>`,
          danger: 'Ban',
        });
        if (!ok) return;
      }
      try {
        const r = await api('/action', { method: 'POST', body: { kind: act, target: t, detail: '' } });
        toast(r.message, r.ok ? 'success' : 'danger');
        route();
      } catch (e) { toast(e.message, 'danger'); }
    };
  });
  $('#bcastGo').onclick = async () => {
    const text = $('#bcast').value.trim();
    if (!text) return;
    const r = await api('/action', { method: 'POST', body: { kind: 'broadcast', target: '', detail: text } });
    toast(r.message, r.ok ? 'success' : 'danger');
    $('#bcast').value = '';
  };
  const runCmd = async () => {
    const line = $('#cmdLine').value.trim();
    if (!line) return;
    const out = $('#cmdOut');
    // /console ships script to someone's machine. It is the one command where a fat-fingered
    // Enter has consequences on a stranger's computer, so it asks first.
    if (/^console\b/i.test(line)) {
      const ok = await confirmAction({
        title: 'Run script on a player\'s machine?',
        body: html`<p>This executes code inside another person's game client. Every use is
          recorded in the audit trail against your account.</p>
          <p class="vt-mono small">/${line}</p>`,
        danger: 'Run it',
      });
      if (!ok) return;
    }
    try {
      const r = await api('/command', { method: 'POST', body: { line } });
      out.textContent = r.message || '(no output)';
      $('#cmdLine').value = '';
    } catch (e) { out.textContent = e.message; }
  };
  $('#cmdGo').onclick = runCmd;
  $('#cmdLine').onkeydown = (e) => { if (e.key === 'Enter') runCmd(); };
}

// ---------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------
let settingsCache = null;
async function pageSettings() {
  setTitle('Settings', 'Every option this server has. Changes apply after a restart.');
  settingsCache = await api('/settings');
  const byName = new Map(settingsCache.sections.map((s) => [s.name, s]));
  const grouped = new Set(settingsCache.groups.flatMap((g) => g.sections));
  const others = settingsCache.sections.filter((s) => !grouped.has(s.name) && !s.name.includes('.'));

  const groups = [...settingsCache.groups, ...(others.length ? [{ group: 'Other', sections: others.map((s) => s.name) }] : [])];
  const readOnly = !can('owner');

  view().innerHTML = html`
    ${raw(readOnly ? html`<div class="alert alert-secondary">You can view these settings but
      not change them. Only an owner can save configuration.</div>` : '')}
    <div class="accordion" id="setAcc">
      ${raw(groups.map((g, gi) => {
        const sections = g.sections.map((n) => byName.get(n)).filter(Boolean);
        if (!sections.length) return '';
        // Nested provider tables (auth.discord) render inside their parent's panel.
        const nested = settingsCache.sections.filter((s) => s.name.includes('.')
          && g.sections.includes(s.name.split('.')[0]));
        return html`
        <div class="accordion-item">
          <h2 class="accordion-header"><button class="accordion-button collapsed" type="button"
            data-bs-toggle="collapse" data-bs-target="#g${gi}">${g.group}</button></h2>
          <div id="g${gi}" class="accordion-collapse collapse" data-bs-parent="#setAcc">
            <div class="accordion-body">
              ${raw(g.note ? html`<div class="vt-section-note mb-3">${g.note}</div>` : '')}
              ${raw([...sections, ...nested].map(renderSection).join(''))}
            </div>
          </div>
        </div>`;
      }).join(''))}
    </div>`;

  if (!readOnly) wireSettings();
}

function renderSection(s) {
  const fields = s.fields.map((f) => {
    const id = `f_${s.name.replace(/\./g, '_')}_${f.key}`;
    let input;
    if (f.type === 'boolean') {
      input = html`<div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" id="${id}" data-type="boolean" ${raw(f.value ? 'checked' : '')}>
      </div>`;
    } else if (f.type === 'number') {
      input = html`<input class="form-control" type="number" id="${id}" data-type="number" value="${f.value}">`;
    } else if (f.type === 'stringArray') {
      input = html`<input class="form-control vt-mono" id="${id}" data-type="stringArray"
        value="${(f.value || []).join(', ')}" placeholder="comma separated">`;
    } else if (f.type === 'unsupported') {
      input = html`<span class="text-secondary small">Not editable here — use config.toml.</span>`;
    } else {
      input = html`<input class="form-control ${raw(f.secret ? 'vt-mono' : '')}" id="${id}"
        data-type="string" type="${raw(f.secret ? 'password' : 'text')}" value="${f.value}">`;
    }
    return html`
      <div class="vt-field row align-items-start">
        <div class="col-md-5">
          <label class="vt-field-key ${raw(f.overridden ? 'vt-overridden' : '')}" for="${id}">${f.key}</label>
          ${raw(f.help ? html`<div class="vt-field-help">${f.help}</div>` : '')}
          ${raw(f.danger ? html`<div class="vt-field-danger"><strong>Careful:</strong> ${f.danger}</div>` : '')}
        </div>
        <div class="col-md-7">${raw(input)}</div>
      </div>`;
  }).join('');

  return html`
    <div class="card mb-3" data-section="${s.name}">
      <div class="card-header d-flex align-items-center">
        <h3 class="card-title">${s.label || s.name}
          <span class="vt-mono text-secondary small ms-2">[${s.name}]</span></h3>
        <button class="btn btn-sm btn-primary ms-auto" data-save="${s.name}">Save</button>
      </div>
      <div class="card-body">
        ${raw(s.help ? html`<p class="text-secondary small">${s.help}</p>` : '')}
        ${raw(fields)}
      </div>
    </div>`;
}

function wireSettings() {
  view().querySelectorAll('[data-save]').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.save;
      const card = view().querySelector(`[data-section="${CSS.escape(name)}"]`);
      const body = {};
      let dangerous = null;
      card.querySelectorAll('[data-type]').forEach((el) => {
        const key = el.id.slice(`f_${name.replace(/\./g, '_')}_`.length);
        if (el.dataset.type === 'boolean') body[key] = el.checked;
        else if (el.dataset.type === 'number') body[key] = Number(el.value);
        else if (el.dataset.type === 'stringArray') {
          body[key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
        } else body[key] = el.value;
      });
      const section = settingsCache.sections.find((s) => s.name === name);
      for (const f of section.fields) {
        if (!f.danger) continue;
        const changed = JSON.stringify(body[f.key]) !== JSON.stringify(f.value);
        const turnedOn = body[f.key] === true || (typeof body[f.key] === 'string' && body[f.key] !== '');
        if (changed && turnedOn) dangerous = f;
      }
      if (dangerous) {
        const ok = await confirmAction({
          title: `Change ${name}.${dangerous.key}?`,
          body: html`<p>${dangerous.danger}</p>`,
          danger: 'I understand, save it',
        });
        if (!ok) return;
      }
      try {
        await api(`/settings/${encodeURIComponent(name)}`, { method: 'PUT', body });
        toast(`Saved. Restart the server to apply.`);
        restartPrompt();
      } catch (e) { toast(e.message, 'danger'); }
    };
  });
}

/** Offer the restart right where the change was made — telling a non-technical operator to
 *  "restart the container" and leaving them to work out how is not a finished feature. */
function restartPrompt() {
  const b = $('#banner');
  b.innerHTML = html`<div class="alert alert-warning d-flex align-items-center">
    <div class="flex-grow-1">Changes are saved but not live yet. The server needs to restart.</div>
    <button class="btn btn-warning btn-sm" id="doRestart">Restart now</button></div>`;
  $('#doRestart').onclick = async () => {
    const ok = await confirmAction({
      title: 'Restart the server?',
      body: html`<p>Everyone currently playing will be disconnected. They can reconnect as
        soon as it is back, usually within a few seconds.</p>`,
      danger: 'Restart',
    });
    if (!ok) return;
    await api('/restart', { method: 'POST' });
    waitForRestart();
  };
}

// ---------------------------------------------------------------------------------------
// mods
// ---------------------------------------------------------------------------------------
async function pageMods() {
  setTitle('Game data & mods', 'What loads, and in what order.');
  localStorage.setItem('omwmp_mods_seen', '1');
  const m = await api('/mods');
  const editable = can('owner');

  // Move buttons as well as dragging. HTML5 drag-and-drop does not fire for touch at all, so
  // drag alone meant load order simply could not be changed on a phone or tablet — and the
  // grab cursor advertised an affordance that device does not have. The buttons are also the
  // keyboard path.
  const rows = m.entries.map((e, i) => html`
    <tr draggable="${raw(editable && !e.official ? 'true' : 'false')}" data-i="${i}" data-file="${e.file}">
      <td class="${raw(editable && !e.official ? 'vt-drag' : 'text-secondary')}">${raw(e.official ? '🔒' : '⠿')}</td>
      <td><input class="form-check-input" type="checkbox" data-en="${i}"
        ${raw(e.enabled ? 'checked' : '')} ${raw(editable && !e.official ? '' : 'disabled')}
        aria-label="Load ${e.file}"></td>
      <td class="vt-mono">${e.file}
        ${raw(e.official ? ' <span class="badge text-bg-secondary">base game</span>' : '')}
        ${raw(e.isNew ? ' <span class="badge text-bg-warning">new</span>' : '')}</td>
      <td class="text-end text-nowrap">${raw(editable && !e.official ? html`
        <button class="btn btn-sm btn-outline-secondary" data-move="up" aria-label="Move ${e.file} earlier">↑</button>
        <button class="btn btn-sm btn-outline-secondary" data-move="down" aria-label="Move ${e.file} later">↓</button>` : '')}</td>
    </tr>`).join('');

  view().innerHTML = html`
    ${raw(!m.exists ? html`<div class="alert alert-warning">
      No game data folder at <code>${m.dir}</code>. Multiplayer still works without it — the
      server just cannot simulate NPCs itself.</div>` : '')}
    ${raw(m.missing.length ? html`<div class="alert alert-warning">
      These were in your load order but are no longer on disk, so they have been dropped:
      <span class="vt-mono">${m.missing.join(', ')}</span></div>` : '')}
    ${raw(editable ? uploadPanel(m) : '')}
    <div class="card"><div class="card-header d-flex align-items-center">
      <h3 class="card-title">Load order</h3>
      ${raw(editable ? html`<button class="btn btn-sm btn-primary ms-auto" id="modSave">Save order</button>` : '')}
    </div>
    <div class="table-responsive"><table class="table table-hover mb-0">
      <thead><tr><th style="width:2rem"></th><th style="width:3rem">Load</th><th>File</th><th></th></tr></thead>
      <tbody id="modBody">${raw(rows || html`<tr><td colspan="4" class="vt-empty">No content files found.</td></tr>`)}</tbody>
    </table></div></div>
    ${raw(m.archives.length ? html`<div class="card mt-3"><div class="card-body">
      <h5 class="card-title">Archives</h5>
      <p class="small text-secondary mb-0 vt-mono">${m.archives.join(', ')}</p></div></div>` : '')}`;

  if (!editable) return;

  // Reload the page after an upload so the new files appear in the load order immediately —
  // "I added it and nothing happened" is the exact confusion this whole page exists to avoid.
  wireUpload(() => { toast('Files added. Restart to load them.'); route(); });

  // Drag to reorder. HTML5 drag-and-drop rather than a library: it is a table of a dozen
  // rows, and pulling in a sortable dependency for it would cost more than it saves.
  const body = $('#modBody');

  // Swap with the nearest reorderable neighbour, skipping the locked base-game rows so a
  // plugin cannot be moved above a master the engine requires first.
  body.querySelectorAll('[data-move]').forEach((btn) => {
    btn.onclick = () => {
      const tr = btn.closest('tr');
      const movable = [...body.querySelectorAll('tr[draggable=true]')];
      const at = movable.indexOf(tr);
      const to = btn.dataset.move === 'up' ? at - 1 : at + 1;
      if (to < 0 || to >= movable.length) return;
      if (btn.dataset.move === 'up') body.insertBefore(tr, movable[to]);
      else body.insertBefore(movable[to], tr);
      btn.focus(); // keep the keyboard where the user left it
    };
  });

  let dragged = null;
  body.querySelectorAll('tr[draggable=true]').forEach((tr) => {
    tr.ondragstart = () => { dragged = tr; tr.classList.add('vt-dragging'); };
    tr.ondragend = () => { dragged?.classList.remove('vt-dragging'); dragged = null; };
    tr.ondragover = (e) => {
      e.preventDefault();
      if (!dragged || dragged === tr) return;
      const rect = tr.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      body.insertBefore(dragged, after ? tr.nextSibling : tr);
    };
  });
  $('#modSave').onclick = async () => {
    const entries = [...body.querySelectorAll('tr[data-file]')].map((tr) => ({
      file: tr.dataset.file,
      enabled: tr.querySelector('[data-en]')?.checked ?? true,
    }));
    try {
      await api('/mods', { method: 'PUT', body: { entries } });
      toast('Load order saved. Restart to apply.');
      restartPrompt();
    } catch (e) { toast(e.message, 'danger'); }
  };
}

/**
 * Draw an otpauth:// URI as a scannable QR code.
 *
 * Uses the vendored qrcode-generator (MIT, ~56KB, no dependencies) rather than a hand-rolled
 * encoder. There WAS a hand-rolled one here: it produced perfectly plausible-looking squares
 * that no scanner could read, which is strictly worse than showing no QR at all, and it was
 * caught only by decoding the output in a test. QR is a solved problem with a lot of fiddly
 * detail (format-info placement, mask selection, block interleaving) and no upside to
 * re-deriving.
 *
 * SVG rather than canvas: it scales, prints, and needs no device-pixel-ratio handling. The
 * white background is explicit because a scanner needs the contrast even in dark mode.
 */
function drawQr(el, text) {
  try {
    const qr = window.qrcode(0, 'M'); // 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const px = 4;
    const quiet = 4; // required by the spec; without it many scanners will not lock on
    const size = (n + quiet * 2) * px;
    let rects = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          rects += `<rect x="${(c + quiet) * px}" y="${(r + quiet) * px}" width="${px}" height="${px}"/>`;
        }
      }
    }
    el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
      + `viewBox="0 0 ${size} ${size}" role="img" aria-label="Two-factor setup QR code">`
      + `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  } catch {
    // No QR is fine — the key is printed right below it and typing it in is a supported
    // flow in every authenticator app.
    el.innerHTML = '';
  }
}

/** Add-files panel, shared by the mods page and the wizard's game-data step. */
function uploadPanel(m) {
  return html`
    <div class="card mb-3"><div class="card-body">
      <h5 class="card-title">Add game data files</h5>
      ${raw(m.writable === false ? html`
        <div class="alert alert-warning mb-0">
          The game data folder is read-only, so files cannot be uploaded from here. Copy them
          into <code>${m.dir}</code> directly, or remove <code>:ro</code> from the
          <code>gamedata</code> volume in <code>docker-compose.yml</code> and restart.
        </div>` : html`
        <p class="small text-secondary">Drop your Morrowind files here, or
          <label class="text-decoration-underline" style="cursor:pointer">choose them<input
            type="file" id="upPick" multiple hidden accept=".esm,.esp,.bsa,.ba2,.omwaddon,.omwgame"></label>.
          Accepted: <code>.esm .esp .bsa .omwaddon .omwgame</code>. Large files are fine —
          they upload one at a time and nothing is held in memory.</p>
        <div id="upDrop" class="vt-drop">
          <div class="text-secondary">Drop files here</div>
        </div>
        <div id="upList" class="mt-2 small"></div>
        <p class="small text-secondary mt-2 mb-0">You can also copy files straight into
          <code>${m.dir}</code> — with the supplied Docker setup that is the
          <code>gamedata</code> folder next to your <code>docker-compose.yml</code>.</p>`)}
    </div></div>`;
}

/** Wire the upload panel. `onDone` runs after the last file finishes. */
function wireUpload(onDone) {
  const drop = $('#upDrop');
  const pick = $('#upPick');
  if (!drop) return; // read-only folder: no panel rendered
  const list = $('#upList');

  const send = async (files) => {
    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'py-1';
      row.innerHTML = html`<span class="vt-mono">${file.name}</span>
        <span class="text-secondary" data-state>uploading…</span>`;
      list.append(row);
      const state = row.querySelector('[data-state]');
      try {
        // Raw body, not multipart: the server streams it straight to disk, and a multipart
        // parser for a 400 MB archive would be a dependency plus a memory problem.
        const r = await fetch(`/admin/api/mods/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token.get()}`, 'content-type': 'application/octet-stream' },
          body: file,
          duplex: 'half',
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          state.textContent = body?.error || `failed (${r.status})`;
          state.className = 'text-danger';
        } else {
          state.textContent = `added, ${(body.bytes / 1048576).toFixed(1)} MB`;
          state.className = 'text-success';
        }
      } catch (e) {
        state.textContent = e.message;
        state.className = 'text-danger';
      }
    }
    if (onDone) onDone();
  };

  pick.onchange = () => send([...pick.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    send([...e.dataTransfer.files]);
  };
}

// ---------------------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------------------
async function pageAccounts() {
  setTitle('Accounts', 'Everyone registered on this server.');
  const q = '';
  const render = async (query) => {
    const { accounts } = await api(`/accounts?q=${encodeURIComponent(query)}`);
    const rows = accounts.map((a) => html`
      <tr>
        <td>${a.name}${raw(a.banned ? ' <span class="badge text-bg-danger">banned</span>' : '')}
          ${raw(a.twoFactor ? ' <span class="badge text-bg-success">2FA</span>' : '')}</td>
        <td class="text-secondary small">${a.username || '—'}</td>
        <td>${a.rank}</td>
        <td>
          ${raw(can('owner') ? html`
          <select class="form-select form-select-sm" data-role-for="${a.name}">
            <option value="" ${raw(!a.dashboardRole ? 'selected' : '')}>no access</option>
            <option value="viewer" ${raw(a.dashboardRole === 'viewer' ? 'selected' : '')}>viewer</option>
            <option value="moderator" ${raw(a.dashboardRole === 'moderator' ? 'selected' : '')}>moderator</option>
            <option value="owner" ${raw(a.dashboardRole === 'owner' ? 'selected' : '')}>owner</option>
          </select>` : html`<span class="text-secondary">${a.dashboardRole || '—'}</span>`)}
        </td>
        <td class="text-secondary small">${(a.lastSeenAt || '').slice(0, 10)}</td>
        <td class="text-end">${raw(can('owner')
          ? html`<button class="btn btn-sm btn-outline-danger" data-del="${a.name}">erase</button>` : '')}</td>
      </tr>`).join('');
    $('#accBody').innerHTML = rows || html`<tr><td colspan="6" class="vt-empty">No accounts match.</td></tr>`;

    view().querySelectorAll('[data-role-for]').forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api('/accounts/role', { method: 'POST', body: { name: sel.dataset.roleFor, role: sel.value } });
          toast(`Updated access for ${sel.dataset.roleFor}.`);
        } catch (e) { toast(e.message, 'danger'); render($('#accQ').value); }
      };
    });
    view().querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.del;
        const ok = await confirmAction({
          title: `Erase ${name}?`,
          body: html`<p>This permanently deletes the account and everything belonging to it —
            characters, saved games and stored files. It cannot be undone, and it is the same
            erasure a data-deletion request requires.</p>`,
          danger: 'Erase permanently',
          typeToConfirm: name,
        });
        if (!ok) return;
        try {
          const r = await api('/accounts/delete', { method: 'POST', body: { name, confirm: name } });
          toast(r.message || 'Account erased.');
          render($('#accQ').value);
        } catch (e) { toast(e.message, 'danger'); }
      };
    });
  };

  view().innerHTML = html`
    <div class="card"><div class="card-header">
      <input class="form-control" id="accQ" placeholder="Search accounts…" value="${q}">
    </div>
    <div class="table-responsive"><table class="table table-hover mb-0">
      <thead><tr><th>Account</th><th>Handle</th><th>Rank</th><th style="width:11rem">Dashboard access</th>
        <th>Last seen</th><th></th></tr></thead>
      <tbody id="accBody"><tr><td colspan="6" class="vt-empty">Loading…</td></tr></tbody>
    </table></div></div>`;
  let timer;
  $('#accQ').oninput = () => { clearTimeout(timer); timer = setTimeout(() => render($('#accQ').value), 200); };
  await render(q);
}

// ---------------------------------------------------------------------------------------
// sessions / security
// ---------------------------------------------------------------------------------------
async function pageSessions() {
  setTitle('Admin sessions', 'Browsers currently signed in to this dashboard.');
  const { sessions } = await api('/sessions');
  const rows = sessions.map((s) => html`
    <tr><td>${s.accountKey}</td><td class="vt-mono small">${s.ip}</td>
      <td class="small text-secondary">${new Date(s.issuedAt).toLocaleString()}</td>
      <td class="small text-secondary">${new Date(s.expiresAt).toLocaleString()}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-danger" data-rev="${s.id}">revoke</button></td>
    </tr>`).join('');
  view().innerHTML = html`
    <div class="card"><div class="table-responsive"><table class="table mb-0">
      <thead><tr><th>Account</th><th>From</th><th>Signed in</th><th>Expires</th><th></th></tr></thead>
      <tbody>${raw(rows || html`<tr><td colspan="5" class="vt-empty">No active sessions.</td></tr>`)}</tbody>
    </table></div></div>`;
  view().querySelectorAll('[data-rev]').forEach((b) => {
    b.onclick = async () => {
      await api('/sessions/revoke', { method: 'POST', body: { id: b.dataset.rev } });
      toast('Session revoked.');
      route();
    };
  });
}

async function pageSecurity() {
  setTitle('My security', 'Two-factor authentication for your own account.');
  const on = state.twoFactor === true;

  view().innerHTML = html`
    <div class="card" style="max-width:34rem"><div class="card-body">
      <h5 class="card-title">Authenticator app
        ${raw(on ? '<span class="badge text-bg-success ms-2">on</span>'
                 : '<span class="badge text-bg-secondary ms-2">off</span>')}</h5>
      <p class="small text-secondary">Adds a six-digit code to your password sign-in, so your
        password alone is not enough to get in. Single sign-on is unaffected — the provider
        already asks for a second factor of its own.</p>
      <div id="totpArea">${raw(on ? html`
        <p class="small">Two-factor is on for <strong>${state.name}</strong>.</p>
        <button class="btn btn-outline-danger" id="totpOff">Turn it off</button>`
        : html`<button class="btn btn-primary" id="totpStart">Set up two-factor</button>`)}</div>
    </div></div>`;

  const off = $('#totpOff');
  if (off) {
    off.onclick = async () => {
      const okd = await confirmAction({
        title: 'Turn off two-factor authentication?',
        body: html`<p>Your password alone will be enough to sign in to this dashboard.</p>
          <div class="mb-2"><label class="form-label small">Confirm your password</label>
            <input class="form-control" id="totpOffPass" type="password" autocomplete="current-password"></div>`,
        danger: 'Turn it off',
      });
      if (!okd) return;
      try {
        await api('/totp/disable', { method: 'POST', body: { password: $('#totpOffPass')?.value ?? '' } });
        toast('Two-factor authentication is off.');
        await refreshState();
        route();
      } catch (e) { toast(e.message, 'danger'); }
    };
    return;
  }

  $('#totpStart').onclick = async () => {
    const r = await api('/totp/enroll', { method: 'POST' });
    // A QR code, because "scan this" with nothing to scan is an instruction that cannot be
    // followed — it left people hand-typing a 32-character base32 string into a phone.
    // Drawn here rather than vendoring a library: a QR encoder is a few hundred lines and
    // this page needs exactly one, at one size, from one short string.
    $('#totpArea').innerHTML = html`
      <p class="small">Scan this with your authenticator app:</p>
      <div id="totpQr" class="mb-2"></div>
      <p class="small text-secondary mb-1">Or type this key in by hand:</p>
      <p class="vt-mono mb-3" style="letter-spacing:.08em">${r.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
      <div class="input-group mb-2" style="max-width:16rem">
        <input class="form-control" id="totpCode" inputmode="numeric" placeholder="123456"
          autocomplete="one-time-code">
        <button class="btn btn-primary" id="totpConfirm">Confirm</button>
      </div>
      <div class="small text-secondary">You have to enter a working code before this is
        switched on — that is what stops you locking yourself out with a key your phone
        never actually accepted.</div>`;
    drawQr($('#totpQr'), r.uri);
    $('#totpConfirm').onclick = async () => {
      try {
        await api('/totp/confirm', { method: 'POST', body: { code: $('#totpCode').value } });
        toast('Two-factor authentication is on.');
        await refreshState();
        route();
      } catch (e) { toast(e.message, 'danger'); }
    };
  };
}

// ---------------------------------------------------------------------------------------
// logs / audit / metrics
// ---------------------------------------------------------------------------------------
async function pageLogs(filter = '', title = 'Logs', lead = 'Recent activity from this server.') {
  setTitle(title, lead);
  const draw = async () => {
    const { entries } = await api(`/logs?limit=500&filter=${encodeURIComponent(filter)}`);
    const rows = entries.slice().reverse().map((e) => {
      const { ts, level, event, ...rest } = e;
      const extra = Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
      return html`<div class="lvl-${raw(esc(level))}"><span class="text-secondary">${ts.slice(11, 19)}</span>
        <span class="ev">${event}</span> ${extra}</div>`;
    }).join('');
    $('#logBox').innerHTML = rows || html`<div class="vt-empty">Nothing logged yet.</div>`;
  };
  view().innerHTML = html`
    <div class="card"><div class="card-header d-flex align-items-center">
      <h3 class="card-title">${title}</h3>
      <button class="btn btn-sm btn-outline-secondary ms-auto" id="logRefresh">Refresh</button>
    </div><div class="card-body"><div class="vt-log vt-mono" id="logBox">Loading…</div></div></div>`;
  $('#logRefresh').onclick = draw;
  await draw();
}

async function pageMetrics() {
  setTitle('Metrics', 'Counters this server keeps about itself.');
  const m = await api('/metrics');
  const groups = Object.entries(m.groups || {});
  view().innerHTML = groups.length ? html`
    <div class="row">${raw(groups.map(([name, rows]) => html`
      <div class="col-lg-6"><div class="card mb-3">
        <div class="card-header"><h3 class="card-title">${name}</h3></div>
        <div class="table-responsive"><table class="table table-sm mb-0">
          <tbody>${raw(rows.map((r) => html`<tr>
            <td class="vt-mono small">${r.name}</td>
            <td class="text-end">${r.value}</td></tr>`).join(''))}</tbody>
        </table></div></div></div>`).join(''))}</div>`
    : html`<div class="vt-empty">No metrics recorded yet.</div>`;
}

// ---------------------------------------------------------------------------------------
// maintenance & restart
// ---------------------------------------------------------------------------------------
async function pageMaintenance() {
  setTitle('Maintenance & restart', 'Take the server down gently, or bring it back.');
  const m = state.maintenance || { on: false, message: '' };
  view().innerHTML = html`
    <div class="card mb-3" style="max-width:40rem"><div class="card-body">
      <h5 class="card-title">Maintenance mode</h5>
      <p class="small text-secondary">Disconnects everyone and refuses new connections with a
        message. Use it before changing mods or settings so nobody is halfway through
        something when the server restarts.</p>
      <div class="mb-3"><label class="form-label">Message shown to players</label>
        <input class="form-control" id="mMsg" value="${m.message || ''}"
          placeholder="Back in ten minutes — updating mods"></div>
      <button class="btn ${raw(m.on ? 'btn-success' : 'btn-warning')}" id="mToggle">
        ${raw(m.on ? 'Turn maintenance mode off' : 'Turn maintenance mode on')}</button>
    </div></div>

    <div class="card mb-3" style="max-width:40rem"><div class="card-body">
      <h5 class="card-title">Restart</h5>
      <p class="small text-secondary">Applies saved settings and mod changes. Players are
        disconnected and can reconnect once it is back, usually within a few seconds.</p>
      <button class="btn btn-warning" id="mRestart">Restart the server</button>
    </div></div>

    <div class="card" style="max-width:40rem"><div class="card-body">
      <h5 class="card-title">Download a backup</h5>
      <p class="small text-secondary">Everything in the data folder: accounts, characters,
        world state, settings and logs.</p>
      <div class="vt-field-danger mb-3"><strong>Careful:</strong> the archive contains password
        hashes and any credentials you have configured. Treat it like a password — store it
        somewhere private, and do not post it when asking for help.</div>
      <a class="btn btn-outline-secondary" href="/admin/api/export" id="mExport">Download backup</a>
    </div></div>`;

  $('#mToggle').onclick = async () => {
    const on = !m.on;
    if (on) {
      const ok = await confirmAction({
        title: 'Turn on maintenance mode?',
        body: html`<p>Everyone currently playing will be disconnected immediately.</p>`,
        danger: 'Disconnect everyone',
      });
      if (!ok) return;
    }
    await api('/maintenance', { method: 'POST', body: { on, message: $('#mMsg').value } });
    await refreshState();
    route();
  };
  $('#mRestart').onclick = async () => {
    const ok = await confirmAction({
      title: 'Restart the server?',
      body: html`<p>Everyone playing will be disconnected.</p>`,
      danger: 'Restart',
    });
    if (!ok) return;
    await api('/restart', { method: 'POST' });
    waitForRestart();
  };
  // The export streams with an auth header, which a plain link cannot send.
  $('#mExport').onclick = async (e) => {
    e.preventDefault();
    toast('Preparing the archive…');
    const res = await fetch('/admin/api/export', { headers: { authorization: `Bearer ${token.get()}` } });
    if (!res.ok) { toast('Export failed.', 'danger'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openmw-mp-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

// ---------------------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------------------
async function pageHelp() {
  setTitle('Help', 'How this server works, and what to do when it does not.');

  // Read the server's own readiness rather than describing it in the abstract: if something
  // is wrong right now, saying so here beats a generic troubleshooting list.
  let blockers = [];
  try {
    const r = await fetch('/healthz');
    if (r.status === 503) {
      blockers = (await r.text()).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    }
  } catch { /* the page is still useful without it */ }

  const faq = (q, a) => html`<dt class="mt-3">${q}</dt><dd class="text-secondary">${raw(a)}</dd>`;

  view().innerHTML = html`
    ${raw(blockers.length ? html`
      <div class="alert alert-warning">
        <h5 class="alert-heading">This server cannot host players yet</h5>
        <ul class="mb-2">${raw(blockers.map((b) => html`<li>${b}</li>`).join(''))}</ul>
        <hr>
        <p class="mb-0 small">The dashboard works and your settings are safe. Fix the above,
          then <a href="#maintenance">restart</a>.</p>
      </div>` : '')}

    <div class="row">
      <div class="col-lg-7">
        <div class="card mb-3"><div class="card-body">
          <h5 class="card-title">Getting players in</h5>
          <dl class="small mb-0">
            ${raw(faq('Nobody can connect from outside my network',
              'Two things have to be true. Your router must forward ports 80 and 443 to this ' +
              'machine, and the server must have been set up for internet hosting rather than ' +
              'local-network-only &mdash; re-run <a href="#setup">Setup</a> if you chose the latter.'))}
            ${raw(faq('Where do players actually go?',
              'They open the game in a browser at this server\'s address. They do not install ' +
              'anything. If you are hosting the client files yourself they are served from the ' +
              'same address; otherwise point players at whichever copy of the client you use.'))}
            ${raw(faq('Do players need their own copy of Morrowind?',
              'That is what the "how do players get the game files" question in setup decides. ' +
              'If you chose that players bring their own, everyone needs a legal copy. Morrowind ' +
              'is not free to redistribute, so only serve the files yourself if you are entitled to.'))}
          </dl>
        </div></div>

        <div class="card mb-3"><div class="card-body">
          <h5 class="card-title">When something is wrong</h5>
          <dl class="small mb-0">
            ${raw(faq('My browser says the connection is not private',
              'Expected when you have no domain name: the certificate is one this server signed ' +
              'itself, so nothing independent vouches for it. The connection is still encrypted. ' +
              'Point a domain at this machine and set <code>SERVER_DOMAIN</code> in your ' +
              '<code>.env</code> to get a real certificate automatically.'))}
            ${raw(faq('I added mod files and nothing changed',
              'The server reads the game data folder only at startup. Check they appear on the ' +
              '<a href="#mods">Game data &amp; mods</a> page, then restart.'))}
            ${raw(faq('A setting I saved did not take effect',
              'Configuration is read once, when the server starts. Every save says so and offers ' +
              'a Restart button; you can also restart from <a href="#maintenance">Maintenance</a>.'))}
            ${raw(faq('The dashboard says my configuration was rolled back',
              'Something you saved could not be loaded, so the server started from the previous ' +
              'version instead of refusing to start at all. Nothing was lost. Review ' +
              '<a href="#settings">Settings</a> and save again.'))}
            ${raw(faq('I am locked out &mdash; forgotten password, no email set up',
              'On the machine running the server:<br>' +
              '<code>docker compose run --rm openmw-mp node dist/server.mjs --data /data --admin-reset &lt;name&gt;</code>' +
              '<br>That clears the password and two-factor on that account and prints a temporary ' +
              'password. Requires shell access to the box, which is the point.'))}
            ${raw(faq('Where are the logs?',
              'Recent activity is on the <a href="#logs">Logs</a> page. A longer history survives ' +
              'restarts and crashes in <code>logs/server.log</code> inside your data folder, and ' +
              '<code>docker compose logs openmw-mp</code> shows the container\'s own output.'))}
          </dl>
        </div></div>
      </div>

      <div class="col-lg-5">
        <div class="card mb-3"><div class="card-body">
          <h5 class="card-title">Who can do what</h5>
          <dl class="small mb-0">
            <dt>Owner</dt><dd class="text-secondary">Everything: settings, mods, accounts,
              restart, backups, and running script on a player's machine.</dd>
            <dt>Moderator</dt><dd class="text-secondary">Kick, ban, mute, broadcast, read chat
              history and logs. Cannot change configuration or grant access.</dd>
            <dt>Viewer</dt><dd class="text-secondary">Read-only.</dd>
          </dl>
        </div></div>

        <div class="card mb-3"><div class="card-body">
          <h5 class="card-title">Where your settings live</h5>
          <p class="small text-secondary mb-2">Changes made here are written to
            <code>config.dashboard.toml</code> in your data folder. If you also keep a
            <code>config.toml</code> by hand, this dashboard never touches it &mdash; yours is
            layered underneath, so your comments and values survive.</p>
          <p class="small text-secondary mb-0">The last few versions are kept alongside it. If a
            saved setting ever stops the server loading, it falls back to the newest one that
            works rather than refusing to start.</p>
        </div></div>

        <div class="card"><div class="card-body">
          <h5 class="card-title">More</h5>
          <p class="small mb-2">
            <a href="https://github.com/Virtastic/openmw-web/blob/main/SELF_HOSTING.md"
               target="_blank" rel="noreferrer noopener">Self-hosting guide</a> &middot;
            <a href="https://github.com/Virtastic/openmw-web/issues"
               target="_blank" rel="noreferrer noopener">Report a problem</a> &middot;
            <a href="https://discord.gg/PzFfDkbSue"
               target="_blank" rel="noreferrer noopener">Discord</a>
          </p>
          <p class="small text-secondary mb-0">Interface built with
            <a href="https://github.com/ColorlibHQ/AdminLTE" target="_blank" rel="noreferrer noopener">AdminLTE</a>
            and <a href="https://getbootstrap.com" target="_blank" rel="noreferrer noopener">Bootstrap</a>,
            both MIT licensed and served from this server rather than a CDN &mdash; so this page
            works with no internet connection.</p>
        </div></div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------
const ROUTES = {
  '#overview': pageOverview,
  '#console': pageConsole,
  '#settings': pageSettings,
  '#mods': pageMods,
  '#accounts': pageAccounts,
  '#sessions': pageSessions,
  '#security': pageSecurity,
  '#logs': () => pageLogs('', 'Logs', 'Recent activity from this server.'),
  '#audit': () => pageLogs('admin.', 'Audit trail', 'Every administrative action, and who took it.'),
  '#metrics': pageMetrics,
  '#maintenance': pageMaintenance,
  '#help': pageHelp,
};

const NEEDS = {
  '#setup': 'owner',
  '#console': 'moderator', '#settings': 'viewer', '#mods': 'viewer', '#accounts': 'moderator',
  '#sessions': 'owner', '#security': 'viewer', '#logs': 'moderator', '#audit': 'moderator',
  '#metrics': 'moderator', '#maintenance': 'owner', '#help': 'viewer', '#overview': 'viewer',
};

async function route() {
  paintChrome();
  const hash = location.hash || '#overview';

  // A reset link arrives as /admin#reset=<token> and has to work before anything else,
  // including first-run: the whole point is that the person cannot sign in.
  const reset = /^#reset=(.+)$/.exec(hash);
  if (reset) return pageReset(decodeURIComponent(reset[1]));

  if (state.firstRun) {
    // Keep a restored position rather than resetting: this runs on every load, so
    // overwriting `step` here is what made the saved progress unreachable. Only clamp to the
    // bounds the current auth state allows — step 0 is the create-account screen, which is
    // pointless once an account exists.
    if (!state.authed) step = 0;
    else if (step < 1) step = 1;
    return renderWizard();
  }
  if (!state.authed) return pageLogin();

  const need = NEEDS[hash];
  if (need && !can(need)) {
    setTitle('Not available', '');
    view().innerHTML = html`<div class="alert alert-secondary">Your role
      (<strong>${state.role}</strong>) cannot open this page. Ask an owner if you need it.</div>`;
    return;
  }
  // AFTER the role check, not before. Reachable by hash, so a viewer who typed or followed
  // a link to it used to answer every question and then get a bare "forbidden" toast at the
  // final save — and the file-upload panel on the way through failed on every drop.
  if (hash === '#setup') { if (step < 1) step = 1; return renderWizard(); }

  const page = ROUTES[hash] || pageOverview;
  try {
    await page();
  } catch (e) {
    if (e.message === 'signed out') return;
    setTitle('Something went wrong', '');
    view().innerHTML = html`<div class="alert alert-danger">${e.message}</div>`;
  }
}

window.addEventListener('hashchange', route);
$('#btnLogout').onclick = async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  token.clear();
  await refreshState();
  go('#login');
};

await refreshState();
await route();
