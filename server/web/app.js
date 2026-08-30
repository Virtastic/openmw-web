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
const answers = {
  deploymentMode: null, loginMethods: ['password'], contentProfile: null,
  deliveryModel: null, hosting: null, domain: '', serverName: '', storage: 'local',
  s3: { endpoint: '', bucket: '', region: 'auto' },
};
let step = 0;

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
      answers[el.dataset.choice] = el.dataset.value;
      if (onPick) onPick();
      renderWizard();
    };
  });
}

function renderWizard() {
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

function stepOwner() {
  if (state.authed) { step++; return renderWizard(); }
  wizardShell(html`
    <h5>Create your administrator account</h5>
    <p class="text-secondary small">This is the account you will sign in with. It has full
      control of the server, so give it a real password — you can add a second factor once
      you are in.</p>
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
    try {
      const r = await api('/setup/owner', { method: 'POST', body: { name: n, password: p } });
      token.set(r.token);
      await refreshState();
      step++;
      renderWizard();
    } catch (e) { $('#oErr').textContent = e.message; }
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
      <div class="mt-3">
        <label class="form-label">Domain name pointed at this server <span class="text-secondary">(optional)</span></label>
        <input class="form-control" id="wzDomain" value="${answers.domain}" placeholder="mp.example.com">
        <div class="form-text">Leave blank if you do not have one. You can add it later.</div>
      </div>` : '')}`,
  { disabled: !answers.hosting });
  wireChoices();
  const d = $('#wzDomain');
  if (d) d.oninput = () => { answers.domain = d.value.trim(); };
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
    <p class="text-secondary small">The server looks for content in
      <code>${mods?.dir || 'the game data folder'}</code>. Copy your Morrowind files there —
      with Docker that is the <code>gamedata</code> folder next to your
      <code>docker-compose.yml</code>.</p>
    ${raw(profile ? html`<table class="table table-sm align-middle">${raw(rows)}</table>` : '')}
    ${raw(profile?.note ? html`<div class="vt-section-note">${profile.note}</div>` : '')}
    ${raw(missingCount > 0 ? html`
      <div class="alert alert-warning mt-3 mb-0">
        ${missingCount} expected file${raw(missingCount === 1 ? ' is' : 's are')} not there yet.
        You can finish setup anyway — multiplayer works without game data on the server, you
        just will not get server-side NPC simulation until the files are in place.
      </div>` : html`<div class="alert alert-success mt-3 mb-0">Everything this profile expects is present.</div>`)}`,
  { next: 'Continue' });
}

function stepReview() {
  const line = (k, v) => html`<dt class="col-sm-5 fw-normal text-secondary">${k}</dt>
    <dd class="col-sm-7">${v}</dd>`;
  const mp = answers.deploymentMode === 'multiplayer';
  wizardShell(html`
    <h5>Ready to apply</h5>
    <dl class="row small mt-3">
      ${raw(line('Deployment', mp ? 'Multiplayer' : 'Single player'))}
      ${raw(mp ? line('Server name', answers.serverName || '(unset)') : '')}
      ${raw(mp ? line('Sign-in methods', answers.loginMethods.join(', ')) : '')}
      ${raw(line('Content', answers.contentProfile || '(unset)'))}
      ${raw(line('Game files', answers.deliveryModel === 'serve' ? 'Served by this server' : 'Players bring their own'))}
      ${raw(mp ? line('Reachable', answers.hosting === 'public'
        ? `From the internet${answers.domain ? ` (${answers.domain})` : ' (self-signed certificate)'}`
        : 'Local network only') : '')}
      ${raw(line('Uploads', answers.storage === 's3' ? `S3 — ${answers.s3.bucket || 'bucket unset'}` : 'On this server'))}
    </dl>
    <div class="vt-section-note">Saving writes these to
      <code>config.dashboard.toml</code>. Your own <code>config.toml</code> is never touched,
      and the server will restart to pick the changes up.</div>`,
  { next: 'Save and restart', onNext: async () => {
    try {
      await api('/setup', { method: 'POST', body: { ...answers, completed: true } });
      localStorage.setItem('omwmp_setup_done', '1');
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
      if (r.ok) { await refreshState(); go('#overview'); toast('Server is back up.'); return; }
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
function pageLogin(totpRequired = false) {
  setTitle('Sign in', 'Administration for this openmw-mp server.');
  view().innerHTML = html`
    <div class="vt-wizard" style="max-width:24rem">
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
  view().querySelectorAll('input').forEach((i) => {
    i.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
  });
  setTimeout(() => $('#liName').focus(), 30);
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
      <td>${p.cellKey || '—'}</td><td>${p.rank}</td></tr>`).join('')
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
        <thead><tr><th>Name</th><th>Account</th><th>Cell</th><th>Rank</th></tr></thead>
        <tbody>${raw(rows)}</tbody></table></div></div>`;
  wireChecklist();
}

/** Post-onboarding nudges, derived from real state rather than a stored progress flag. */
function setupChecklist() {
  if (localStorage.getItem('omwmp_checklist_hidden') === '1') return '';
  const items = [
    { done: !!state.name, label: 'Create an administrator account' },
    { done: localStorage.getItem('omwmp_setup_done') === '1', label: 'Run the setup wizard', hash: '#setup' },
    { done: localStorage.getItem('omwmp_2fa_done') === '1', label: 'Add two-factor authentication to your account', hash: '#security' },
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
      <td>${p.cellKey || '—'}</td>
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

    <div class="card"><div class="card-header"><h3 class="card-title">Available commands</h3></div>
      <div class="table-responsive"><table class="table table-sm mb-0">
        <tbody>${raw(cmdRows)}</tbody></table></div></div>`;

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
        <h3 class="card-title vt-mono">[${s.name}]</h3>
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
        toast(`Saved [${name}]. Restart the server to apply.`);
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

  const rows = m.entries.map((e, i) => html`
    <tr draggable="${raw(editable && !e.official ? 'true' : 'false')}" data-i="${i}" data-file="${e.file}">
      <td class="${raw(editable && !e.official ? 'vt-drag' : 'text-secondary')}">${raw(e.official ? '🔒' : '⠿')}</td>
      <td><input class="form-check-input" type="checkbox" data-en="${i}"
        ${raw(e.enabled ? 'checked' : '')} ${raw(editable && !e.official ? '' : 'disabled')}></td>
      <td class="vt-mono">${e.file}
        ${raw(e.official ? ' <span class="badge text-bg-secondary">base game</span>' : '')}
        ${raw(e.isNew ? ' <span class="badge text-bg-warning">new</span>' : '')}</td>
    </tr>`).join('');

  view().innerHTML = html`
    ${raw(!m.exists ? html`<div class="alert alert-warning">
      No game data folder at <code>${m.dir}</code>. Multiplayer still works without it — the
      server just cannot simulate NPCs itself.</div>` : '')}
    ${raw(m.missing.length ? html`<div class="alert alert-warning">
      These were in your load order but are no longer on disk, so they have been dropped:
      <span class="vt-mono">${m.missing.join(', ')}</span></div>` : '')}
    <div class="card mb-3"><div class="card-body">
      <h5 class="card-title">How to add files</h5>
      <p class="small text-secondary mb-0">Copy <code>.esm</code>, <code>.esp</code> and
      <code>.bsa</code> files into <code>${m.dir}</code>. With the supplied Docker setup that
      is the <code>gamedata</code> folder next to your <code>docker-compose.yml</code>; they
      appear here as soon as you reload this page. The three base-game masters always load
      first and cannot be reordered — Morrowind itself requires that.</p>
    </div></div>
    <div class="card"><div class="card-header d-flex align-items-center">
      <h3 class="card-title">Load order</h3>
      ${raw(editable ? html`<button class="btn btn-sm btn-primary ms-auto" id="modSave">Save order</button>` : '')}
    </div>
    <div class="table-responsive"><table class="table table-hover mb-0">
      <thead><tr><th style="width:2rem"></th><th style="width:3rem">On</th><th>File</th></tr></thead>
      <tbody id="modBody">${raw(rows || html`<tr><td colspan="3" class="vt-empty">No content files found.</td></tr>`)}</tbody>
    </table></div></div>
    ${raw(m.archives.length ? html`<div class="card mt-3"><div class="card-body">
      <h5 class="card-title">Archives</h5>
      <p class="small text-secondary mb-0 vt-mono">${m.archives.join(', ')}</p></div></div>` : '')}`;

  if (!editable) return;

  // Drag to reorder. HTML5 drag-and-drop rather than a library: it is a table of a dozen
  // rows, and pulling in a sortable dependency for it would cost more than it saves.
  const body = $('#modBody');
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
  view().innerHTML = html`
    <div class="card" style="max-width:34rem"><div class="card-body">
      <h5 class="card-title">Authenticator app</h5>
      <p class="small text-secondary">Adds a six-digit code to your password sign-in. Single
        sign-on logins are not affected — the provider already does this.</p>
      <div id="totpArea"><button class="btn btn-primary" id="totpStart">Set up two-factor</button></div>
    </div></div>`;
  $('#totpStart').onclick = async () => {
    const r = await api('/totp/enroll', { method: 'POST' });
    $('#totpArea').innerHTML = html`
      <p class="small">Scan this in your authenticator app, or type the key in by hand:</p>
      <p class="vt-mono">${r.secret}</p>
      <p class="small text-secondary">${r.uri}</p>
      <div class="input-group mb-2" style="max-width:16rem">
        <input class="form-control" id="totpCode" inputmode="numeric" placeholder="123456">
        <button class="btn btn-primary" id="totpConfirm">Confirm</button>
      </div>
      <div class="small text-secondary">You must enter a working code before this is switched
        on — that is what stops you locking yourself out with a key your phone never took.</div>`;
    $('#totpConfirm').onclick = async () => {
      try {
        await api('/totp/confirm', { method: 'POST', body: { code: $('#totpCode').value } });
        localStorage.setItem('omwmp_2fa_done', '1');
        toast('Two-factor authentication is on.');
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
function pageHelp() {
  setTitle('Help & docs', 'How this server works, and where to look when it does not.');
  view().innerHTML = html`
    <div class="row">
      <div class="col-lg-7">
        <div class="card mb-3"><div class="card-body">
          <h5 class="card-title">Common problems</h5>
          <dl class="small">
            <dt>Players cannot connect from outside my network</dt>
            <dd class="text-secondary">The server has to be reachable: forward the port on your
              router, and if you set this up as "local network only" re-run the setup wizard and
              choose internet hosting instead.</dd>
            <dt>My browser warns the connection is not private</dt>
            <dd class="text-secondary">Expected without a domain name — the certificate is
              self-signed. Point a domain at this machine and re-run the network step to get a
              real certificate automatically.</dd>
            <dt>I added mod files and nothing changed</dt>
            <dd class="text-secondary">Files are picked up from the game data folder, but the
              server only reads them at startup. Check the mod list, then restart.</dd>
            <dt>A setting I saved did not take effect</dt>
            <dd class="text-secondary">Configuration is read once when the server starts. Use
              Restart on the Maintenance page after saving.</dd>
            <dt>I am locked out of the dashboard</dt>
            <dd class="text-secondary">Run the server with <code>--admin-reset &lt;name&gt;</code>
              to clear an account's password and two-factor, then sign in and set a new one.</dd>
          </dl>
        </div></div>
      </div>
      <div class="col-lg-5">
        <div class="card mb-3"><div class="card-body">
          <h5 class="card-title">About</h5>
          <p class="small text-secondary mb-2">This dashboard controls one openmw-mp server.
            Settings you change here are written to <code>config.dashboard.toml</code>, layered
            on top of any <code>config.toml</code> you maintain by hand — that file is never
            modified by this interface.</p>
          <p class="small text-secondary mb-0">Built with
            <a href="https://github.com/ColorlibHQ/AdminLTE">AdminLTE</a> and
            <a href="https://getbootstrap.com">Bootstrap</a>, both MIT licensed and served
            from this server rather than a CDN.</p>
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
  '#console': 'moderator', '#settings': 'viewer', '#mods': 'viewer', '#accounts': 'moderator',
  '#sessions': 'owner', '#security': 'viewer', '#logs': 'moderator', '#audit': 'moderator',
  '#metrics': 'moderator', '#maintenance': 'owner', '#help': 'viewer', '#overview': 'viewer',
};

async function route() {
  paintChrome();
  const hash = location.hash || '#overview';

  if (state.firstRun) { step = state.authed ? 1 : 0; return renderWizard(); }
  if (!state.authed) return pageLogin();
  if (hash === '#setup') { step = 1; return renderWizard(); }

  const need = NEEDS[hash];
  if (need && !can(need)) {
    setTitle('Not available', '');
    view().innerHTML = html`<div class="alert alert-secondary">Your role
      (<strong>${state.role}</strong>) does not have access to this page.</div>`;
    return;
  }
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
