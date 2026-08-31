// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// The admin dashboard, as one vanilla ES module. No framework and no build step: this file
// is served exactly as it is written, which means what you read here is what runs, and a
// stack trace points at a real line. The server is the only source of truth, this page
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
    // The session died under us, expired, revoked, or the account was demoted. Send the
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
 * retypes an exact string, reserved for things with no undo at all, where a mis-aimed
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

// NOTHING IS HIDDEN BY DEPLOYMENT MODE. The roster and moderation page used to be hidden on
// a "single player" server, from when that answer was taken to mean nobody else could ever
// be there. It does not: it describes who the world is FOR, and friends can join either
// way. Hiding the page that shows who is currently playing, on a server they are playing
// on, is a worse fault than showing a page that happens to be empty.
const NAV = [
  { group: 'Server', items: [
    { hash: '#overview', label: 'Overview', icon: 'bi-speedometer2', role: 'viewer' },
    // NOT IN SINGLE PLAYER, and not because it looks odd there: every control on it acts on
    // a player connected to a world. In single player the browser runs the engine and never
    // connects, so the roster is permanently empty and there is nobody to broadcast to, greet
    // with a message of the day, read a chat log for, report, or hand an item. The page is
    // inert rather than merely unhelpful, so it is removed rather than trimmed.
    { hash: '#console', label: 'Players & commands', icon: 'bi-people', role: 'moderator', solo: false },
    { hash: '#mods', label: 'Game & mods', icon: 'bi-collection', role: 'viewer' },
  ] },
  // The setup wizard is first-run only and is deliberately NOT listed here. It is a sequence
  // of eleven questions whose answers reshape the deployment, and re-entering it on a running
  // server meant walking back through every one of them to change any one of them. Redeploy
  // to run it again.
  { group: 'Configuration', items: [
    { hash: '#settings', label: 'Settings', icon: 'bi-sliders', role: 'viewer' },
  ] },
  { group: 'People', items: [
    { hash: '#accounts', label: 'Accounts', icon: 'bi-person-lines-fill', role: 'moderator' },
    { hash: '#sessions', label: 'Admin sessions', icon: 'bi-key', role: 'owner' },
    { hash: '#security', label: 'My security', icon: 'bi-shield-lock', role: 'viewer' },
  ] },
  { group: 'Diagnostics', items: [
    { hash: '#logs', label: 'Logs', icon: 'bi-journal-text', role: 'moderator' },
    { hash: '#audit', label: 'Audit trail', icon: 'bi-clipboard-check', role: 'moderator' },
  ] },
  { group: 'Danger zone', items: [
    { hash: '#maintenance', label: 'Maintenance & restart', icon: 'bi-power', role: 'owner' },
  ] },
];

const RANK = { viewer: 0, moderator: 1, owner: 2 };
const can = (need) => state.authed && RANK[state.role] >= RANK[need];
/** True when this deployment was set up as a private, one-person world. */
const singlePlayer = () => state.setup?.deploymentMode === 'single';

function paintChrome() {
  // Signed out, or anywhere inside first-time setup, there IS no dashboard: no sidebar, no
  // top bar, just the one thing on a clean ground, the way AdminLTE's own login pages are
  // laid out. This is also the enforcement half of the setup gate, there is literally
  // nothing to click away to until the wizard is finished.
  const setupPending = state.firstRun || (state.authed && state.setupCompleted !== true);
  document.body.classList.toggle('vt-bare', !state.authed || setupPending);

  const nav = $('#mainNav');
  const current = location.hash || '#overview';
  // Nothing to click during setup, not even hidden behind CSS: an empty list cannot be
  // reached by a keyboard, a screen reader, or a stylesheet that fails to load.
  if (!state.authed || setupPending) { nav.innerHTML = ''; }
  else {
    nav.innerHTML = NAV.map((g) => {
      // `solo: false` marks a page that cannot do anything in a one-person deployment.
      const items = g.items.filter((i) => can(i.role) && !(i.solo === false && singlePlayer()));
      if (!items.length) return '';
      return html`<li class="nav-header">${g.group}</li>` + items.map((i) => html`
        <li class="nav-item">
          <a href="${i.hash}" class="nav-link ${raw(i.hash === current ? 'active' : '')}">
            <i class="nav-icon bi ${i.icon}"></i><p>${i.label}</p>
          </a>
        </li>`).join('');
    }).join('');
  }
  $('#topUserWrap').hidden = !state.authed;
  $('#topUser').textContent = state.authed ? state.name : '';
  $('#topRole').textContent = state.authed ? `Signed in as ${state.role}` : '';

  const m = $('#topMaintenance');
  m.innerHTML = state.maintenance?.on
    ? html`<span class="badge text-bg-warning">maintenance mode</span>` : '';

  $('#topWorld').textContent = state.serverName || '';

  const banner = $('#banner');
  banner.innerHTML = state.configFallback
    ? html`<div class="callout callout-warning">
        <h5><i class="bi bi-arrow-counterclockwise me-1"></i> Configuration was rolled back</h5>
        The settings last saved here failed to load, so the server started from an earlier
        version (<code>${state.configFallback}</code>) instead. Nothing was lost, review
        <a href="#settings">Settings</a> and save again.
      </div>` : '';
}

function setTitle(title, lead = '') {
  $('#pageTitle').textContent = title;
  $('#pageLead').textContent = lead;
  // The breadcrumb everyone expects an admin panel to have. Two levels is all the depth
  // this app has, so it is Home / page, not a synthetic hierarchy.
  const home = location.hash && location.hash !== '#overview';
  $('#crumbs').innerHTML = home
    ? html`<li class="breadcrumb-item"><a href="#overview">Home</a></li>
       <li class="breadcrumb-item active">${title}</li>`
    : html`<li class="breadcrumb-item active">Home</li>`;
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
  deliveryModel: null, hosting: null, domain: '', httpPort: 80, serverName: '', storage: 'local',
  // Who may create an account. ITS OWN QUESTION, asked whichever kind of server this is:
  // it used to be inferred from the deployment mode, so choosing "single player" silently
  // closed registration, which is a decision the operator never made and could not see.
  registration: null, inviteCode: '',
  // The exact domain string that passed the reachability check. Not a boolean: editing
  // the domain afterwards must invalidate the result rather than inherit it.
  domainVerified: '',
  s3: { endpoint: '', bucket: '', region: 'auto', accessKeyId: '', secretAccessKey: '' },
  ssoCreds: { discord: {}, google: {}, microsoft: {} },
};

/**
 * Re-entering Setup on a configured server starts from what was chosen last time, read back
 * from the server. Without this, "Setup/Reconfigure" presented every question blank and
 * saved the blanks over the real answers, a reconfigure tool that silently resets.
 */
function seedFromServer() {
  // Fills gaps only: an answer already given in this browser session, typed or clicked -
  // beats the stored one, so seeding never undoes an edit in progress.
  const s = state.setup || {};
  answers.deploymentMode ||= s.deploymentMode || null;
  answers.contentProfile ||= s.contentProfile || null;
  answers.hosting ||= s.hosting || null;
  answers.deliveryModel ||= s.deliveryModel || null;
  answers.httpPort ||= s.httpPort || 80;
  if (s.storage && answers.storage === 'local') answers.storage = s.storage;
  if (Array.isArray(s.loginMethods) && s.loginMethods.length
      && answers.loginMethods.length === 1 && answers.loginMethods[0] === 'password') {
    answers.loginMethods = [...s.loginMethods];
  }
  answers.serverName ||= state.serverName || '';
  // THE DOMAIN, which re-running Setup would otherwise blank. It is sent on every save, so
  // an unseeded empty value overwrote the stored one, the proxy config was regenerated
  // without it, and a working certificate quietly stopped being used.
  answers.registration ||= s.registration || null;
  answers.domain ||= s.domain || '';
  // Storage details, for the same reason. The KEYS are masked by the server and never come
  // back, so `storageConfigured` says whether it already holds a pair: without that the
  // storage step demands two secrets the operator cannot see and cannot retype, which is a
  // dead end on every re-entry.
  answers.s3.endpoint ||= s.s3Endpoint || '';
  answers.s3.bucket ||= s.s3Bucket || '';
  answers.s3.region ||= s.s3Region || 'auto';
}

// Answers and position survive a reload. Setup is the longest uninterrupted stretch of
// typing in the whole product, and losing it to an accidental refresh, or to the restart
// the server itself may perform, would mean starting the questionnaire again.
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

// SIGN-IN COMES AFTER THE DOMAIN, and that ordering is load-bearing rather than tidy.
//
// Ticking a single sign-on provider shows you the redirect URL to register with Discord or
// Google, and that URL contains this server's public address. Asked before the domain is
// known, the only address available is whatever the operator happens to be browsing on —
// http://localhost:8090 — so the wizard confidently handed out a redirect URL that the
// provider would later reject. Everything that needs the domain is asked after it.
//
// The sign-in and co-admin questions are asked in BOTH modes: "single player" describes who
// the world is for, not whether anyone else can ever reach it, and people who do join still
// need a way to sign in.
const wizardSteps = () => {
  // EVERY RUN ASKS THE SAME ELEVEN QUESTIONS. The server name used to be multiplayer-only,
  // which made the step count change from 11 to 12 the moment the mode was chosen, and a
  // total that moves under you is unsettling on the one screen where you most want to know
  // how much is left. A world you play alone still has a name, and it is shown on its own
  // sign-in page, so asking is not a wasted step.
  return [
    'owner',
    'mode',
    'content',
    'delivery',
    'hosting',
    'name',
    'login',
    'registration',
    'storage',
    'files',
    'review',
  ];
};

/** Short labels for the progress rail, so the steps are named rather than anonymous ticks. */
const STEP_LABEL = {
  owner: 'Account', mode: 'Type', login: 'Sign-in', registration: 'Sign-ups',
  content: 'Content', delivery: 'Files', hosting: 'Access',
  name: 'Name', storage: 'Storage', files: 'Data', review: 'Review',
};

/** The address players actually reach this server on, which is what a provider must be
 *  told. Falls back to the address the operator is browsing when no domain is set. */
const publicOrigin = () => (answers.domain ? `https://${answers.domain}` : location.origin);

/**
 * Turn what somebody actually typed into a bare hostname.
 *
 * People do not type "mp.example.com", they paste "https://mp.example.com/" out of the
 * address bar, because that is where a domain lives as far as they are concerned. The check
 * button refused that as "not a domain name" while Continue accepted it verbatim, so the
 * value that got saved was one the wizard had already called invalid: it reached the proxy
 * config as a site address and made the join link read https://https://mp.example.com/.
 *
 * Scheme, path, port, whitespace and case are all safe to strip. "www." deliberately is NOT:
 * www.example.com and example.com are different hosts, and quietly rewriting one to the other
 * would hand the operator a certificate for a name they did not ask for.
 */
function cleanDomain(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    .replace(/\/.*$/, '')                    // path, and the trailing slash with it
    .replace(/:\d+$/, '')                    // port
    .replace(/\.$/, '')                      // fully-qualified trailing dot
    .toLowerCase();
}

/**
 * `need` is the sentence shown when Continue is disabled. A greyed-out button with no
 * explanation is the worst thing this wizard could do to someone who has never run a
 * server: it says no and does not say why. Every step that can block passes one.
 */
function wizardShell(inner, { back = true, next = 'Continue', onNext = null, disabled = false, need = '' } = {}) {
  const steps = wizardSteps();
  const at = Math.min(step, steps.length - 1);
  const bar = steps.map((s, i) => html`
    <div class="vt-step ${raw(i < at ? 'done' : i === at ? 'now' : '')}">
      <span class="vt-step-bar"></span>
      <span class="vt-step-label">${STEP_LABEL[s] || s}</span>
    </div>`).join('');

  view().innerHTML = html`
    <div class="vt-wizard">
      <div class="vt-steps">${raw(bar)}</div>
      <div class="vt-stepcount">Step ${at + 1} of ${steps.length}</div>
      <div class="card vt-card"><div class="card-body">${raw(inner)}</div></div>
      <div class="vt-wizard-nav">
        <button class="btn btn-outline-secondary" id="wzBack" ${raw(back && step > 0 ? '' : 'hidden')}>← Back</button>
        ${raw(disabled && need ? html`<span class="vt-need text-secondary small">
          <i class="bi bi-arrow-right-short"></i>${need}</span>` : '')}
        <button class="btn btn-primary btn-lg ms-auto" id="wzNext" ${raw(disabled ? 'disabled' : '')}>${next}</button>
      </div>
    </div>`;
  $('#wzBack').onclick = () => { step = Math.max(0, step - 1); renderWizard(); };
  $('#wzNext').onclick = onNext || (() => { step++; renderWizard(); });
}

/**
 * One option tile. `tag` marks the answer that is right for most people.
 *
 * Someone who has never run a server does not need more prose, they need to know which one
 * to click. Every question that HAS a normal answer says so on the tile; the ones that are
 * genuinely a decision (how big is this, do you own the files) deliberately do not, because
 * a fake recommendation is worse than none.
 */
function choice(name, value, title, blurb, tag = '', tone = 'success') {
  const sel = answers[name] === value ? 'sel' : '';
  return html`<button class="vt-choice ${raw(sel)}" data-choice="${name}" data-value="${value}">
    <strong>${title}${raw(tag
      ? html` <span class="badge text-bg-${raw(tone)} ms-1">${tag}</span>` : '')}</strong>
    <small>${blurb}</small></button>`;
}

function wireChoices(onPick) {
  view().querySelectorAll('[data-choice]').forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.choice;
      const value = el.dataset.value;
      // CHANGING THE MODE CLEARS ONLY WHAT THE OTHER MODE DOES NOT ASK, which is now just
      // the server name. This used to also wipe the sign-in methods, the hosting choice and
      // the domain, from when those were multiplayer-only questions. They are asked in both
      // modes now, so clearing them means going back one step to flip the mode and silently
      // losing the domain you had already typed, and with it the certificate that domain
      // was about to get.
      // The mode's whole job now: preselect the sign-up policy that suits it. Not forced,
      // and the next-but-one step shows what was chosen and lets it be changed, which is
      // the difference between a helpful default and the silent one this used to apply.
      if (key === 'deploymentMode' && answers.deploymentMode !== value) {
        if (answers.registration === null) {
          answers.registration = value === 'single' ? 'invite' : 'open';
        }
      }
      answers[key] = value;
      if (onPick) onPick();
      saveWizard();
      renderWizard();
    };
  });
}

/**
 * Make the browser's own Back button walk the wizard.
 *
 * It did nothing at all before: the wizard never touched history, so Back was inert on the
 * one screen where people reach for it most, having just been asked eleven questions in a
 * row. Inert is not harmful, but "I pressed Back and nothing happened" is its own small
 * confusion, and the fix is a history entry per step.
 *
 * Only pushed when the step actually CHANGES. renderWizard also runs for re-renders within a
 * step (picking a tile, typing a domain), and pushing on those would bury the previous
 * question under a dozen identical entries that Back would have to chew through.
 */
let pushedStep = null;
function pushWizardStep() {
  if (pushedStep === step) return;
  const first = pushedStep === null;
  pushedStep = step;
  try {
    // replaceState for the first render, so Back from step one leaves the page the way it
    // normally would rather than landing on a phantom entry.
    history[first ? 'replaceState' : 'pushState']({ wizStep: step }, '', location.pathname);
  } catch { /* history is unavailable in some embedded contexts; Back simply stays inert */ }
}

window.addEventListener('popstate', (e) => {
  const to = e.state?.wizStep;
  if (typeof to !== 'number') return;
  pushedStep = to;   // do not re-push what the browser just navigated to
  step = to;
  saveWizard();
  renderWizard();
});

function renderWizard() {
  // Persist here rather than at each mutation site: every path that changes an answer or the
  // step ends up calling this, so one line covers all of them. The first version saved only
  // from the choice-tile handler, which meant every typed answer, server name, domain, S3
  // bucket, was lost on a reload while the clicked ones survived. A half-restored form is
  // worse than none.
  saveWizard();
  const steps = wizardSteps();
  const name = steps[Math.min(step, steps.length - 1)];
  setTitle('Set up this server',
    'Ten or so questions, most of them a single click. Every answer can be changed later.');
  pushWizardStep();

  if (name === 'owner') return stepOwner();
  if (name === 'mode') return stepMode();
  if (name === 'login') return stepLogin();
  if (name === 'registration') return stepRegistration();
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
 * A cached key can go stale, the server mints a new one if setup never completed and the
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
    <p class="text-secondary small">Full control of the server, so give it a real password.
      You can add a second factor once you are in.</p>
    ${raw(!state.needsSetupKey || setupKey ? '' : html`
      <div class="mb-3">
        <label class="form-label">Setup key</label>
        <input class="form-control vt-mono" id="oKey" autocomplete="off">
        <div class="form-text">Proof you have access to the machine, needed because you are
          not on its network. It is in the startup log, and in <code>setup-token</code> in the
          data folder.</div>
      </div>`)}
    <!-- A real form around the credentials. Chrome warns "Password field is not contained in
         a form" otherwise, and it is right to: outside one, password managers cannot reliably
         offer to save or fill, and Enter does nothing. Submission is handled in JS, so the
         form never navigates. -->
    <form id="oForm" autocomplete="on">
    <div class="mb-3">
      <label class="form-label">Email address</label>
      <input class="form-control" id="oName" type="email" autocomplete="username"
        placeholder="you@example.com" value="${answers.ownerEmail || ''}">
      <div class="form-text">Players never see it.</div>
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
    </form>
    <div id="oErr" class="text-danger small"></div>`,
  { back: false, next: 'Create account', onNext: async () => {
    const n = $('#oName').value.trim(), p = $('#oPass').value, p2 = $('#oPass2').value;
    // EVERY problem at once, not the first one. Someone filling in a form they have never
    // seen typically gets two things wrong together, and reporting one at a time turns that
    // into two rejections and two guesses about what else is waiting.
    const problems = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n)) {
      problems.push('The sign-in needs to be an email address, like you@example.com.');
    }
    if (p.length < 12) {
      problems.push(`The password needs at least 12 characters; that one has ${p.length}.`);
    } else if (p !== p2) {
      problems.push('The two passwords are not the same.');
    }
    if (problems.length) {
      $('#oErr').innerHTML = problems.map((t) => html`<div>${t}</div>`).join('');
      (problems[0].startsWith('The sign-in') ? $('#oName') : $('#oPass')).focus();
      return;
    }
    // Only required when the server says so, from this machine or this network it is not
    // asked for at all, because the whole point is that setup happens in the browser.
    const key = ($('#oKey')?.value.trim() || setupKey || '');
    if (state.needsSetupKey && !key) { $('#oErr').textContent = 'The setup key is required.'; return; }
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
      // field appears, otherwise the operator is told the key is wrong while being given
      // nowhere to put a right one.
      if (e.status === 401 && (setupKey || e.body?.needsKey)) {
        forgetSetupKey();
        answers.ownerEmail = n; // survives the re-render, so it is not retyped
        renderWizard();
        $('#oName').value = n;
        $('#oErr').textContent = `${e.message} Paste the current one below.`;
        return;
      }
      $('#oErr').textContent = e.message;
    }
  } });
  // Enter submits rather than reloading the page, and the form stays a form so password
  // managers behave.
  const oForm = $('#oForm');
  if (oForm) oForm.onsubmit = (e) => { e.preventDefault(); $('#wzNext').click(); };
}

function stepMode() {
  wizardShell(html`
    <h5>Single player or multiplayer?</h5>
    ${raw(choice('deploymentMode', 'single', 'Single Player',
      'Your own world, played on your own. Friends can still join if you invite them, and you '
      + 'decide who may sign up in a moment.'))}
    ${raw(choice('deploymentMode', 'multiplayer', 'Multiplayer',
      'Built for other people from the start. Morrowind is a single-player game, so playing it '
      + 'together is a real addition rather than a port: expect rough edges, and do not run a '
      + 'campaign you would be upset to lose. You get one extra question, the name players see '
      + 'when they join.', 'Experimental', 'warning'))}`,
  { disabled: !answers.deploymentMode, need: 'Choose one to carry on.' });
  wireChoices();
}

/**
 * Ticked single sign-on providers that still have no keys.
 *
 * A provider without a client id and secret is enabled in configuration and NEVER OFFERED on
 * the sign-in page, because there is nothing to sign in with. That silence is the problem:
 * the operator ticks Discord, finishes setup, and then cannot find the Discord button they
 * chose. Every place that shows the choice says which ones are unfinished.
 */
function ssoNeedingKeys() {
  return ['discord', 'google', 'microsoft'].filter((p) => {
    if (!answers.loginMethods.includes(p)) return false;
    const c = answers.ssoCreds?.[p] || {};
    const stored = (state.setup?.ssoConfigured || []).includes(p);
    return !stored && (!(c.clientId || '').trim() || !(c.clientSecret || '').trim());
  });
}

function stepLogin() {
  const has = (m) => answers.loginMethods.includes(m);
  const sso = ['discord', 'google', 'microsoft'].filter(has)
    .map((m) => LOGIN_LABEL[m] || m);
  const box = (id, label, blurb) => html`
    <label class="vt-choice vt-check ${raw(has(id) ? 'sel' : '')}">
      <input type="checkbox" class="form-check-input" data-login="${id}" ${raw(has(id) ? 'checked' : '')}>
      <span><strong>${label}</strong><small>${blurb}</small></span></label>`;

  // What the combination actually means, said back to them. "Tick some boxes" is not an
  // answer to "am I using SSO, passwords, or both", the point of the question.
  // One line saying what the ticks add up to. The point of the question is "am I using
  // single sign-on, passwords, or both", and a list of ticked boxes is not that answer.
  let summary;
  if (has('password') && sso.length) summary = `Password or ${sso.join(', ')}.`;
  else if (has('password')) summary = 'Passwords only.';
  else if (sso.length) summary = `${sso.join(', ')} only. Password sign-in is off.`;
  else summary = 'Nothing selected, so nobody can sign in.';

  wizardShell(html`
    <h5>How will players sign in?</h5>
    <p class="text-secondary small">Tick as many as you like.</p>
    ${raw(box('password', 'Username and password', 'Held on this server. Nothing to set up.'))}
    <div class="text-secondary small text-uppercase mt-3 mb-2">Single sign-on</div>
    ${raw(box('discord', 'Discord', ''))}
    ${raw(box('google', 'Google', ''))}
    ${raw(box('microsoft', 'Microsoft', ''))}
    <div class="vt-section-note mt-3">${raw(summary)}</div>
    ${raw(ssoNeedingKeys().length ? html`<div class="vt-field-danger mt-2">
      <strong>${ssoNeedingKeys().map((p) => LOGIN_LABEL[p]).join(' and ')}
      ${raw(ssoNeedingKeys().length === 1 ? 'has' : 'have')} no keys yet, so
      ${raw(ssoNeedingKeys().length === 1 ? 'it' : 'they')} will not appear on the sign-in
      page at all.</strong> Fill them in below, or leave this and add them later under
      Settings, single sign-on. Nothing breaks either way, but nobody can use
      ${raw(ssoNeedingKeys().length === 1 ? 'it' : 'them')} until you do.</div>` : '')}
    ${raw(['discord', 'google', 'microsoft'].filter(has).map((p) => {
      const c = answers.ssoCreds?.[p] || {};
      const helpUrl = {
        discord: 'https://discord.com/developers/applications',
        google: 'https://console.cloud.google.com/apis/credentials',
        microsoft: 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      }[p];
      // Ticking a provider opens its keys right here, the step that asks the question is
      // the step that takes the answer, not a pointer at a settings page for later.
      return html`
      <div class="vt-card card mt-2"><div class="card-body py-3">
        <div class="d-flex align-items-center mb-2">
          <strong>${LOGIN_LABEL[p]} keys</strong>
          ${raw(ssoNeedingKeys().includes(p)
            ? '<span class="badge text-bg-warning ms-2">not filled in yet</span>'
            : '<span class="badge text-bg-success ms-2">ready</span>')}
          <a class="ms-auto small" href="${helpUrl}" target="_blank" rel="noreferrer noopener">
            open ${LOGIN_LABEL[p]}'s developer console ↗</a>
        </div>
        <p class="small text-secondary mb-2">Create an application there, set its redirect URL
          to exactly this, then paste its two values below. You can also skip this and fill it
          in later under Settings → Single sign-on; until then, ${LOGIN_LABEL[p]} simply is
          not offered on the sign-in page.</p>
        <div class="input-group input-group-sm mb-2">
          <input class="form-control vt-mono" readonly value="${publicOrigin()}/auth/${p}/callback"
            aria-label="Redirect URL for ${LOGIN_LABEL[p]}">
          <button class="btn btn-outline-secondary" data-copy="${publicOrigin()}/auth/${p}/callback"
            type="button">Copy</button>
        </div>
        ${raw(answers.domain ? '' : html`<div class="vt-field-danger small mb-2">
          <strong>No domain set.</strong> That URL is the address you are browsing right now,
          which is fine for trying this on your own machine and wrong for anyone else. If you
          add a domain later, change this in ${LOGIN_LABEL[p]}'s console to match, or sign-in
          will be refused.</div>`)}
        <div class="row g-2">
          <div class="col-sm-6"><label class="form-label small">Client ID</label>
            <input class="form-control form-control-sm vt-mono" data-cred="${p}:clientId" value="${c.clientId || ''}"></div>
          <div class="col-sm-6"><label class="form-label small">Client secret</label>
            <input class="form-control form-control-sm vt-mono" type="password" data-cred="${p}:clientSecret" value="${c.clientSecret || ''}"></div>
        </div>
      </div></div>`;
    }).join(''))}`,
  { disabled: answers.loginMethods.length === 0, need: 'Pick at least one, or nobody can sign in.' });

  view().querySelectorAll('[data-login]').forEach((el) => {
    el.onchange = () => {
      const id = el.dataset.login;
      answers.loginMethods = el.checked
        ? [...new Set([...answers.loginMethods, id])]
        : answers.loginMethods.filter((m) => m !== id);
      saveWizard();
      renderWizard();
    };
  });
  view().querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Redirect URL copied.');
      } catch { toast('Could not copy, select the box and copy it yourself.', 'danger'); }
    };
  });
  view().querySelectorAll('[data-cred]').forEach((el) => {
    el.oninput = () => {
      const [p, k] = el.dataset.cred.split(':');
      answers.ssoCreds ||= {};
      // Only the credentials are stored here. The redirect URI is derived from the domain at
      // save time instead, so going back to change the domain cannot leave a stale URL
      // behind that no longer matches what the provider was told.
      answers.ssoCreds[p] = { ...(answers.ssoCreds[p] || {}), [k]: el.value.trim() };
      saveWizard();
    };
  });
}

function stepRegistration() {
  wizardShell(html`
    <h5>Who can create an account?</h5>
    ${raw(choice('registration', 'open', 'Anyone',
      'Anyone who reaches the server can sign up.'))}
    ${raw(choice('registration', 'invite', 'Only with an invite code',
      'They sign up themselves, but only with the code you give them.', 'Good default'))}
    ${raw(choice('registration', 'closed', 'Nobody, I will create the accounts',
      'Sign-ups refused. You add people from the Accounts page.'))}
    ${raw(answers.registration === 'invite' ? html`
      <div class="mt-3">
        <label class="form-label">Invite code</label>
        <input class="form-control" id="wzInvite" value="${answers.inviteCode}"
          placeholder="something only your friends know" maxlength="64">
      </div>` : '')}`,
  { disabled: !answers.registration
      || (answers.registration === 'invite' && answers.inviteCode.trim() === ''),
    need: 'Choose who may sign up.' });
  wireChoices();
  const inv = $('#wzInvite');
  if (inv) {
    inv.oninput = () => {
      answers.inviteCode = inv.value;
      $('#wzNext').disabled = inv.value.trim() === '';
    };
    setTimeout(() => inv.focus(), 30);
  }
}

function stepContent() {
  wizardShell(html`
    <h5>Which version of Morrowind is this?</h5>
    ${raw(choice('contentProfile', 'morrowind', 'Morrowind',
      'The base game with neither expansion. An older disc copy, usually.'))}
    ${raw(choice('contentProfile', 'expansions', 'Morrowind + Tribunal + Bloodmoon',
      'The Game of the Year edition, and what almost every copy sold in the last twenty '
      + 'years is. If you bought it on Steam or GOG, this is you.', 'Most likely'))}
    ${raw(choice('contentProfile', 'tamriel-rebuilt', 'Tamriel Rebuilt',
      'The Game of the Year edition plus the Tamriel Rebuilt fan expansion. Pick this only '
      + 'if you already have its files; you add them on the Game data page afterwards.'))}`,
  { disabled: !answers.contentProfile, need: 'Choose which content this server runs.' });
  wireChoices();
}

function stepDelivery() {
  wizardShell(html`
    <h5>How does everyone get the game files?</h5>
    <p class="text-secondary small">Morrowind is not free software. Everyone playing needs the
      game's <strong>Data Files</strong> folder, and this is about where their copy comes
      from. It does not change how the game plays.</p>
    ${raw(choice('deliveryModel', 'verify', 'Everyone brings their own copy',
      'Each person points the game at their own Morrowind on their own machine. Nothing is '
      + 'sent from here, and this server just checks that everybody is running matching files '
      + 'so you all see the same world.', 'Usual choice'))}
    ${raw(choice('deliveryModel', 'serve', 'This server hands out the files',
      'You upload your Data Files here once and everyone receives them on joining. Easier for '
      + 'the people joining, and it means you are distributing the game, so only pick this if '
      + 'everyone involved owns a copy already (a group of friends who each bought it, for '
      + 'instance).'))}
    ${raw(answers.deploymentMode === 'multiplayer' ? html`
      <div class="vt-section-note mt-3">
        Separately from this answer, <strong>a multiplayer server needs its own copy</strong>,
        because it runs the world: it simulates every NPC and creature rather than any
        player's browser doing it. The Game data step near the end is where you add it.
      </div>` : '')}
`,
  { disabled: !answers.deliveryModel, need: 'Choose how players get the files.' });
  wireChoices();
}

function stepHosting() {
  wizardShell(html`
    <h5>How will people reach this server?</h5>
    <p class="text-secondary small">This decides whether the bundled proxy handles HTTPS for
      you, or stays out of the way. You can change it later.</p>
    ${raw(choice('hosting', 'internal', 'Internal or behind your own proxy',
      'Plain HTTP on a port you choose. Right for a home network or a LAN party, for a port '
      + 'you forward yourself, and for putting your own reverse proxy, tunnel or load balancer '
      + 'in front. Nothing here handles certificates in this mode, because whatever sits in '
      + 'front of it should.', 'Simplest'))}
    ${raw(choice('hosting', 'public', 'Public',
      'Reachable from the internet, so people can join from anywhere. This needs a domain name '
      + 'pointed at this machine and ports 80 and 443 forwarded to it on your router. Both are '
      + 'checked below before you can continue, because a public server that is not actually '
      + 'reachable looks identical to a working one until somebody tries to join.'))}
    ${raw(answers.hosting === 'internal' ? html`
      <div class="mt-3 mb-2">
        <label class="form-label" for="wzPort">Port</label>
        <input class="form-control" id="wzPort" type="number" min="1" max="65535"
          value="${answers.httpPort || 80}" style="max-width:10rem">
        <div class="form-text">The port this server answers on. Leave it at 80 unless something
          else on this machine already uses it, or you want to forward a different one. If you
          change it, publish the same port for the <code>caddy</code> service in your
          <code>docker-compose.yml</code>.</div>
      </div>
      <div class="vt-field-danger">
        <strong>Read this if players are not on this machine.</strong> Browsers only let the game
        use the shared memory it needs on a <em>secure</em> address. That means
        <code>http://localhost</code> is fine, and <code>https://</code> anything is fine, but
        <code>http://</code> to an IP or a machine name is not: the game will refuse to start
        with "browser not supported".
        <p class="mb-0 mt-2">So this mode is right when you play on this machine, or when a
        reverse proxy, tunnel or load balancer in front of it provides HTTPS. If people will
        connect straight to this box over your network, choose <strong>Public</strong> and give
        it a domain instead.</p>
      </div>` : '')}
    ${raw(answers.hosting === 'public' ? html`
      <div class="mt-3 mb-2">
        <label class="form-label">Domain name <span class="text-secondary">(optional)</span></label>
        <div class="input-group">
          <input class="form-control" id="wzDomain" value="${answers.domain}"
            placeholder="mp.example.com" autocomplete="off">
          <button class="btn btn-outline-secondary" id="wzDomainCheck" type="button">Check it</button>
        </div>
        <div class="form-text">A domain you own, pointed at this machine. Leave it empty to
          use the raw address, everything still works, browsers just show a one-time
          certificate warning because nothing independent vouches for it.</div>
        <div id="wzDomainResult" class="mt-2"></div>
      </div>
      <div class="vt-section-note">
        <strong>HTTPS is handled for you.</strong> ${raw(answers.domain
          ? html`When you finish setup, the certificate for
            <strong>${answers.domain}</strong> is requested automatically and usually arrives
            within a few seconds. There is no file to edit and nothing to restart.`
          : html`Without a domain the connection is still encrypted, using a certificate this
            server signs itself, so browsers warn once and you click through. Add a domain
            above at any time (now or later from Settings) and a real certificate replaces
            it on its own.`)}
      </div>` : '')}`,
  // PUBLIC IS NOT A CLAIM THE OPERATOR GETS TO MAKE UNCHECKED. A public server whose domain
  // does not actually reach it looks exactly like a working one from in here, and the
  // failure surfaces later as friends who cannot join and a certificate that never issues.
  // The check proves both halves (the name points here, and a request from outside arrives),
  // so it is the gate rather than a convenience button.
  { disabled: !answers.hosting
      || (answers.hosting === 'public'
          && (!answers.domain || answers.domainVerified !== answers.domain)),
    need: answers.hosting === 'public'
      ? (answers.domain ? 'Press Check it, and it has to come back reachable.'
                        : 'A public server needs a domain name. Add one and check it.')
      : 'Choose one to carry on.',
    onNext: () => {
      const typed = $('#wzDomain')?.value;
      if (typed !== undefined) answers.domain = cleanDomain(typed);
      // Clamped rather than validated with a message: any number outside the range is a typo,
      // and silently keeping 80 is friendlier than blocking the step over it.
      const port = Number($('#wzPort')?.value);
      if (Number.isFinite(port) && port >= 1 && port <= 65535) answers.httpPort = Math.trunc(port);
      step++; renderWizard();
    } });
  wireChoices();
  const d = $('#wzDomain');
  // Normalise as they leave the field, so what they see from here on is what gets saved
  // and what the certificate will be issued for.
  if (d) d.onchange = () => { answers.domain = cleanDomain(d.value); saveWizard(); renderWizard(); };
  if (d) d.oninput = () => { if (cleanDomain(d.value) !== answers.domainVerified) $('#wzNext').disabled = true; };

  // The check the operator cannot do themselves: is the DNS record right, and does HTTPS
  // answer? Run by the server, reported back in plain language with the next step named.
  const chk = $('#wzDomainCheck');
  if (chk) chk.onclick = async () => {
    const domain = cleanDomain($('#wzDomain').value);
    $('#wzDomain').value = domain; // show them what is actually being checked
    const out = $('#wzDomainResult');
    if (!domain) { out.innerHTML = html`<div class="alert alert-secondary py-2 small mb-0">Type a domain first.</div>`; return; }
    answers.domain = domain;
    saveWizard();
    out.innerHTML = html`<div class="text-secondary small">
      <span class="spinner-border spinner-border-sm me-1"></span> Checking ${domain}…</div>`;
    try {
      const r = await api('/setup/check-domain', { method: 'POST', body: { domain } });
      const line = (ok, msg) => html`<div class="d-flex gap-2 py-1 small">
        <i class="bi ${raw(ok === true ? 'bi-check-circle-fill text-success'
          : ok === 'warn' ? 'bi-exclamation-triangle-fill text-warning'
          : 'bi-x-circle-fill text-danger')}"></i><div>${msg}</div></div>`;
      // The reachability row is the one that decides. DNS and HTTPS are shown because they
      // say WHICH half is wrong, but neither on its own proves the name reaches this server.
      answers.domainVerified = r.reachable.ok ? domain : '';
      saveWizard();
      out.innerHTML = html`<div class="vt-section-note">
        ${raw(line(r.dns.ok, r.dns.message))}
        ${raw(line(r.reachable.ok, r.reachable.message))}
        ${raw(r.https.status === 'skipped' ? '' : line(
          r.https.status === 'ok' ? true : r.https.status === 'self-signed' ? 'warn' : false,
          r.https.message))}
      </div>`;
      $('#wzNext').disabled = !r.reachable.ok;
    } catch (e) {
      out.innerHTML = html`<div class="alert alert-danger py-2 small mb-0">${e.message}</div>`;
    }
  };
}

function stepName() {
  wizardShell(html`
    <h5>What is this server called?</h5>
    <p class="text-secondary small">${answers.deploymentMode === 'single'
      ? 'Shown on your sign-in page and at the top of this dashboard.'
      : 'Shown to players when they browse or join.'}</p>
    <input class="form-control form-control-lg" id="wzName" value="${answers.serverName}"
      placeholder="My Morrowind server" maxlength="64">`,
  { disabled: answers.serverName.trim() === '',
    need: 'Give it a name.',
    onNext: () => { answers.serverName = $('#wzName').value.trim(); step++; renderWizard(); } });
  const nameInput = $('#wzName');
  // Live, so the Continue button unlocks as they type rather than after they click away.
  nameInput.oninput = () => {
    answers.serverName = nameInput.value;
    $('#wzNext').disabled = nameInput.value.trim() === '';
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter' && !$('#wzNext').disabled) $('#wzNext').click(); };
  setTimeout(() => nameInput?.focus(), 30);
}

function stepStorage() {
  wizardShell(html`
    <h5>Where should players' files be kept?</h5>
    <p class="text-secondary small">Savegames, and each player's own copy of Morrowind when
      they bring one. This is only about where those sit.</p>
    <div class="vt-section-note mb-3">Morrowind itself and any mods you install stay on this
      server either way. The game engine reads them as real files from disk, so they cannot
      live anywhere else.</div>
    ${raw(choice('storage', 'local', 'On this server',
      'Kept in this server\'s own data folder, alongside everything else. Nothing to sign up '
      + 'for and nothing else to pay for. Right for almost everyone, and you can move to S3 '
      + 'later without losing anything.', 'Recommended'))}
    ${raw(choice('storage', 's3', 'S3 storage',
      'An S3-compatible account you already have: Amazon S3, Cloudflare R2, Backblaze B2, '
      + 'MinIO or similar. Worth it if this machine has a small disk, or you expect a lot of '
      + 'people. Needs four values from that provider, below.'))}
    ${raw(answers.storage === 's3' ? html`
      <div class="vt-section-note mt-3 mb-3">
        <strong>Where these come from.</strong> Sign in to your storage provider and create a
        bucket (a named container for files), then create an access key for it. The provider
        shows you all four values on those two screens. The secret is usually displayed once
        and never again, so copy it before closing the page.
      </div>
      <div class="row g-2">
        <div class="col-12"><label class="form-label small">Endpoint</label>
          <input class="form-control" id="s3e" value="${answers.s3.endpoint}" placeholder="https://….r2.cloudflarestorage.com">
          <div class="form-text">The web address of your storage provider, which they give
            you next to the bucket. Starts with https://</div></div>
        <div class="col-sm-8"><label class="form-label small">Bucket</label>
          <input class="form-control" id="s3b" value="${answers.s3.bucket}" placeholder="my-morrowind-server">
          <div class="form-text">The name you gave the container when you created it.</div></div>
        <div class="col-sm-4"><label class="form-label small">Region</label>
          <input class="form-control" id="s3r" value="${answers.s3.region}">
          <div class="form-text">Leave as <code>auto</code> unless told otherwise.</div></div>
        <div class="col-sm-6"><label class="form-label small">Access key ID</label>
          <input class="form-control vt-mono" id="s3k" value="${answers.s3.accessKeyId || ''}"
            autocomplete="off" spellcheck="false">
          <div class="form-text">Like a username for the storage account.</div></div>
        <div class="col-sm-6"><label class="form-label small">Secret access key</label>
          <input class="form-control vt-mono" id="s3s" type="password"
            value="${answers.s3.secretAccessKey || ''}" autocomplete="new-password">
          <div class="form-text">Its password. Treat it like one.</div></div>
      </div>
      <div class="vt-section-note mt-3">Your storage provider gives you these when you create
        the bucket. They are stored with the rest of your settings and masked whenever this
        page reads them back, so they are never shown again once saved. A backup you download
        does contain them, along with every account's password hash, which is why the backup
        page tells you to treat that file like a password.</div>` : '')}`,
  // Choosing S3 and leaving it blank produces a server that accepts uploads and then
  // cannot store them, which surfaces much later as a player's failed upload.
  // Half-configured S3 produces a server that accepts uploads and cannot store them, which
  // shows up much later as a player's failed upload rather than as a setup error. The keys
  // are part of that: an endpoint with no credentials is a broken deployment, not a partial
  // one, so the wizard will not move on until all four are present.
  { disabled: answers.storage === 's3' && !s3Complete(),
    need: 'Fill in the endpoint, bucket and both keys, or choose "On this server".' });
  wireChoices();
  const e = $('#s3e'), b = $('#s3b'), r = $('#s3r'), k = $('#s3k'), sec = $('#s3s');
  const recheck = () => { $('#wzNext').disabled = answers.storage === 's3' && !s3Complete(); };
  if (e) e.oninput = () => { answers.s3.endpoint = e.value.trim(); recheck(); };
  if (b) b.oninput = () => { answers.s3.bucket = b.value.trim(); recheck(); };
  if (r) r.oninput = () => { answers.s3.region = r.value.trim(); };
  if (k) k.oninput = () => { answers.s3.accessKeyId = k.value.trim(); recheck(); };
  if (sec) sec.oninput = () => { answers.s3.secretAccessKey = sec.value.trim(); recheck(); };
}

/** Every field S3 needs before it can actually store anything. */
function s3Complete() {
  const s = answers.s3;
  if (s.endpoint.trim() === '' || s.bucket.trim() === '') return false;
  // Keys already stored count as present. They are masked and never sent back, so requiring
  // them to be retyped would mean nobody could re-run Setup on a working S3 server without
  // going and finding credentials they configured months ago.
  if (state.setup?.storageConfigured) return true;
  return (s.accessKeyId || '').trim() !== '' && (s.secretAccessKey || '').trim() !== '';
}

/**
 * Where Morrowind usually is, so "find your Data Files folder" is an instruction someone can
 * actually follow rather than a scavenger hunt.
 *
 * An ordinary string, NOT inline in the markup: `html` is a tagged template, and a Windows
 * path written directly in one has its backslashes swallowed as escape sequences, so the
 * page would have shown "C:Program Files (x86)Steam..." to the one audience least able to
 * spot that it was wrong.
 */
const INSTALL_PATHS = [
  'Steam    C:\\Program Files (x86)\\Steam\\steamapps\\common\\Morrowind\\Data Files',
  'GOG      C:\\GOG Games\\Morrowind\\Data Files',
  'Mac      ~/Library/Application Support/OpenMW/Data Files',
].join('\n');

async function stepFiles() {
  // A FAILURE HERE USED TO BE INVISIBLE. The error was swallowed, so `mods` stayed null: no
  // upload panel rendered, no checklist, and, because "missing" is derived from a profile
  // that never loaded, a green "everything this profile expects is present". A screen that
  // says the files are fine when it could not look is worse than one that says nothing.
  let mods = null;
  let modsError = '';
  try {
    mods = await api(`/mods?profile=${encodeURIComponent(answers.contentProfile || '')}`);
  } catch (e) {
    if (e.message === 'signed out') return; // api() is already sending them to sign in
    modsError = e.message;
  }
  const profile = mods?.profiles?.[answers.contentProfile];
  const present = new Set([
    ...(mods?.entries || []).map((e) => e.file.toLowerCase()),
    ...(mods?.archives || []).map((a) => a.toLowerCase()),
  ]);

  // A tick and a cross, not two words in coloured pills. The question this screen answers is
  // "is my upload complete", and a column of green ticks answers it at a glance in a way a
  // column of the word "found" does not.
  const badge = (ok) => (ok
    ? '<i class="bi bi-check-circle-fill text-success fs-5" title="present"></i>'
    : '<i class="bi bi-x-circle text-danger fs-5" title="missing"></i>');

  const fileRows = (profile?.requires || []).map((f) => html`
    <tr><td class="vt-mono">${f}</td>
      <td class="text-end">${raw(badge(present.has(f.toLowerCase())))}</td></tr>`).join('');

  // THE HALF THAT WAS MISSING. Checking only the plugins and archives passes a folder that
  // produces a game with no voice, no music and no intro, and calls it complete, the loose
  // asset directories are not inside any .bsa.
  const media = mods?.media ?? {};
  const mediaDirs = profile?.media || [];
  const mediaRows = mediaDirs.map((d) => {
    const n = media[d] ?? 0;
    return html`<tr><td class="vt-mono">${d}/</td>
      <td class="text-end text-nowrap">${raw(n > 0
        ? `<span class="text-secondary small me-2">${n >= 50 ? '50+' : n} file${n === 1 ? '' : 's'}</span>${badge(true)}`
        : badge(false))}</td></tr>`;
  }).join('');

  const missingFiles = (profile?.requires || []).filter((f) => !present.has(f.toLowerCase()));
  const missingMedia = mediaDirs.filter((d) => (media[d] ?? 0) === 0);
  const missingCount = missingFiles.length + missingMedia.length;
  // Carried to the review, which otherwise reads as "all set" on a server that cannot
  // actually start a world.
  gameDataIncomplete = missingCount > 0;

  wizardShell(html`
    <h5>Add your Morrowind files</h5>
    ${raw(answers.deploymentMode === 'single' ? html`
      <p class="text-secondary small"><strong>Optional.</strong> Your browser runs the game, so
        the server does not need a copy. Add one to keep your library here instead.</p>`
      : html`
      <p class="text-secondary small">The server runs the world, so it needs its own copy.</p>`)}
    <div class="vt-section-note mb-3">
      <strong>Find the folder called <code>Data Files</code></strong> inside wherever
      Morrowind is installed, and drag it onto the box below. It is usually at:
      <pre class="vt-mono small mb-1 mt-2">${INSTALL_PATHS}</pre>
      <p class="mb-0 mt-2">Your browser will ask "Upload N files?" with a count in the
        thousands. That is normal, click Upload. If it refuses the folder, copy it to your
        Desktop first and drag that.</p>
    </div>

    ${raw(profile ? html`
      <div class="text-secondary small text-uppercase mb-1">The game itself</div>
      <table class="table table-sm align-middle mb-3">${raw(fileRows)}</table>
      <div class="text-secondary small text-uppercase mb-1">Sound, music and video
        <span class="text-lowercase">- these sit loose in the folder, so they are easy to miss</span></div>
      <table class="table table-sm align-middle mb-3">${raw(mediaRows)}</table>` : '')}
    ${raw(mods ? uploadPanel(mods, true) : html`
      <div class="alert alert-danger mb-0">
        <strong>Could not read the game data folder.</strong> ${modsError || 'The server did not answer.'}
        Reload this page; if you were signed out, sign in again and Setup resumes here.
      </div>`)}
    ${raw(!mods || !profile || missingCount > 0 ? '' : html`
      <div class="alert alert-success mb-0 d-flex align-items-center gap-2">
        <i class="bi bi-check-circle-fill fs-4"></i>
        <span><strong>All uploaded.</strong> Everything this server needs is here.</span>
      </div>`)}`,
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
const REGISTRATION_LABEL = {
  open: 'Anyone can sign up',
  invite: 'Only with an invite code',
  closed: 'Nobody, accounts are created by an admin',
};
const CONTENT_LABEL = {
  morrowind: 'Morrowind',
  expansions: 'Morrowind + Tribunal + Bloodmoon',
  'tamriel-rebuilt': 'Tamriel Rebuilt',
};

/**
 * The address to hand to players.
 *
 * NOT location.origin blindly. Setting up from the machine itself means that is
 * "http://localhost:8090", which is every computer's word for itself: a player pasting it
 * opens their own machine and finds nothing. The review used to print it under "send them
 * this address", which is a wrong answer given confidently.
 */
function joinAddress() {
  if (answers.domain) return `https://${answers.domain}`;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    // Nobody can answer this from here. The browser says "localhost", which is every
    // computer's word for itself; the server, in a container, sees only the Docker bridge.
    // Saying so beats printing an address that reaches nothing.
    return null;
  }
  return location.origin;
}

/** True when the profile's files are not all present, so the world cannot run yet. */
let gameDataIncomplete = false;

function stepReview() {
  const line = (k, v) => html`<dt class="col-sm-5 fw-normal text-secondary">${k}</dt>
    <dd class="col-sm-7">${v}</dd>`;
  const mp = answers.deploymentMode === 'multiplayer';
  wizardShell(html`
    <h5>Ready to apply</h5>
    ${raw(gameDataIncomplete && mp ? html`
      <div class="callout callout-warning mb-3">
        <strong>The game files are not all here yet.</strong> Everything below still saves and
        the dashboard works, but nobody can join until the server has a complete copy of
        Morrowind. Go <a href="#" id="backToFiles">back one step</a> to add it, or do it later
        from <strong>Game data &amp; mods</strong>, which shows the same checklist.
      </div>` : '')}
    ${raw(ssoNeedingKeys().length ? html`
      <div class="callout callout-warning mb-3">
        <strong>${ssoNeedingKeys().map((p) => LOGIN_LABEL[p]).join(' and ')} still
        ${raw(ssoNeedingKeys().length === 1 ? 'needs its keys' : 'need their keys')}.</strong>
        Until then ${raw(ssoNeedingKeys().length === 1 ? 'that button does' : 'those buttons do')}
        not appear on the sign-in page. Add them any time under Settings, single sign-on.
      </div>` : '')}
    <dl class="row small mt-3">
      ${raw(line('Server', mp ? 'Multiplayer (experimental)' : 'Single player'))}
      ${raw(mp ? line('Server name', answers.serverName || '(unset)') : '')}
      ${raw(line('Sign-in methods', answers.loginMethods.length
        ? answers.loginMethods.map((m) => LOGIN_LABEL[m] || m).join(', ')
        : '(none)'))}
      ${raw(line('Who can sign up', REGISTRATION_LABEL[answers.registration] || '(unset)'))}
      ${raw(line('Content', CONTENT_LABEL[answers.contentProfile] || '(unset)'))}
      ${raw(line('Game files', answers.deliveryModel === 'serve' ? 'Served by this server' : 'Players bring their own'))}
      ${raw(line('Reachable', answers.hosting === 'public'
        ? (answers.domain
            ? `From the internet at ${answers.domain}, with a certificate issued automatically`
            : 'From the internet, using a self-signed certificate until you add a domain')
        : 'Local network only'))}
      ${raw(line('Uploads', answers.storage === 's3' ? `S3, ${answers.s3.bucket || 'bucket unset'}` : 'On this server'))}
    </dl>
    ${raw(html`
      <div class="vt-section-note mb-3">
        <strong>${raw(mp ? 'Getting players in.' : 'Your address.')}</strong> ${raw(mp
          ? 'Send them this address, they open it in a browser, nothing to install:'
          : 'This is where you play, and where anyone you invite would join:')}
        ${raw(joinAddress() ? html`
          <pre class="vt-mono mb-1 mt-2" id="joinLink">${joinAddress()}</pre>
          <button class="btn btn-sm btn-outline-secondary" id="copyJoin">Copy link</button>`
          : html`<p class="mb-0 mt-1">You are set up from this machine, so the address here is
            <code>localhost</code>, which only means "this computer". Open the dashboard from
            another device and the address bar will show the one to share.</p>`)}
        ${raw(answers.hosting === 'public' && !answers.domain ? html`<p class="small mb-0 mt-2">
          You chose to let people in over the internet but have not set a domain, so there is
          no address this page can give you: what your friends need is your home connection's
          public IP address, which you can find by searching the web for "what is my IP" on
          this machine. A domain name is worth the few pounds a year, because that address
          changes on its own and a domain does not.</p>` : '')}
        ${raw(answers.deliveryModel === 'verify' ? html`<p class="small mb-0 mt-2">Each player
          also needs their own copy of Morrowind's Data Files, since you chose that players
          bring their own.</p>` : '')}
      </div>`)}
    <p class="text-secondary small mb-0">Saving restarts the server, so you will sign in
      again.</p>`,
  { next: 'Save and restart', onNext: async () => {
    try {
      // ssoCreds for unticked providers must not ride along and resurrect stale keys.
      for (const p of Object.keys(answers.ssoCreds || {})) {
        if (!answers.loginMethods.includes(p)) delete answers.ssoCreds[p];
      }
      // Stamp the redirect URI from the domain as it stands NOW, so it always agrees with
      // the URL the sign-in step showed after any back-and-forth over the domain.
      for (const p of Object.keys(answers.ssoCreds || {})) {
        answers.ssoCreds[p].redirectUri = `${publicOrigin()}/auth/${p}/callback`;
      }
      await api('/setup', { method: 'POST', body: { ...answers, completed: true } });
      clearWizard();
      toast('Settings saved. Restarting the server…');
      await api('/restart', { method: 'POST' });
      waitForRestart();
    } catch (e) { toast(e.message, 'danger'); }
  } });
  const back = $('#backToFiles');
  if (back) back.onclick = (e) => { e.preventDefault(); step--; renderWizard(); };
  const cj = $('#copyJoin');
  if (cj) cj.onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#joinLink').textContent.trim());
      toast('Join link copied.');
    } catch { toast('Could not copy, select the link and copy it yourself.', 'danger'); }
  };
}

/** Poll until the server answers again, then go to the overview. */
function waitForRestart() {
  // THE GAME'S OWN LOADING SCREEN, not a Bootstrap spinner on an empty page. play/index.html
  // shows this exact sheet while the engine downloads and boots, so the one moment the
  // dashboard makes an operator wait looks like the product rather than like a framework
  // default. Same glyph, same Palatino title, same bronze-to-gold indeterminate bar, same
  // ember behind it.
  document.body.classList.add('vt-loading');
  setTitle('', '');
  view().innerHTML = html`
    <div class="ld-sheet">
      <div class="ld-inner">
        <div class="ld-glyph" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
            <circle cx="24" cy="24" r="17"/>
            <circle cx="24" cy="24" r="2.2" fill="currentColor" stroke="none"/>
            <path d="M24 7 27 24 24 41 21 24Z"/>
            <path d="M7 24 24 21 41 24 24 27Z"/>
          </svg>
        </div>
        <div class="ld-title">Restarting</div>
        <div class="ld-status" id="ldStatus">Applying your settings</div>
        <div class="ld-bar"><div class="ld-fill"></div></div>
        <div class="ld-detail" id="ldDetail"></div>
      </div>
    </div>`;
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const r = await fetch('/admin/api/state');
      if (r.ok) {
        await refreshState();
        // ADMIN SESSIONS DO NOT SURVIVE A RESTART, they live in memory. So the last act of
        // the setup wizard signs you out, and without this the operator answered ten
        // questions, watched a spinner, and landed on a login form under a cheerful green
        // "Server is back up" with nothing saying why. Say it plainly instead.
        document.body.classList.remove('vt-loading');
        if (!state.authed) {
          token.clear();
          pageLogin(false, 'The server restarted, so you have been signed out. '
            + 'Everything you set up was saved, sign in to carry on.');
          return;
        }
        go('#overview');
        toast('Server is back up.');
        return;
      }
    } catch { /* still down, expected */ }
    // A RESTART IS NOT ALWAYS QUICK. Measured at 87 seconds on a real one: the server flushes
    // ten databases on the way out, Docker backs off before starting it again, and the
    // healthcheck has its own grace period. The old copy promised "a few seconds" and then
    // polled silently once a second, so a normal restart looked hung and filled the console
    // with a hundred 502s from a proxy whose upstream was, correctly, not there.
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const d = $('#ldStatus');
    if (d) {
      d.textContent = secs < 20 ? 'Applying your settings'
        : secs < 60 ? 'Still starting up'
        : 'Taking longer than usual';
    }
    const detail = $('#ldDetail');
    if (detail && secs > 8) detail.textContent = `${secs}s`;

    if (secs > 240) {
      document.body.classList.remove('vt-loading');
      view().innerHTML = html`<div class="alert alert-danger">The server has not come back
        after four minutes. Check the container logs; if it is not configured to restart
        automatically you may need to start it yourself.</div>`;
      return;
    }
    // Back off: a restart that takes a minute does not need sixty attempts, and each failed
    // one is a console entry the operator has to scroll past.
    setTimeout(tick, secs < 10 ? 1000 : secs < 30 ? 2000 : 4000);
  };
  const startedAt = Date.now();
  setTimeout(tick, 1500);
}

// ---------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------
function pageLogin(totpRequired = false, notice = '') {
  setTitle('Sign in', 'Administration for this OpenMW-Web server.');
  view().innerHTML = html`
    <div class="vt-wizard" style="max-width:24rem">
      ${raw(notice ? html`<div class="alert alert-info">${notice}</div>` : '')}
      <div class="text-center mb-3">
        <img src="/admin/static/logo.svg" alt="" style="width:56px;height:56px">
      </div>
      <div class="card vt-card"><div class="card-body p-4">
        <form id="liForm" autocomplete="on">
        <div class="mb-3"><label class="form-label">Email or username</label>
          <input class="form-control" id="liName" autocomplete="username"
            placeholder="you@example.com"></div>
        <div class="mb-3"><label class="form-label">Password</label>
          <input class="form-control" id="liPass" type="password" autocomplete="current-password"></div>
        <div class="mb-3" ${raw(totpRequired ? '' : 'hidden')} id="liTotpWrap">
          <label class="form-label">Authenticator code</label>
          <input class="form-control" id="liTotp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
        </div>
        <button class="btn btn-primary w-100" id="liGo" type="submit">Sign in</button>
        </form>
        <div id="liErr" class="text-danger small mt-2"></div>
        <div id="liSso"></div>
        <div class="mt-3 small"><a href="#" id="liForgot">Forgot your password?</a></div>
        <div id="liForgotBox" class="mt-2" hidden>
          <p class="small text-secondary mb-2">We will email a reset link to the address on
            the account, if it has one and this server can send mail.</p>
          <div class="input-group input-group-sm">
            <input class="form-control" id="liForgotName" placeholder="you@example.com">
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
  $('#liForm').onsubmit = (e) => { e.preventDefault(); submit(); };
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

  // SSO side by side with the password, driven by what the server actually offers. The
  // fetch is best-effort: with no providers (or no network) the password form stands alone.
  fetch('/auth/providers').then((r) => r.json()).then((auth) => {
    const box = $('#liSso');
    const providers = (auth.providers || []).filter((p) => LOGIN_LABEL[p]);
    if (!box || !providers.length) return;
    box.innerHTML = html`
      <div class="text-center text-secondary small my-3 text-uppercase" style="letter-spacing:.06em">or</div>
      ${raw(providers.map((p) => html`
        <a class="btn btn-outline-secondary w-100 mb-2" href="/auth/${p}/start?return=admin">
          Continue with ${LOGIN_LABEL[p]}</a>`).join(''))}
      <div class="form-text text-center">Works for accounts that already have dashboard access.</div>`;
  }).catch(() => { /* password-only, which always works */ });
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
/** Is the player-facing web app staged? Served by the proxy from ./client, not by this
 *  server, so the only way to know is to ask for it the way a player's browser would. */
let clientStaged = null;
async function checkClientStaged() {
  try { clientStaged = (await fetch('/launcher.html', { method: 'HEAD' })).ok; }
  catch { clientStaged = null; } // unknown: say nothing rather than guess
}

async function pageOverview() {
  setTitle('Overview', 'What this server is doing right now.');
  const [o] = await Promise.all([api('/overview'), checkClientStaged()]);
  // AdminLTE's small-box widget, the coloured stat tiles the framework is known for,
  // used here as designed instead of a plain card impersonating one.
  // The gap lives on the COLUMN, not the box: the box now fills its column's height, so a
  // margin on it would push past the bottom and reintroduce the ragged row this fixed.
  const stat = (label, value, icon, tone, href = '') => html`
    <div class="col-12 col-md-6 col-lg-4 mb-3">
      <div class="small-box text-bg-${raw(tone)}">
        <div class="inner"><h3>${value}</h3><p>${label}</p></div>
        <i class="small-box-icon bi ${icon}"></i>
        ${raw(href ? html`<a href="${href}" class="small-box-footer">
          More <i class="bi bi-arrow-right-circle"></i></a>` : '<div class="small-box-footer">&nbsp;</div>')}
      </div>
    </div>`;
  const up = Math.round(o.uptime / 60);
  const rows = o.players.length ? o.players.map((p) => html`
    <tr><td>${p.name}</td><td class="text-secondary">${p.account}</td>
      <td>${p.cellKey || "-"}</td><td>${p.rank}</td></tr>`).join('')
    : html`<tr><td colspan="4" class="vt-empty">Nobody is in the world right now.</td></tr>`;

  // A SINGLE-PLAYER DASHBOARD IS A DIFFERENT PAGE, not the multiplayer one with things
  // greyed out. The world card named an internal id ("default") nobody chose and links to a
  // page about a world that has no other inhabitants; the player table has columns for rank
  // and location that only mean something when there are other people to outrank or find.
  // What an operator running this for themselves actually wants to know is whether the
  // machine is healthy, so that takes the space back.
  const solo = singlePlayer();
  const playing = o.playing || [];

  if (solo) {
    view().innerHTML = html`
      <div class="row">
        ${raw(stat('Playing now', `${playing.length}`, 'bi-controller', 'primary'))}
        ${raw(stat('Uptime', up < 60 ? `${up}m` : `${Math.round(up / 60)}h`, 'bi-clock-history', 'secondary'))}
        ${raw(sysCards(o.system))}
      </div>
      <div class="card card-outline card-primary">
        <div class="card-header"><h3 class="card-title">Playing now</h3></div>
        <div class="table-responsive"><table class="table table-hover mb-0">
          <thead><tr><th>Account</th><th>Last seen</th></tr></thead>
          <tbody>${raw(playing.length ? playing.map((p) => html`
            <tr><td>${p.account}</td><td class="text-secondary">${ago(p.lastSeen)}</td></tr>`).join('')
            : html`<tr><td colspan="2" class="vt-empty">Nobody is playing right now.</td></tr>`)}
          </tbody></table></div></div>`;
    return;
  }

  const checklist = setupChecklist();
  view().innerHTML = html`
    <div class="row">
      ${raw(stat(`Players (of ${o.maxPlayers})`, `${o.players.length}`, 'bi-people', 'primary', '#console'))}
      ${raw(stat('World', o.world.id, 'bi-globe-americas', 'success', '#mods'))}
      ${raw(stat('Uptime', up < 60 ? `${up}m` : `${Math.round(up / 60)}h`, 'bi-clock-history', 'secondary'))}
      ${raw(stat('Your role', state.role, 'bi-person-badge', 'warning', '#security'))}
    </div>
    ${raw(checklist)}
    <div class="card card-outline card-primary">
      <div class="card-header"><h3 class="card-title">In world</h3></div>
      <div class="table-responsive"><table class="table table-hover mb-0">
        <thead><tr><th>Name</th><th>Account</th><th>Location</th><th>Rank</th></tr></thead>
        <tbody>${raw(rows)}</tbody></table></div></div>`;
  wireChecklist();
}

/** "just now" / "3m ago" — a timestamp is not what the question wanted. */
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);

/**
 * Machine health, as the cards that replace the multiplayer ones.
 *
 * Every card is omitted when its reading is unavailable rather than drawn as a zero: no
 * /proc/net/dev outside Linux, no cpu delta on the very first poll after a restart. A
 * confident 0% is worse than a card that is not there.
 */
function sysCards(sys) {
  if (!sys) return '';
  const box = (label, value, sub, icon, tone) => html`
    <div class="col-12 col-md-6 col-lg-4 mb-3">
      <div class="small-box text-bg-${raw(tone)}">
        <div class="inner"><h3>${value}</h3><p>${label}</p>
          ${raw(sub ? html`<p class="small mb-0 text-secondary">${sub}</p>` : '')}</div>
        <i class="small-box-icon bi ${icon}"></i>
        <div class="small-box-footer">&nbsp;</div>
      </div>
    </div>`;
  let out = '';
  if (sys.cpu && sys.cpu.percent !== null) {
    out += box('CPU', `${sys.cpu.percent}%`, `${sys.cpu.cores} cores`, 'bi-cpu', 'info');
  }
  if (sys.memory && sys.memory.totalBytes > 0) {
    out += box('Memory', `${sys.memory.percent}%`,
      `${mb(sys.memory.usedBytes)} of ${mb(sys.memory.totalBytes)}`, 'bi-memory', 'info');
  }
  if (sys.disk) {
    // Free space, not used: "how much room is left" is the question an operator uploading
    // game files is actually asking.
    out += box('Disk free', mb(sys.disk.freeBytes), `${sys.disk.percent}% used`, 'bi-hdd', 'success');
  }
  if (sys.network) {
    out += box('Network', `${mb(sys.network.rxBytesPerSec)}/s`,
      `up ${mb(sys.network.txBytesPerSec)}/s`, 'bi-activity', 'secondary');
  }
  return out;
}

/**
 * One account's savegames.
 *
 * `mp` and `solo` are separate namespaces in storage — a character's multiplayer saves and its
 * single-player ones do not mix — so the scope is shown rather than quietly flattened, and an
 * import has to say which it is going into.
 */
function renderSaves(account, r) {
  const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  if (!r.storage) {
    return html`<div class="text-secondary">File storage is switched off for this server, so
      there are no savegames to show.</div>`;
  }
  const rows = r.saves.map((s) => html`
    <tr><td class="vt-mono">${s.name}</td>
      <td><span class="badge text-bg-secondary">${s.scope === 'solo' ? 'single player' : 'multiplayer'}</span></td>
      <td class="text-secondary">${mb(s.size)}</td>
      <td class="text-secondary">${(new Date(s.mtime)).toISOString().slice(0, 16).replace('T', ' ')}</td>
      <td class="text-end">${raw(can('owner') ? html`<button class="btn btn-sm btn-outline-secondary"
        data-savedl="${s.name}" data-savescope-of="${s.scope}">Download</button>` : '')}</td></tr>`).join('');
  return html`
    <div class="text-secondary mb-2">${r.saves.length}
      ${raw(r.saves.length === 1 ? 'save' : 'saves')}, ${mb(r.usedBytes)} of ${mb(r.quotaBytes)} used.</div>
    ${raw(r.saves.length ? html`<div class="table-responsive"><table class="table table-sm mb-2">
      <tbody>${raw(rows)}</tbody></table></div>` : '')}
    ${raw(can('owner') ? html`
      <label class="btn btn-sm btn-outline-secondary mb-0">Import a save<input type="file"
        accept=".omwsave" data-saveup hidden></label>
      <select class="form-select form-select-sm d-inline-block ms-2" style="width:auto" data-savescope>
        <option value="solo">into single player</option>
        <option value="mp">into multiplayer</option>
      </select>
      <div class="mt-1" data-savemsg></div>` : '')}`;
}

/** Import: presign, PUT the bytes straight to storage, then record it. */
function wireSaves(account, box, reload) {
  // Fetch the presigned URL with the session token, then navigate to it. A plain link to the
  // admin route would carry no Authorization header and be refused.
  box.querySelectorAll('[data-savedl]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const q = `account=${encodeURIComponent(account)}`
          + `&scope=${encodeURIComponent(b.dataset.savescopeOf)}`
          + `&name=${encodeURIComponent(b.dataset.savedl)}`;
        const { url } = await api(`/saves/file?${q}`);
        window.location.href = url;
      } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; }
    };
  });

  const pick = box.querySelector('[data-saveup]');
  if (!pick) return;
  pick.onchange = async () => {
    const file = pick.files[0];
    if (!file) return;
    const msg = box.querySelector('[data-savemsg]');
    const scope = box.querySelector('[data-savescope]').value;
    if (!/\.omwsave$/i.test(file.name)) {
      msg.innerHTML = html`<span class="text-danger">A savegame is a .omwsave file.</span>`;
      return;
    }
    msg.textContent = 'Uploading…';
    try {
      // The bytes go straight to storage, never through the admin API: a save can be hundreds
      // of megabytes and this is the same two-step the game's own upload uses.
      const { url } = await api('/saves/upload-url', { method: 'POST',
        body: { account, scope, name: file.name, size: file.size } });
      const put = await fetch(url, { method: 'PUT', body: file, duplex: 'half' });
      if (!put.ok) throw new Error(`storage refused the upload (HTTP ${put.status})`);
      await api('/saves/uploaded', { method: 'POST',
        body: { account, scope, name: file.name, size: file.size } });
      msg.innerHTML = html`<span class="text-success">Imported ${file.name}.</span>`;
      reload();
    } catch (e) {
      msg.innerHTML = html`<span class="text-danger">${e.message}</span>`;
    }
  };
}

/** Post-onboarding nudges, derived from real state rather than a stored progress flag. */
function setupChecklist() {
  if (localStorage.getItem('omwmp_checklist_hidden') === '1') return '';
  const items = [
    { done: !!state.name, label: 'Create an administrator account' },
    // Owner-only: pointing a viewer at the wizard sent them through every question to a
    // "forbidden" at the end.
    // No hash: the wizard is first-run only, so by the time this checklist is visible the
    // item is always done and the link would lead nowhere.
    ...(can('owner') ? [{ done: state.setupCompleted === true, label: 'Run the setup wizard' }] : []),
    { done: state.twoFactor === true, label: 'Add two-factor authentication to your account', hash: '#security' },
    { done: localStorage.getItem('omwmp_mods_seen') === '1', label: 'Review the game data and mod list', hash: '#mods' },
    // NOTHING USED TO SAY THIS. An operator could finish setup, upload every file, and still
    // have no way for anyone to play, because the player-facing app ships separately and no
    // screen mentioned it. Derived from a live check, so it clears itself once staged.
    ...(clientStaged === false
      ? [{ done: false, label: 'Add the player app: unpack an openmw-web release into the '
             + '"client" folder next to docker-compose.yml. Your Morrowind files are separate '
             + 'and are not what this is about.' }]
      : []),
    // Only shown when there IS an unfinished provider, so it is a live problem rather than
    // a permanent nag: a sign-in button the operator chose and cannot see.
    ...((state.setup?.ssoNeedsKeys || []).length
      ? [{ done: false, hash: '#settings',
           label: `Add the keys for ${(state.setup.ssoNeedsKeys).join(' and ')} sign-in, `
             + 'which is switched on but cannot be used yet' }]
      : []),
  ];
  if (items.every((i) => i.done)) return '';
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  return html`<div class="card card-success card-outline mb-3">
    <div class="card-header">
      <h3 class="card-title"><i class="bi bi-rocket-takeoff me-2"></i>Getting started</h3>
      <div class="card-tools">
        <button class="btn btn-tool" id="hideChecklist" title="Dismiss">
          <i class="bi bi-x-lg"></i></button>
      </div>
    </div>
    <div class="card-body">
      <div class="progress mb-3" style="height:8px" role="progressbar" aria-valuenow="${pct}">
        <div class="progress-bar bg-success" style="width:${pct}%"></div>
      </div>
      <ul class="list-unstyled mb-0">
        ${raw(items.map((i) => html`<li class="py-1">
          <i class="bi ${raw(i.done ? 'bi-check-circle-fill text-success' : 'bi-circle text-secondary')} me-2"></i>
          ${raw(i.hash && !i.done ? html`<a href="${i.hash}">${i.label}</a>` : html`<span class="${raw(i.done ? 'text-secondary' : '')}">${i.label}</span>`)}
        </li>`).join(''))}
      </ul>
    </div></div>`;
}
function wireChecklist() {
  const b = $('#hideChecklist');
  if (b) b.onclick = () => { localStorage.setItem('omwmp_checklist_hidden', '1'); route(); };
}

// ---------------------------------------------------------------------------------------
// console: players, moderation actions, and the full command set
// ---------------------------------------------------------------------------------------
// Every operation is a FORM, not a slash-command syntax quiz. The commands still run
// through the server's one executor (one audit trail, one rank check); the forms just build
// the line so the operator never has to know it existed. A raw command box survives at the
// bottom for whatever the forms have not caught up with.

/** Run a command line and show its output in the shared output pane. */
async function runCmd(line) {
  const out = $('#cmdOut');
  try {
    const r = await api('/command', { method: 'POST', body: { line } });
    out.textContent = r.message || (r.ok ? 'Done.' : 'Failed.');
    out.scrollIntoView({ block: 'nearest' });
    return r.ok;
  } catch (e) { out.textContent = e.message; return false; }
}

/** One quoted argument. Player names can contain spaces; commands split on them. */
const q = (s) => (/\s/.test(s) ? `"${s}"` : s);

async function pageConsole() {
  setTitle('Players & commands', 'Who is here, and everything you can do about it.');
  const [o, reports] = await Promise.all([
    api('/overview'),
    api('/reports?limit=20').catch(() => ({ reports: [] })),
  ]);
  const owner = can('owner');

  const rosterRows = o.players.length ? o.players.map((p) => html`
    <tr><td>${p.name}</td><td class="text-secondary small">${p.cellKey || '-'}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-secondary" data-act="kick" data-t="${p.name}"
          title="Disconnect them; they can rejoin">kick</button>
        <button class="btn btn-sm btn-outline-secondary" data-act="mute" data-t="${p.name}"
          title="They stay, but cannot chat">mute</button>
        <button class="btn btn-sm btn-outline-secondary" data-act="unmute" data-t="${p.name}">unmute</button>
        <button class="btn btn-sm btn-outline-danger" data-act="ban" data-t="${p.name}"
          title="Kick them and refuse the account from now on">ban</button>
      </td></tr>`).join('')
    : html`<tr><td colspan="3" class="vt-empty">Nobody is in the world right now.</td></tr>`;

  const reportRows = (reports.reports || []).map((r) => html`
    <tr><td class="small text-secondary text-nowrap">${(r.at || '').slice(5, 16).replace('T', ' ')}</td>
      <td>${r.by}</td><td>${r.about || '-'}</td><td class="small">${r.text}</td></tr>`).join('');

  // A form card: icon + title in a proper AdminLTE card header, inputs, one action button.
  const tool = (icon, title, blurb, bodyHtml, btnId, btnLabel, extra = '') => html`
    <div class="card card-outline card-secondary mb-3"><div class="card-header">
      <h3 class="card-title"><i class="bi ${icon} me-2"></i>${title}</h3></div>
      <div class="card-body">
        <p class="small text-secondary">${raw(blurb)}</p>
        ${raw(bodyHtml)}
        <button class="btn btn-sm btn-primary mt-2" id="${btnId}">${btnLabel}</button>
        ${raw(extra)}
      </div></div>`;

  view().innerHTML = html`
    <div class="row">
      <div class="col-lg-7">
        <div class="card card-outline card-primary mb-3">
          <div class="card-header"><h3 class="card-title">
            <i class="bi bi-people me-2"></i>In the world, ${o.players.length}
            of ${o.maxPlayers}</h3></div>
          <div class="table-responsive"><table class="table table-hover mb-0">
            <thead><tr><th>Player</th><th>Where</th><th></th></tr></thead>
            <tbody>${raw(rosterRows)}</tbody></table></div>
        </div>

        ${raw(tool('bi-megaphone', 'Broadcast',
          'A message to everyone currently playing, shown in their chat.',
          html`<input class="form-control" id="bcMsg" placeholder="Server restarting in five minutes">`,
          'bcGo', 'Send to everyone'))}

        ${raw(tool('bi-card-text', 'Message of the day',
          'Shown to every player when they join. Leave it empty and press save to clear it.',
          html`<input class="form-control" id="motdMsg">`,
          'motdGo', 'Save message'))}

        <div class="card card-outline card-warning mb-3"><div class="card-header">
          <h3 class="card-title"><i class="bi bi-flag me-2"></i>Player reports</h3></div>
          <div class="table-responsive"><table class="table table-sm mb-0">
            <thead><tr><th>When</th><th>From</th><th>About</th><th>Report</th></tr></thead>
            <tbody>${raw(reportRows || html`<tr><td colspan="4" class="vt-empty">No reports. Good.</td></tr>`)}</tbody>
          </table></div></div>
      </div>

      <div class="col-lg-5">
        <div class="card mb-3"><div class="card-header">
          <h3 class="card-title"><i class="bi bi-terminal me-2"></i>Output</h3></div>
          <div class="card-body"><div class="vt-out vt-mono" id="cmdOut">Results of anything you run appear here.</div></div></div>

        ${raw(tool('bi-chat-left-text', 'Read a chat log',
          'What a player has said recently, the moderation trail for a report.',
          html`<div class="row g-2">
            <div class="col-7"><input class="form-control" id="clName" placeholder="player name"></div>
            <div class="col-5"><input class="form-control" id="clMin" type="number" value="60" title="minutes back"></div>
          </div>`,
          'clGo', 'Show chat'))}

        ${raw(tool('bi-journal-bookmark', 'Quests',
          'See where a player\'s journal is, and if a quest is stuck, push its stage forward. '
          + 'Run it with just a name first to list their quests and stages.',
          html`<div class="row g-2">
            <div class="col-12"><input class="form-control" id="qName" placeholder="player name"></div>
            <div class="col-7"><input class="form-control vt-mono" id="qId" placeholder="quest id (optional)"></div>
            <div class="col-5"><input class="form-control" id="qStage" type="number" placeholder="set stage"></div>
          </div>`,
          'qGo', 'Look up / repair'))}

        ${raw(tool('bi-box-seam', 'Give an item',
          'Puts an item in a player\'s inventory, usually to repair something lost to a bug.',
          html`<div class="row g-2">
            <div class="col-6"><input class="form-control" id="gvName" placeholder="player name"></div>
            <div class="col-4"><input class="form-control vt-mono" id="gvItem" placeholder="gold_001"></div>
            <div class="col-2"><input class="form-control" id="gvCount" type="number" value="1"></div>
          </div>`,
          'gvGo', 'Give'))}

        ${raw(tool('bi-person-check', 'Bans',
          'Lift a ban, or ban by address when someone keeps coming back on new accounts.',
          html`<div class="row g-2">
            <div class="col-12"><input class="form-control" id="bnName" placeholder="account name or IP address"></div>
          </div>`,
          'unbanGo', 'Unban', html`
          <button class="btn btn-sm btn-outline-danger mt-2 ms-1" id="ipbanGo">IP-ban</button>`))}

        ${raw(owner ? tool('bi-award', 'Set a rank',
          'In-game moderation power: 0 player, 1 helper, 2 moderator, 3 admin. This is '
          + 'separate from dashboard access, which lives on the Accounts page.',
          html`<div class="row g-2">
            <div class="col-8"><input class="form-control" id="rkName" placeholder="account name"></div>
            <div class="col-4"><select class="form-select" id="rkRank">
              <option value="0">0, player</option><option value="1">1, helper</option>
              <option value="2">2, moderator</option><option value="3">3, admin</option>
            </select></div>
          </div>`,
          'rkGo', 'Set rank') : '')}

        <div class="card mb-3"><div class="card-header">
          <h3 class="card-title"><i class="bi bi-code-slash me-2"></i>Anything else</h3></div>
          <div class="card-body">
            <p class="small text-secondary">The raw command line, for whatever has no form
              yet. Type <span class="vt-mono">help</span> for the full list.</p>
            <div class="input-group">
              <span class="input-group-text vt-mono">/</span>
              <input class="form-control vt-mono" id="rawCmd">
              <button class="btn btn-outline-secondary" id="rawGo">Run</button>
            </div>
          </div></div>
      </div>
    </div>`;

  // Roster buttons, through the same /action contract the old dashboard used.
  view().querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.act, target = b.dataset.t;
      if (kind === 'ban') {
        const ok = await confirmAction({
          title: `Ban ${target}?`,
          body: html`<p>They are disconnected now and the account is refused from now on,
            until someone lifts the ban here.</p>`,
          danger: 'Ban',
        });
        if (!ok) return;
      }
      try {
        const r = await api('/action', { method: 'POST', body: { kind, target } });
        toast(r.message || `${kind} done.`, r.ok === false ? 'danger' : 'success');
        if (kind === 'kick' || kind === 'ban') route();
      } catch (e) { toast(e.message, 'danger'); }
    };
  });

  $('#bcGo').onclick = async () => {
    const msg = $('#bcMsg').value.trim();
    if (!msg) return;
    try {
      await api('/action', { method: 'POST', body: { kind: 'broadcast', detail: msg } });
      toast('Sent to everyone.');
      $('#bcMsg').value = '';
    } catch (e) { toast(e.message, 'danger'); }
  };
  $('#motdGo').onclick = () => runCmd(`motd ${$('#motdMsg').value.trim()}`.trim());
  $('#clGo').onclick = () => {
    const n = $('#clName').value.trim();
    if (n) runCmd(`chatlog ${q(n)} ${Number($('#clMin').value) || 60}`);
  };
  $('#qGo').onclick = () => {
    const n = $('#qName').value.trim(), id = $('#qId').value.trim(), st = $('#qStage').value;
    if (!n) return;
    if (id && st !== '') runCmd(`quest set ${q(n)} ${id} ${Number(st)}`);
    else runCmd(`quest ${q(n)}${id ? ` ${id}` : ''}`);
  };
  $('#gvGo').onclick = () => {
    const n = $('#gvName').value.trim(), item = $('#gvItem').value.trim();
    if (n && item) runCmd(`give ${q(n)} ${item} ${Number($('#gvCount').value) || 1}`);
  };
  $('#unbanGo').onclick = () => {
    const n = $('#bnName').value.trim();
    if (n) runCmd(`unban ${q(n)}`);
  };
  $('#ipbanGo').onclick = async () => {
    const n = $('#bnName').value.trim();
    if (!n) return;
    const ok = await confirmAction({
      title: `IP-ban ${n}?`,
      body: html`<p>Blocks the network address, not just the account, anyone sharing it
        (a household, a campus) is blocked too. Use an ordinary ban first when you can.</p>`,
      danger: 'IP-ban',
    });
    if (ok) runCmd(`ipban ${q(n)}`);
  };
  const rk = $('#rkGo');
  if (rk) rk.onclick = async () => {
    const n = $('#rkName').value.trim(), r = $('#rkRank').value;
    if (!n) return;
    if (r === '3') {
      const ok = await confirmAction({
        title: `Make ${n} a rank-3 admin?`,
        body: html`<p>Rank 3 can run script on other players' machines in-game. Only give it
          to someone you would hand the keys to.</p>`,
        danger: 'Set rank 3',
      });
      if (!ok) return;
    }
    runCmd(`setrank ${q(n)} ${r}`);
  };
  const rawGo = () => { const l = $('#rawCmd').value.trim(); if (l) runCmd(l.replace(/^\//, '')); };
  $('#rawGo').onclick = rawGo;
  $('#rawCmd').onkeydown = (e) => { if (e.key === 'Enter') rawGo(); };
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

  // A SINGLE-PLAYER SERVER IS NOT A MULTIPLAYER ONE WITH THE PLAYERS MISSING. Roughly half
  // these sections are read by a world this deployment never runs, or describe how people
  // treat each other when there is only one of them. Showing all 26 makes the handful that
  // matter hard to find, and every hidden one is a question the operator cannot answer
  // usefully. The server decides which those are; see MULTIPLAYER_ONLY.
  //
  // Hidden, not disabled, and never deleted: the values stay in the file, so a server that
  // later becomes multiplayer gets them all back exactly as they were.
  const hide = singlePlayer() ? new Set(settingsCache.multiplayerOnly || []) : new Set();
  const keep = (names) => names.filter((n) => !hide.has(n));

  const groups = [...settingsCache.groups, ...(others.length ? [{ group: 'Other', sections: others.map((s) => s.name) }] : [])]
    .map((g) => ({ ...g, sections: keep(g.sections) }))
    // A group whose every section is multiplayer-only ("Platform (advanced)") goes with them,
    // rather than sitting there as a heading that opens onto nothing.
    .filter((g) => g.sections.length);
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
      input = html`<span class="text-secondary small">This one is structured data a simple
        form cannot edit. If you need to change it, ask on the support Discord (link under
        Help), for everything else on this page the forms are enough.</span>`;
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

  // NOTHING IS BADGED "not used" ANY MORE. It used to mark auth, login and moderation as
  // inert on a single-player server, which was built on the idea that nobody else could ever
  // be there. People can be: "single player" says who the world is for, not who can reach
  // it. Telling an operator a section does nothing, while it quietly governs whether their
  // friends can sign in, is worse than saying nothing at all.
  const inert = false;

  // A section holding a flagged-dangerous field wears the red header, so the risk is
  // visible from the accordion, not only after scrolling into the field.
  const hasDanger = s.fields.some((f) => f.danger);
  const tone = hasDanger ? 'card-danger' : 'card-secondary';
  return html`
    <div class="card ${raw(tone)} card-outline mb-3 ${raw(inert ? 'opacity-75' : '')}" data-section="${s.name}">
      <div class="card-header d-flex align-items-center">
        <h3 class="card-title">
          ${raw(hasDanger ? '<i class="bi bi-exclamation-triangle me-2"></i>' : '')}${s.label || s.name}
          <span class="vt-mono text-secondary small ms-2">[${s.name}]</span>
          ${raw(inert ? '<span class="badge text-bg-secondary ms-2">not used, this is a single-player server</span>' : '')}</h3>
        <button class="btn btn-sm btn-primary ms-auto" data-save="${s.name}">
          <i class="bi bi-check-lg me-1"></i>Save</button>
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

/** Offer the restart right where the change was made, telling a non-technical operator to
 *  "restart the container" and leaving them to work out how is not a finished feature. */
function restartPrompt() {
  const b = $('#banner');
  b.innerHTML = html`<div class="callout callout-warning d-flex align-items-center">
    <div class="flex-grow-1"><strong>Saved, not live yet.</strong>
      The server reads its settings at startup, so it needs a restart.</div>
    <button class="btn btn-warning btn-sm" id="doRestart">
      <i class="bi bi-arrow-repeat me-1"></i>Restart now</button></div>`;
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
/**
 * Morrowind.esm is the game; everything else is content you may choose not to load.
 *
 * The three official masters were treated as one locked block, so Tribunal and Bloodmoon
 * could not be switched off even though playing vanilla with them installed is an ordinary
 * thing to want. Their ORDER stays fixed (the canonical sequence is what every mod expects to
 * load against), so they keep the lock icon and no move buttons; only the load checkbox opens.
 */
const isBase = (e) => e.file.toLowerCase() === 'morrowind.esm';

async function pageMods() {
  setTitle('The game and its mods', 'Morrowind itself, and anything added on top of it.');
  localStorage.setItem('omwmp_mods_seen', '1');
  const m = await api('/mods');
  const editable = can('owner');
  // Is Morrowind actually here? With nothing installed the page's job is to get the game in;
  // once it IS in, the upload is a rare corrective action and the load order is the point.
  const hasGame = (m.entries || []).length > 0;

  // Move buttons as well as dragging. HTML5 drag-and-drop does not fire for touch at all, so
  // drag alone meant load order simply could not be changed on a phone or tablet, and the
  // grab cursor advertised an affordance that device does not have. The buttons are also the
  // keyboard path.
  const rows = m.entries.map((e, i) => html`
    <tr draggable="${raw(editable && !e.official ? 'true' : 'false')}" data-i="${i}" data-file="${e.file}">
      <td class="${raw(editable && !e.official ? 'vt-drag' : 'text-secondary')}">${raw(e.official ? '🔒' : '⠿')}</td>
      <td><input class="form-check-input" type="checkbox" data-en="${i}"
        ${raw(e.enabled ? 'checked' : '')} ${raw(editable && !isBase(e) ? '' : 'disabled')}
        aria-label="Load ${e.file}"></td>
      <td class="vt-mono">${e.file}
        ${raw(isBase(e) ? ' <span class="badge text-bg-secondary">base game</span>'
          : e.official ? ' <span class="badge text-bg-secondary">expansion</span>' : '')}
        ${raw(e.isNew ? ' <span class="badge text-bg-warning">new</span>' : '')}</td>
      <td class="text-end text-nowrap">${raw(editable && !e.official ? html`
        <button class="btn btn-sm btn-outline-secondary" data-move="up" aria-label="Move ${e.file} earlier">↑</button>
        <button class="btn btn-sm btn-outline-secondary" data-move="down" aria-label="Move ${e.file} later">↓</button>` : '')}</td>
    </tr>`).join('');

  view().innerHTML = html`
    ${raw(!m.exists ? html`<div class="alert alert-warning">
      No game data folder at <code>${m.dir}</code>. Multiplayer still works without it, the
      server just cannot simulate NPCs itself.</div>` : '')}
    ${raw(m.missing.length ? html`<div class="alert alert-warning">
      These were in your load order but are no longer on disk, so they have been dropped:
      <span class="vt-mono">${m.missing.join(', ')}</span></div>` : '')}
    ${raw(editable && !hasGame ? uploadPanel(m) : '')}
    <div class="card card-primary card-outline"><div class="card-header d-flex align-items-center">
      <h3 class="card-title"><i class="bi bi-controller me-2"></i>Morrowind</h3>
      ${raw(editable && hasGame ? html`<button class="btn btn-sm btn-primary ms-auto" id="modSave">
        <i class="bi bi-check-lg me-1"></i>Save changes</button>` : '')}
    </div>
    ${raw(hasGame ? html`<div class="card-body pb-0"><p class="small text-secondary mb-0">
      The game itself, and its two expansions. This is not a mod and cannot be removed here —
      switch an expansion off to play without it.</p></div>` : '')}
    <div class="table-responsive"><table class="table table-hover mb-0">
      <thead><tr><th style="width:2rem"></th><th style="width:3rem">Load</th><th>File</th><th></th></tr></thead>
      <tbody id="modBody">${raw(rows || html`<tr><td colspan="4" class="vt-empty">No content files found.</td></tr>`)}</tbody>
    </table></div>
    ${raw(editable && hasGame ? html`<div class="card-body pt-2">
      <details><summary class="small text-secondary">Add or replace game files</summary>
        <div class="mt-2">${raw(uploadPanel(m, false, true))}</div></details></div>` : '')}
    </div>
    ${raw(modsCard(m, editable))}`;

  if (editable) wireMods(m);
  if (!editable) return;

  // Reload the page after an upload so the new files appear in the load order immediately -
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
    // No QR is fine, the key is printed right below it and typing it in is a supported
    // flow in every authenticator app.
    el.innerHTML = '';
  }
}

/** Add-files panel, shared by the mods page and the wizard's game-data step. */
/**
 * The mods card's behaviour: upload a zip, choose what is in it, order the results.
 *
 * The chooser is rendered INLINE as a staged panel rather than in the confirm modal. The modal
 * resolves a boolean and has its body replaced on each use; reading checkbox state back out of
 * something that is in the middle of hiding is the kind of thing that works until it doesn't.
 */
function wireMods(m) {
  const stage = $('#modStage');
  const drop = $('#modZip');

  const send = async (file) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      // Named before the upload rather than after: there is no point sending 400 MB to be told.
      toast('Only .zip archives can be installed. If this is a .7z or .rar, open it and save it '
        + 'as a .zip first.', 'err');
      return;
    }
    if (uploadRunning) { toast('An upload is already running.', 'err'); return; }
    uploadRunning = true;
    stage.innerHTML = html`<div class="alert alert-secondary">Reading
      <strong>${file.name}</strong> (${raw(sizeOf(file.size))})…</div>`;
    try {
      // Raw bytes with the name in the query, exactly as the Data Files upload does: a
      // multipart parser for a several-hundred-megabyte archive would be a dependency and a
      // memory problem. duplex:'half' is required to stream a File body.
      const r = await fetch(`/admin/api/mods/install?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.get()}`, 'content-type': 'application/octet-stream' },
        body: file,
        duplex: 'half',
      });
      const body = await r.json();
      if (!r.ok) { stage.innerHTML = html`<div class="alert alert-danger">${body.error}</div>`; return; }
      renderChooser(body);
    } catch (e) {
      stage.innerHTML = html`<div class="alert alert-danger">The upload did not finish: ${e.message}</div>`;
    } finally {
      uploadRunning = false;
    }
  };

  /** What the archive turned out to contain, and which parts to install. */
  const renderChooser = (staged) => {
    const many = staged.candidates.length > 1;
    stage.innerHTML = html`
      <div class="card card-secondary card-outline mb-3"><div class="card-body">
        <h5 class="mb-1">${staged.archive}</h5>
        <p class="small text-secondary">${raw(many
          ? `This archive holds ${staged.candidates.length} folders that look like game data. `
            + 'Mods often ship a core install plus optional extras; pick the ones you want.'
          : 'This is what was found inside.')}</p>
        ${raw(staged.candidates.map((c, i) => html`
          <label class="d-block border rounded p-2 mb-2">
            <input class="form-check-input me-2" type="checkbox" data-cand="${i}"
              ${raw(!many || i === 0 ? 'checked' : '')}>
            <strong class="vt-mono">${c.path || '(the archive itself)'}</strong>
            <div class="small text-secondary ms-4">
              ${raw([
                // EVERY ONE OF THESE IS A FILENAME OUT OF THE UPLOADED ZIP. They were joined
                // into a string and passed through raw(), so an archive containing a file named
                // with markup injected it straight into the owner's dashboard. The page's CSP
                // (script-src 'self', no unsafe-inline) stops it executing, which makes this an
                // injection rather than a takeover — not a reason to leave it. Built through the
                // escaping template instead, one line at a time.
                c.plugins.length ? html`${c.plugins.length === 1 ? 'plugin' : 'plugins'}:
                  <span class="vt-mono">${c.plugins.join(', ')}</span>` : '',
                c.archives.length ? html`archives:
                  <span class="vt-mono">${c.archives.join(', ')}</span>` : '',
                c.assetDirs.length ? html`${c.assetDirs.join(', ')}` : '',
                html`${c.files} files &middot; ${sizeOf(c.bytes)}`,
              ].filter(Boolean).join('<br>'))}
            </div>
          </label>`).join(''))}
        <label class="fld d-block mb-2"><span class="small text-secondary">Name it</span>
          <input class="form-control" id="modName" maxlength="120"
            value="${staged.archive.replace(/\.zip$/i, '')}"></label>
        <button class="btn btn-primary btn-sm" id="modGo">Install</button>
        <button class="btn btn-outline-secondary btn-sm ms-2" id="modCancel">Discard</button>
      </div></div>`;

    $('#modCancel').onclick = () => { stage.innerHTML = ''; };
    $('#modGo').onclick = async () => {
      const name = $('#modName').value.trim();
      const choices = staged.candidates
        .map((c, i) => ({ c, on: stage.querySelector(`[data-cand="${i}"]`).checked }))
        .filter((x) => x.on)
        .map(({ c }) => ({
          path: c.path,
          slug: c.suggestedSlug,
          // With several parts chosen they become separate mods, so each needs a name that
          // tells them apart; one part takes the name the operator typed.
          name: staged.candidates.length > 1 && c.path ? `${name} — ${c.path}` : name,
        }));
      if (!choices.length) { toast('Tick at least one folder to install.', 'err'); return; }
      $('#modGo').disabled = true;
      try {
        await api('/mods/install/commit', { method: 'POST', body: { token: staged.token, choices } });
        toast('Installed. Restart to load it.');
        route();
      } catch (e) {
        stage.innerHTML = html`<div class="alert alert-danger">${e.message}</div>`;
      }
    };
  };

  if (drop) {
    $('#modZipPick').onchange = (e) => send(e.target.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      send(e.dataTransfer.files[0]);
    };
  }

  const list = $('#modList');
  if (!list) return;

  // Same two affordances as the load-order table: buttons for touch and keyboard, drag for a
  // mouse. HTML5 drag events never fire on touch, so drag alone is not an option.
  list.querySelectorAll('[data-modmove]').forEach((btn) => {
    btn.onclick = () => {
      const cardEl = btn.closest('.vt-mod');
      const all = [...list.querySelectorAll('.vt-mod')];
      const to = all.indexOf(cardEl) + (btn.dataset.modmove === 'up' ? -1 : 1);
      if (to < 0 || to >= all.length) return;
      if (btn.dataset.modmove === 'up') list.insertBefore(cardEl, all[to]);
      else list.insertBefore(all[to], cardEl);
      btn.focus();
    };
  });

  let dragged = null;
  list.querySelectorAll('.vt-mod[draggable=true]').forEach((el) => {
    el.ondragstart = () => { dragged = el; el.classList.add('vt-dragging'); };
    el.ondragend = () => { dragged?.classList.remove('vt-dragging'); dragged = null; };
    el.ondragover = (e) => {
      e.preventDefault();
      if (!dragged || dragged === el) return;
      const r = el.getBoundingClientRect();
      list.insertBefore(dragged, e.clientY > r.top + r.height / 2 ? el.nextSibling : el);
    };
  });

  list.querySelectorAll('[data-moddel]').forEach((btn) => {
    btn.onclick = async () => {
      const cardEl = btn.closest('.vt-mod');
      const slug = cardEl.dataset.slug;
      const mod = (m.mods || []).find((x) => x.slug === slug);
      // Type-to-confirm, like every other delete here: the files go, and there is no undo.
      if (!await confirmAction({
        title: `Remove ${mod?.name ?? slug}?`,
        body: 'Its folder and everything in it is deleted from the game data directory. '
          + 'Your saves are not touched, but anything that depended on this mod will not load.',
        typeToConfirm: slug,
      })) return;
      try {
        await api(`/mods/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        toast('Removed. Restart to apply.');
        route();
      } catch (e) { toast(e.message, 'err'); }
    };
  });

  const save = $('#modsSave');
  if (save) {
    save.onclick = async () => {
      const mods = [...list.querySelectorAll('.vt-mod')].map((el) => ({
        slug: el.dataset.slug,
        enabled: el.querySelector('[data-modon]').checked,
        plugins: [...el.querySelectorAll('[data-plug]')]
          .map((p) => ({ file: p.dataset.plug, enabled: p.checked })),
      }));
      try {
        await api('/mods', { method: 'PUT', body: { mods } });
        toast('Mod changes saved.');
        restartPrompt();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
}

const sizeOf = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB`
  : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Installed mods: one card each, in load order.
 *
 * A SEPARATE LIST FROM THE TABLE ABOVE, deliberately. That table is the base game's own files,
 * which an operator drops in as a folder and never removes; these are packages that were
 * installed and can be uninstalled. Mixing them would put a Delete button next to Morrowind.esm.
 *
 * ORDER MEANS FILE PRIORITY HERE, which is the thing the operator is really choosing: OpenMW
 * gives a loose file to the LAST mod that provides it. Said in those words on the card, because
 * "load order" means the other ordering to anyone who has modded before.
 */
function modsCard(m, editable) {
  const mods = m.mods || [];
  const bsaClash = new Map((m.bsaCollisions || []).flatMap((c) => c.owners.map((o) => [o, c.name])));
  const byName = new Map(mods.map((x) => [x.slug, x.name]));
  // Grouped per mod so each card can say what IT does, rather than making the operator read a
  // table of pairs and work out which half is theirs.
  const group = (rows, key) => {
    const out = new Map();
    for (const r of rows || []) {
      if (!out.has(r[key])) out.set(r[key], []);
      out.get(r[key]).push(r);
    }
    return out;
  };
  const wins = group(m.conflicts, 'winner');
  const loses = group(m.conflicts, 'loser');
  const needs = group(m.missingMasters, 'mod');

  const card = (mod, i) => {
    const bits = [
      mod.plugins.length ? `${mod.plugins.length} plugin${mod.plugins.length > 1 ? 's' : ''}` : '',
      mod.archives.length ? `${mod.archives.length} archive${mod.archives.length > 1 ? 's' : ''}` : '',
      `${mod.files} files`, sizeOf(mod.bytes),
    ].filter(Boolean);
    return html`
    <div class="card card-secondary card-outline mb-2 vt-mod" draggable="${raw(editable ? 'true' : 'false')}"
      data-slug="${mod.slug}" data-i="${i}">
      <div class="card-body py-2">
        <div class="d-flex align-items-center gap-2">
          ${raw(editable ? '<span class="vt-drag text-secondary">⠿</span>' : '')}
          <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" data-modon
              ${raw(mod.enabled ? 'checked' : '')} ${raw(editable ? '' : 'disabled')}
              aria-label="Load ${mod.name}">
          </div>
          <div class="flex-grow-1">
            <strong>${mod.name}</strong>
            <span class="vt-mono small text-secondary ms-2">${mod.slug}</span>
          </div>
          ${raw(editable ? html`
            <button class="btn btn-sm btn-outline-secondary" data-modmove="up" aria-label="Move ${mod.name} earlier">↑</button>
            <button class="btn btn-sm btn-outline-secondary" data-modmove="down" aria-label="Move ${mod.name} later">↓</button>
            <button class="btn btn-sm btn-outline-secondary" data-moddel aria-label="Remove ${mod.name}">Remove</button>` : '')}
        </div>
        <div class="small text-secondary mt-1">${bits.join(' · ')}</div>
        ${raw(mod.present === false ? html`<div class="alert alert-warning py-1 px-2 small mt-2 mb-0">
          Its folder is gone from the game data directory, so this will not load.</div>` : '')}
        ${raw(bsaClash.has(mod.slug) ? html`<div class="small mt-1">
          <span class="badge text-bg-secondary">${bsaClash.get(mod.slug)}</span>
          also ships with another mod. Both are loaded; this one's copy is kept separate.</div>` : '')}
        ${raw((needs.get(mod.slug) || []).map((n) => html`
          <div class="alert alert-danger py-1 px-2 small mt-2 mb-0">
            <strong>${n.plugin}</strong> needs <span class="vt-mono">${n.master}</span>, which is
            not loaded. Morrowind refuses to start when a plugin's master is missing, so either
            switch that back on or switch this mod off.</div>`).join(''))}
        ${raw((wins.get(mod.slug) || []).map((c) => html`
          <div class="small mt-1"><span class="badge text-bg-warning">replaces ${c.files}</span>
            ${raw(c.files === 1 ? 'file' : 'files')} also in <strong>${byName.get(c.loser) || c.loser}</strong>,
            because this mod is further down the list.</div>`).join(''))}
        ${raw((loses.get(mod.slug) || []).map((c) => html`
          <div class="small mt-1 text-secondary">${c.files}
            ${raw(c.files === 1 ? 'file is' : 'files are')} overridden by
            <strong>${byName.get(c.winner) || c.winner}</strong> below.</div>`).join(''))}
        ${raw(mod.plugins.length ? html`<details class="mt-2">
          <summary class="small text-secondary">What's inside</summary>
          <div class="small mt-1">${raw(mod.plugins.map((p) => html`
            <label class="me-3"><input type="checkbox" class="form-check-input me-1" data-plug="${p.file}"
              ${raw(p.enabled ? 'checked' : '')} ${raw(editable ? '' : 'disabled')}>
              <span class="vt-mono">${p.file}</span></label>`).join(''))}
            ${raw(mod.archives.length ? html`<div class="text-secondary mt-1 vt-mono">${mod.archives.join(', ')}</div>` : '')}
          </div></details>` : '')}
      </div>
    </div>`;
  };

  return html`
    <div class="card card-primary card-outline mt-3">
      <div class="card-header d-flex align-items-center">
        <h3 class="card-title"><i class="bi bi-box-seam me-2"></i>Mods</h3>
        ${raw(editable && mods.length ? html`<button class="btn btn-sm btn-primary ms-auto" id="modsSave">
          <i class="bi bi-check-lg me-1"></i>Save changes</button>` : '')}
      </div>
      <div class="card-body">
        ${raw(editable ? html`
          <div id="modZip" class="vt-drop mb-3">
            <div class="text-secondary">Drop a mod <strong>.zip</strong> here</div>
            <label class="btn btn-sm btn-outline-secondary mt-2 mb-0">Choose a zip<input
              type="file" id="modZipPick" accept=".zip" hidden></label>
          </div>
          <div id="modStage"></div>` : '')}
        ${raw(mods.length ? html`
          <p class="small text-secondary">When two mods contain the same file, the one further
            down this list wins. Drag to change that.</p>
          <div id="modList">${raw(mods.map(card).join(''))}</div>`
          : html`<p class="vt-empty mb-0">No mods installed.</p>`)}
      </div>
    </div>`;
}

function uploadPanel(m, inWizard = false, bare = false) {
  const body = html`
      ${raw(m.writable === false ? html`
        <div class="alert alert-warning mb-0">
          The game data folder is read-only, so files cannot be uploaded from here. Copy them
          into <code>${m.dir}</code> directly, or remove <code>:ro</code> from the
          <code>gamedata</code> volume in <code>docker-compose.yml</code> and restart.
        </div>` : html`
        ${raw(inWizard ? '' : html`<p class="small text-secondary">Morrowind's
          <strong>Data Files</strong> folder is more than the plugins:
          <code>Sound</code>, <code>Music</code>, <code>Video</code>, <code>Fonts</code>,
          <code>Splash</code> sit loose beside them and are not inside
          any archive. Add the <em>whole folder</em>: with only the .esm and .bsa the game runs
          silently, with no voice, music or intro.</p>`)}
        <p class="small text-secondary">
          <label class="btn btn-sm btn-outline-secondary mb-0">Choose the Data Files folder<input
            type="file" id="upDir" webkitdirectory directory multiple hidden></label></p>
        <div id="upDrop" class="vt-drop">
          <div class="text-secondary">Drop your whole <strong>Data Files</strong> folder here</div>
        </div>
        <div id="upList" class="mt-2 small"></div>
        <p class="small text-secondary mt-2 mb-0">You can also copy files straight into
          <code>${m.dir}</code>, with the supplied Docker setup that is the
          <code>gamedata</code> folder next to your <code>docker-compose.yml</code>.</p>`)}`;
  // The wizard and the "no game data yet" case want this as its own card. Once the game IS
  // installed the same markup lives inside the game card, behind a disclosure, because at that
  // point it is a rare corrective action rather than the thing to do next.
  return bare ? body : html`
    <div class="card card-secondary card-outline mb-3">
      <div class="card-header"><h3 class="card-title">
        <i class="bi bi-cloud-arrow-up me-2"></i>${raw(inWizard ? 'Drop the folder here' : 'Add game data files')}</h3></div>
      <div class="card-body">${raw(body)}</div></div>`;
}

/** One upload run at a time, across the whole page. Dropping a folder twice, or dropping
 *  while a run is going, used to start a second pass that raced the first for the same file:
 *  two requests writing one target, and whichever renamed second failed. */
let uploadRunning = false;

/** Wire the upload panel. `onDone` runs after the last file finishes. */
function wireUpload(onDone) {
  const drop = $('#upDrop');
  if (!drop) return; // read-only folder: no panel rendered
  const list = $('#upList');

  // A Data Files folder is thousands of files, so this reports progress in aggregate rather
  // than one row per file, a list that long is not information, it is a wall.
  const send = async (entries) => {
    if (!entries.length) return;
    if (uploadRunning) {
      toast('An upload is already running. Wait for it to finish before adding more.', 'warning');
      return;
    }
    uploadRunning = true;
    // CONTINUE IS HELD WHILE FILES ARE IN FLIGHT. Leaving the step mid-run does not stop the
    // uploads, but it does take away the only progress readout and the only place the
    // outcome is reported, so an operator who wandered on would be told nothing about a run
    // that was still going, and the next step would be checking a folder still being written.
    const next = $('#wzNext');
    const back = $('#wzBack');
    const label = next?.textContent;
    if (next) { next.disabled = true; next.textContent = 'Uploading…'; }
    if (back) back.disabled = true;
    try {
      await runUpload(entries);
    } finally {
      uploadRunning = false;
      // Only if the step is still on screen: onDone re-renders, which replaces this button.
      const still = $('#wzNext');
      if (still && still.textContent === 'Uploading…') {
        still.disabled = false;
        still.textContent = label ?? 'Continue';
      }
      const backNow = $('#wzBack');
      if (backNow) backNow.disabled = false;
    }
  };

  const runUpload = async (entries) => {
    const row = document.createElement('div');
    row.className = 'py-2';
    list.replaceChildren(row);
    let done = 0;
    let bytes = 0;
    const skipped = [];
    const failed = [];
    // WHY a file failed, not just that it did. The first version pushed a filename onto one
    // undifferentiated list and showed three of them, so a dead session — every single
    // request 401ing — looked identical to three corrupt files, and the operator was told
    // "2,847 failed: Sound/Fx/a.wav, ..." with no cause and nothing to do about it.
    const reasons = new Map();
    const note = (why) => reasons.set(why, (reasons.get(why) ?? 0) + 1);
    /** Set when continuing is pointless: session gone, server gone, disk full. */
    let stopped = null;

    const paint = (extra = '') => {
      const total = done + skipped.length + failed.length;
      const pct = Math.round((total / entries.length) * 100);
      // Honesty in the bar itself. It used to turn green at the end whatever happened, so an
      // upload where nothing landed still finished looking like success. That is the
      // "it said they all failed, then said it was complete" report, exactly.
      const tone = extra ? 'progress-bar-striped progress-bar-animated'
        : done === 0 ? 'bg-danger' : failed.length ? 'bg-warning' : 'bg-success';
      row.innerHTML = html`
        <div class="progress mb-1" style="height:10px" role="progressbar" aria-valuenow="${pct}">
          <div class="progress-bar ${raw(tone)}" style="width:${pct}%"></div>
        </div>
        <div><strong>${done}</strong> of ${entries.length} added
        · ${(bytes / 1048576).toFixed(0)} MB${raw(extra)}</div>
        ${raw(skipped.length && done > 0 ? html`<div class="small text-secondary">${skipped.length} skipped
          (not game data, that is normal for a folder with extras in it)</div>` : '')}
        ${raw(done === 0 && skipped.length > 3 && !failed.length ? html`
          <div class="alert alert-warning py-2 px-3 small mt-2 mb-0">
            <strong>None of those were game files.</strong> The likeliest reason is that the
            folder dropped was the one <em>containing</em>
            <code>Data Files</code> rather than <code>Data Files</code> itself. Open it and
            drag the <code>Data Files</code> folder from inside. Nothing was changed here.
          </div>` : '')}
        ${raw([...reasons].map(([why, n]) => html`<div class="small text-danger">
          ${n} file${raw(n === 1 ? '' : 's')}: ${why}</div>`).join(''))}
        ${raw(stopped ? html`<div class="alert alert-danger py-2 px-3 small mt-2 mb-0">
          ${raw(stopped)}</div>` : '')}`;
    };
    paint(' · uploading…');

    // EIGHT AT A TIME, not one. A Data Files folder is thousands of files and most of them
    // are tiny voice clips, so the run was almost entirely round-trip latency: one request
    // out, one answer back, repeat ten thousand times. Sending several at once turns that
    // dead time into throughput, and the proxy speaks HTTP/2, so they share one connection
    // rather than opening eight.
    //
    // Only safe because the temp-file collision is fixed: every request now writes its own
    // temp path, so two uploads can never be mid-rename over the same target. Before that,
    // this change would have turned a rare bug into the common case.
    let cursor = 0;
    const sendOne = async ({ file, path }) => {
      try {
        // Raw body, not multipart: the server streams it straight to disk, and a multipart
        // parser for a 400 MB archive would be a dependency plus a memory problem. The PATH
        // travels in the query, because loose media is loaded by path and must keep its
        // directory, "Music/Explore/mx_explore_1.mp3", not "mx_explore_1.mp3".
        const r = await fetch(`/admin/api/mods/upload?name=${encodeURIComponent(path)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token.get()}`, 'content-type': 'application/octet-stream' },
          body: file,
          duplex: 'half',
        });
        if (r.status === 400) { skipped.push(path); }      // not game data; expected in bulk
        else if (r.status === 401 || r.status === 403) {
          // Admin sessions live in memory, so a server restart (or a long upload outliving
          // its four hours) invalidates them mid-run. Every remaining request would 401 too:
          // stop, and say the one thing that fixes it.
          stopped = 'You were signed out while this was uploading, so the rest were refused. '
            + 'Nothing already added was lost. Sign in again and drop the same folder in, '
            + 'files that are already there are simply skipped.';
          failed.push(path);
          return 'stop';
        } else if (r.status === 429) {
          // Backing off beats failing: this endpoint shares the session's request budget.
          await new Promise((res) => setTimeout(res, 2000));
          const retry = await fetch(`/admin/api/mods/upload?name=${encodeURIComponent(path)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token.get()}`, 'content-type': 'application/octet-stream' },
            body: file,
            duplex: 'half',
          });
          if (retry.ok) { done++; bytes += file.size; }
          else { failed.push(path); note('refused because uploads were coming too fast'); }
        } else if (!r.ok) {
          failed.push(path);
          const body = await r.json().catch(() => null);
          note(body?.error || `rejected by the server (${r.status})`);
        } else { done++; bytes += file.size; }
      } catch {
        // A dropped connection, which on a folder this size is a matter of time. One retry
        // covers a blip; a server that is actually down ends the run rather than grinding
        // through thousands of guaranteed failures.
        try {
          const retry = await fetch(`/admin/api/mods/upload?name=${encodeURIComponent(path)}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token.get()}`, 'content-type': 'application/octet-stream' },
            body: file,
            duplex: 'half',
          });
          if (retry.ok) { done++; bytes += file.size; }
          else { failed.push(path); note('could not be sent'); }
        } catch {
          failed.push(path);
          stopped = 'The connection to the server dropped, so the rest were not attempted. '
            + 'Check it is still running, then drop the same folder in again, anything '
            + 'already uploaded is skipped.';
          return 'stop';
        }
      }
      return 'ok';
    };

    const LANES = 8;
    const worker = async () => {
      for (;;) {
        if (stopped) return;
        const i = cursor++;
        if (i >= entries.length) return;
        if (await sendOne(entries[i]) === 'stop') return;
        // Repaint on a cadence rather than per file: at eight lanes the counters move fast
        // enough that rendering each one is its own cost.
        if ((done + skipped.length + failed.length) % 25 === 0) paint(' · uploading…');
      }
    };
    await Promise.all(Array.from({ length: LANES }, worker));
    paint('');
    // Say it out loud too: the panel can be scrolled off on a long page.
    if (stopped) toast('Upload stopped before it finished, see the message above.', 'danger');
    else if (done === 0 && failed.length) toast('Nothing was added, every file was refused.', 'danger');
    else if (failed.length) toast(`${done} added, ${failed.length} could not be.`, 'warning');
    if (onDone) onDone();
  };

  // WHAT THE SERVER WILL ACCEPT, mirrored so the obvious refusals never leave the browser.
  // A Data Files folder carries readmes, .pk leftovers and installer junk; every one of them
  // used to cost a request, a round trip and a red 400 in the console, which made an
  // ordinary upload look like it was failing. Deliberately looser than the server's rule:
  // this only drops extensions nothing could ever want, and the server still decides where
  // anything else belongs.
  const WANTED = /\.(esm|esp|bsa|ba2|omwaddon|omwgame|mp3|wav|bik|fnt|tex|dds|tga|bmp|zip)$/i;

  /** Turn a picker or a drop into {file, path} pairs, keeping each file's folder. */
  const fromInput = (input) => [...input.files]
    .map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))
    .filter((e) => WANTED.test(e.path));

  /** Walk a dropped directory tree. Drag-and-drop gives entries, not paths, so the tree has
   *  to be traversed by hand, dataTransfer.files alone silently yields only loose files. */
  const walkEntry = async (entry, prefix, out) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      // readEntries returns at most 100 at a time and must be called until it returns none.
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, `${prefix + entry.name}/`, out);
    }
  };

  const dir = $('#upDir');
  if (dir) dir.onchange = () => send(fromInput(dir));

  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const items = [...(e.dataTransfer.items ?? [])]
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (items.length) {
      const out = [];
      for (const entry of items) await walkEntry(entry, '', out);
      send(out.filter((e) => WANTED.test(e.path)));
      return;
    }
    // No entry API (older browser): loose files only, which is better than nothing.
    send([...e.dataTransfer.files]
      .map((f) => ({ file: f, path: f.name })).filter((x) => WANTED.test(x.path)));
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
        <td class="text-secondary small">${a.username || '-'}</td>
        <td>${a.rank}</td>
        <td>
          ${raw(can('owner') ? html`
          <select class="form-select form-select-sm" data-role-for="${a.name}">
            <option value="" ${raw(!a.dashboardRole ? 'selected' : '')}>no access</option>
            <option value="viewer" ${raw(a.dashboardRole === 'viewer' ? 'selected' : '')}>viewer</option>
            <option value="moderator" ${raw(a.dashboardRole === 'moderator' ? 'selected' : '')}>moderator</option>
            <option value="owner" ${raw(a.dashboardRole === 'owner' ? 'selected' : '')}>owner</option>
          </select>` : html`<span class="text-secondary">${a.dashboardRole || '-'}</span>`)}
        </td>
        <td class="text-secondary small">${(a.lastSeenAt || '').slice(0, 10)}</td>
        <td class="text-end text-nowrap">
          ${raw(a.banned && can('moderator')
            ? html`<button class="btn btn-sm btn-outline-secondary" data-unban="${a.name}">unban</button> ` : '')}
          ${raw(can('owner')
            ? html`<button class="btn btn-sm btn-outline-danger" data-del="${a.name}">erase</button>` : '')}</td>
      </tr>
      <tr class="vt-saves-row"><td colspan="6" class="pt-0">
        <details data-saves="${a.name}"><summary class="small text-secondary">Savegames</summary>
          <div class="mt-2 small" data-saves-for="${a.name}">Loading…</div></details></td></tr>`).join('');
    $('#accBody').innerHTML = rows || html`<tr><td colspan="6" class="vt-empty">No accounts match.</td></tr>`;

    // SAVEGAMES, loaded when the row is opened rather than for every account up front: a
    // hundred accounts would be a hundred queries to answer a question nobody asked.
    view().querySelectorAll('details[data-saves]').forEach((d) => {
      d.ontoggle = async () => {
        if (!d.open || d.dataset.loaded) return;
        d.dataset.loaded = '1';
        const account = d.dataset.saves;
        const box = view().querySelector(`[data-saves-for="${CSS.escape(account)}"]`);
        try {
          const r = await api(`/saves?account=${encodeURIComponent(account)}`);
          box.innerHTML = renderSaves(account, r);
          wireSaves(account, box, () => { d.dataset.loaded = ''; d.ontoggle(); });
        } catch (e) {
          box.innerHTML = html`<div class="text-danger">${e.message}</div>`;
        }
      };
    });

    view().querySelectorAll('[data-role-for]').forEach((sel) => {
      sel.onchange = async () => {
        // Promotion to owner hands over everything, settings, other people's access, the
        // backup with the password hashes in it. Not a change to make on a mis-click.
        if (sel.value === 'owner') {
          const ok = await confirmAction({
            title: `Make ${sel.dataset.roleFor} an owner?`,
            body: html`<p>Owners can change every setting, grant and remove anyone's access -
              including yours, and download full backups.</p>`,
            danger: 'Make owner',
          });
          if (!ok) { render($('#accQ').value); return; }
        }
        try {
          await api('/accounts/role', { method: 'POST', body: { name: sel.dataset.roleFor, role: sel.value } });
          toast(`Updated access for ${sel.dataset.roleFor}.`);
        } catch (e) { toast(e.message, 'danger'); render($('#accQ').value); }
      };
    });
    view().querySelectorAll('[data-unban]').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api('/action', { method: 'POST', body: { kind: 'unban', target: b.dataset.unban } });
          toast(r.message || `${b.dataset.unban} unbanned.`);
          render($('#accQ').value);
        } catch (e) { toast(e.message, 'danger'); }
      };
    });
    view().querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.del;
        const ok = await confirmAction({
          title: `Erase ${name}?`,
          body: html`<p>This permanently deletes the account and everything belonging to it -
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
    ${raw(can('owner') ? html`
    <div class="card card-outline card-secondary mb-3"><div class="card-header">
      <h3 class="card-title"><i class="bi bi-person-plus me-2"></i>Add someone</h3></div>
      <div class="card-body">
        <div class="row g-2 align-items-end">
          <div class="col-sm-4"><label class="form-label small">Email address</label>
            <input class="form-control" id="naName" type="email" autocomplete="off"
              placeholder="them@example.com"></div>
          <div class="col-sm-4"><label class="form-label small">Password</label>
            <input class="form-control" id="naPass" type="password" autocomplete="new-password"></div>
          <div class="col-sm-2"><label class="form-label small">Access</label>
            <select class="form-select" id="naRole">
              <option value="moderator" selected>moderator</option>
              <option value="viewer">viewer</option>
              <option value="owner">owner</option>
            </select></div>
          <div class="col-sm-2"><button class="btn btn-primary w-100" id="naGo">Create</button></div>
        </div>
        <div class="form-text">Creates the account and grants dashboard access in one go.
          To grant access to someone who already plays here, use their row below instead.</div>
        <div id="naErr" class="text-danger small"></div>
      </div></div>` : '')}
    <div class="card card-outline card-primary"><div class="card-header">
      <input class="form-control" id="accQ" placeholder="Search accounts…" value="${q}">
    </div>
    <div class="table-responsive"><table class="table table-hover mb-0">
      <thead><tr><th>Account</th><th>Handle</th><th>Rank</th><th style="width:11rem">Dashboard access</th>
        <th>Last seen</th><th></th></tr></thead>
      <tbody id="accBody"><tr><td colspan="6" class="vt-empty">Loading…</td></tr></tbody>
    </table></div></div>`;
  const na = $('#naGo');
  if (na) na.onclick = async () => {
    try {
      const r = await api('/accounts/create', { method: 'POST', body: {
        name: $('#naName').value.trim(), password: $('#naPass').value, role: $('#naRole').value,
      } });
      toast(`${r.name} created as ${r.role}.`);
      $('#naName').value = ''; $('#naPass').value = ''; $('#naErr').textContent = '';
      render($('#accQ').value);
    } catch (e) { $('#naErr').textContent = e.message; }
  };
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
    <div class="card card-primary card-outline"><div class="card-header"><h3 class="card-title"><i class="bi bi-key me-2"></i>Signed-in browsers</h3></div><div class="table-responsive"><table class="table mb-0">
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
    <div class="card card-primary card-outline" style="max-width:34rem">
      <div class="card-header"><h3 class="card-title">
        <i class="bi bi-shield-lock me-2"></i>Authenticator app
        ${raw(on ? '<span class="badge text-bg-success ms-2">on</span>'
                 : '<span class="badge text-bg-secondary ms-2">off</span>')}</h3></div>
      <div class="card-body">
      <p class="small text-secondary">Adds a six-digit code to your password sign-in, so your
        password alone is not enough to get in. Single sign-on is unaffected, the provider
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
    // followed, it left people hand-typing a 32-character base32 string into a phone.
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
        switched on, that is what stops you locking yourself out with a key your phone
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
      // Time in its own column, message in another. As one run of inline text the timestamp
      // was just the first word of a paragraph, so any long line wrapped and left the clock
      // stranded on a line of its own above the entry it belonged to.
      return html`<div class="lvl-${raw(esc(level))}"><span class="ts">${ts.slice(11, 19)}</span
        ><span class="msg"><span class="ev">${event}</span> ${extra}</span></div>`;
    }).join('');
    $('#logBox').innerHTML = rows || html`<div class="vt-empty">Nothing logged yet.</div>`;
  };
  view().innerHTML = html`
    <div class="card card-secondary card-outline">
      <div class="card-header">
        <h3 class="card-title"><i class="bi ${raw(filter ? 'bi-clipboard-check' : 'bi-journal-text')} me-2"></i>${title}</h3>
        <div class="card-tools">
          <label class="me-2 small text-secondary">
            <input type="checkbox" class="form-check-input me-1" id="logAuto">auto-refresh</label>
          <button class="btn btn-tool" id="logRefresh" title="Refresh"><i class="bi bi-arrow-clockwise"></i></button>
        </div>
      </div>
      <div class="card-body"><div class="vt-log vt-mono" id="logBox">Loading…</div></div></div>`;
  $('#logRefresh').onclick = draw;
  // A live tail without a websocket: poll while the box is ticked and the page is open.
  let timer = null;
  $('#logAuto').onchange = (e) => {
    if (e.target.checked) timer = setInterval(() => { if ($('#logBox')) draw(); else clearInterval(timer); }, 3000);
    else clearInterval(timer);
  };
  await draw();
}

async function pageMetrics() {
  setTitle('Metrics', 'Counters this server keeps about itself.');
  const m = await api('/metrics');
  const groups = Object.entries(m.groups || {});
  view().innerHTML = groups.length ? html`
    <div class="row">${raw(groups.map(([name, rows]) => html`
      <div class="col-lg-6"><div class="card card-info card-outline mb-3">
        <div class="card-header"><h3 class="card-title">
          <i class="bi bi-graph-up me-2"></i>${name}</h3></div>
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
    <div class="row">
    <div class="col-12 col-xl-6"><div class="card card-warning card-outline mb-3">
      <div class="card-header"><h3 class="card-title">
        <i class="bi bi-cone-striped me-2"></i>Maintenance mode
        ${raw(m.on ? ' <span class="badge text-bg-warning ms-2">on</span>' : '')}</h3></div>
      <div class="card-body">
      <p class="small text-secondary">Disconnects everyone and refuses new connections with a
        message. Use it before changing mods or settings so nobody is halfway through
        something when the server restarts.</p>
      <div class="mb-3"><label class="form-label">Message shown to players</label>
        <input class="form-control" id="mMsg" value="${m.message || ''}"
          placeholder="Back in ten minutes, updating mods"></div>
      <button class="btn ${raw(m.on ? 'btn-success' : 'btn-warning')}" id="mToggle">
        ${raw(m.on ? 'Turn maintenance mode off' : 'Turn maintenance mode on')}</button>
    </div></div></div>

    <div class="col-12 col-xl-6"><div class="card card-warning card-outline mb-3">
      <div class="card-header"><h3 class="card-title">
        <i class="bi bi-arrow-repeat me-2"></i>Restart</h3></div>
      <div class="card-body">
      <p class="small text-secondary">Applies saved settings and mod changes. Players are
        disconnected and can reconnect once it is back, usually within a few seconds.</p>
      <button class="btn btn-warning" id="mRestart">Restart the server</button>
    </div></div></div>

    <div class="col-12 col-xl-6"><div class="card card-secondary card-outline mb-3">
      <div class="card-header"><h3 class="card-title">
        <i class="bi bi-archive me-2"></i>Download a backup</h3></div>
      <div class="card-body">
      <p class="small text-secondary">Everything in the data folder: accounts, characters,
        world state, settings and logs.</p>
      <div class="vt-field-danger mb-3"><strong>Careful:</strong> the archive contains password
        hashes and any credentials you have configured. Treat it like a password, store it
        somewhere private, and do not post it when asking for help.</div>
      <a class="btn btn-outline-secondary" href="/admin/api/export" id="mExport">
        <i class="bi bi-download me-1"></i>Download backup</a>
    </div></div></div>
    </div>

    <div class="row"><div class="col-12 col-xl-6">
    <div class="card card-secondary card-outline">
      <div class="card-header"><h3 class="card-title">
        <i class="bi bi-cloud-download me-2"></i>Updates</h3></div>
      <div class="card-body">
      <p class="small text-secondary">You are running
        <span class="vt-mono">v${state.version || '?'}</span>. Checking asks GitHub for the
        newest release; nothing happens automatically.</p>
      <button class="btn btn-outline-secondary" id="mUpdates">Check for updates</button>
      <div id="mUpdatesOut" class="mt-2 small"></div>
    </div></div></div></div>`;

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
  $('#mUpdates').onclick = async () => {
    const out = $('#mUpdatesOut');
    out.innerHTML = html`<span class="spinner-border spinner-border-sm me-1"></span> Asking GitHub…`;
    try {
      const r = await api('/updates');
      if (!r.ok) {
        out.innerHTML = html`<div class="text-secondary">Could not check: ${r.reason}</div>`;
      } else if (r.behind) {
        out.innerHTML = html`<div class="vt-section-note">
          <strong>v${r.latest} is out</strong> (you run v${r.current}).
          To update, run the setup script again on the machine hosting this:
          <pre class="vt-mono small mb-1 mt-2">./setup.sh --update</pre>
          (or <span class="vt-mono">setup.ps1 -Update</span> on Windows). It pulls the new
          version and restarts; your data and settings stay.
          ${raw(r.url ? html`<div class="mt-1"><a href="${r.url}" target="_blank" rel="noreferrer noopener">What changed</a></div>` : '')}
        </div>`;
      } else {
        out.innerHTML = html`<div class="text-success">
          <i class="bi bi-check-circle me-1"></i>You are on the newest release.</div>`;
      }
    } catch (e) { out.textContent = e.message; }
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
    a.download = `openmw-web-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
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
      <div class="callout callout-danger">
        <h5><i class="bi bi-exclamation-octagon me-1"></i> This server cannot host players yet</h5>
        <ul class="mb-2">${raw(blockers.map((b) => html`<li>${b}</li>`).join(''))}</ul>
        <p class="mb-0 small">The dashboard works and your settings are safe. Fix the above,
          then <a href="#maintenance">restart</a>.</p>
      </div>` : '')}

    <div class="row">
      <div class="col-lg-7">
        <div class="card card-primary card-outline mb-3"><div class="card-header"><h3 class="card-title"><i class="bi bi-people me-2"></i>Getting players in</h3></div><div class="card-body">
          <dl class="small mb-0">
            ${raw(faq('Nobody can connect from outside my network',
              'Two things have to be true. Your router must forward ports 80 and 443 to this ' +
              'machine, and the server must have been set up for internet hosting rather than ' +
              'local-network-only, change that under <a href="#settings">Settings &rarr; Deployment</a>.'))}
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

        <div class="card card-warning card-outline mb-3"><div class="card-header"><h3 class="card-title"><i class="bi bi-wrench-adjustable me-2"></i>When something is wrong</h3></div><div class="card-body">
          <dl class="small mb-0">
            ${raw(faq('My browser says the connection is not private',
              'Expected when you have no domain name: the certificate is one this server signed ' +
              'itself, so nothing independent vouches for it. The connection is still encrypted. ' +
              'Point a domain at this machine, then set it under <a href="#settings">Settings ' +
              '&rarr; Deployment</a> &mdash; ' +
              'a real certificate is fetched automatically, with nothing to edit or restart.'))}
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
            ${raw(faq('I am locked out, forgotten password, no email set up',
              'On the machine running the server:<br>' +
              '<code>docker compose run --rm openmw-web node dist/server.mjs --data /data --admin-reset &lt;name&gt;</code>' +
              '<br>That clears the password and two-factor on that account and prints a temporary ' +
              'password. Requires shell access to the box, which is the point.'))}
            ${raw(faq('Where are the logs?',
              'Recent activity is on the <a href="#logs">Logs</a> page. A longer history survives ' +
              'restarts and crashes in <code>logs/server.log</code> inside your data folder, and ' +
              '<code>docker compose logs openmw-web</code> shows the container\'s own output.'))}
          </dl>
        </div></div>
      </div>

      <div class="col-lg-5">
        <div class="card card-secondary card-outline mb-3"><div class="card-header"><h3 class="card-title"><i class="bi bi-person-badge me-2"></i>Who can do what</h3></div><div class="card-body">
          <dl class="small mb-0">
            <dt>Owner</dt><dd class="text-secondary">Everything: settings, mods, accounts,
              restart, backups, and running script on a player's machine.</dd>
            <dt>Moderator</dt><dd class="text-secondary">Kick, ban, mute, broadcast, read chat
              history and logs. Cannot change configuration or grant access.</dd>
            <dt>Viewer</dt><dd class="text-secondary">Read-only.</dd>
          </dl>
        </div></div>

        <div class="card card-secondary card-outline mb-3"><div class="card-header"><h3 class="card-title"><i class="bi bi-file-earmark-text me-2"></i>Where your settings live</h3></div><div class="card-body">
          <p class="small text-secondary mb-2">Changes made here are written to
            <code>config.dashboard.toml</code> in your data folder. If you also keep a
            <code>config.toml</code> by hand, this dashboard never touches it, yours is
            layered underneath, so your comments and values survive.</p>
          <p class="small text-secondary mb-0">The last few versions are kept alongside it. If a
            saved setting ever stops the server loading, it falls back to the newest one that
            works rather than refusing to start.</p>
        </div></div>

        <div class="card card-secondary card-outline"><div class="card-header"><h3 class="card-title"><i class="bi bi-life-preserver me-2"></i>More</h3></div><div class="card-body">
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
            both MIT licensed and served from this server rather than a CDN, so this page
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

  // An SSO round trip lands back here as /admin#t=<session token> (a fragment, so it is
  // never sent to a server or written to a log). Consume it and clear the address bar.
  const sso = /^#t=(.+)$/.exec(hash);
  if (sso) {
    token.set(decodeURIComponent(sso[1]));
    history.replaceState(null, '', location.pathname);
    await refreshState();
    return go('#overview');
  }
  if (hash.startsWith('#ssoerr=')) {
    history.replaceState(null, '', location.pathname);
    return pageLogin(false, 'That sign-in worked, but the account has no dashboard access. '
      + 'An owner can grant it from the Accounts page.');
  }

  // SETUP IS A DOOR, NOT A SUGGESTION.
  //
  // Creating the owner account used to end first-run on its own, which dropped you into a
  // full dashboard with every later question unanswered and every nav link live. A
  // non-technical operator can wander off mid-setup that way and end up running a half
  // configured server with nothing telling them so. The wizard now holds the whole page
  // until it is finished: no nav, no other route reachable, and the only way past is to
  // answer the questions (or deliberately skip the ones that are genuinely optional).
  //
  // Re-running setup later from the nav is a different thing, and that path stays free to
  // come and go: `setupCompleted` is already true by then.
  const inSetup = state.firstRun || (state.authed && state.setupCompleted !== true);
  if (inSetup) {
    // Keep a restored position rather than resetting: this runs on every load, so
    // overwriting `step` here is what made the saved progress unreachable. Only clamp to the
    // bounds the current auth state allows, step 0 is the create-account screen, which is
    // pointless once an account exists.
    if (!state.authed) step = 0;
    else if (step < 1) step = 1;
    seedFromServer();
    return renderWizard();
  }
  if (!state.authed) return pageLogin();

  // Hiding a nav link is not the same as closing the page: the hash still works when typed,
  // bookmarked, or followed from an older link. Send it home rather than rendering a console
  // whose every button would act on a world nobody is connected to.
  if (singlePlayer() && NAV.some((g) => g.items.some((i) => i.hash === hash && i.solo === false))) {
    return go('#overview');
  }

  const need = NEEDS[hash];
  if (need && !can(need)) {
    setTitle('Not available', '');
    view().innerHTML = html`<div class="alert alert-secondary">Your role
      (<strong>${state.role}</strong>) cannot open this page. Ask an owner if you need it.</div>`;
    return;
  }
  // AFTER the role check, not before. Reachable by hash, so a viewer who typed or followed
  // a link to it used to answer every question and then get a bare "forbidden" toast at the
  // final save, and the file-upload panel on the way through failed on every drop.
  // Only while setup is genuinely unfinished, which the gate above already handles. Reaching
  // this line means it IS finished, so the hash is closed rather than reopening eleven
  // questions on a configured server.
  if (hash === '#setup') return go('#overview');

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
