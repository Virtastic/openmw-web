// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The single-player dashboard, and the two things it needed that did not exist.
//
// "In the world" counted the WS roster, which is right for multiplayer and structurally
// always zero for single player: the browser runs the engine and never joins anything. So an
// operator playing their own server was shown 0 players while playing. And the machine's own
// health had no reading at all, on the page that exists to say what the server is doing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LockerSessionStore } from '../src/auth/identities';
import { createSysInfo } from '../src/net/admin/sysinfo';
import {
  applySection, DERIVED_FIELDS, MULTIPLAYER_ONLY, SECTION_GROUPS, SOLO_KEEP_FIELDS, settingsView,
} from '../src/net/admin/api-settings';
import { helpFor } from '../src/net/admin/help';
import { readDashboardTree } from '../src/net/admin/settings-store';

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8');

// --- who is playing ------------------------------------------------------------------------

test('using the locker marks the account as playing', () => {
  const s = new LockerSessionStore();
  const token = s.mint('michael');
  assert.deepEqual(s.activeSince(60_000), [], 'minting a token is not playing');
  assert.equal(s.resolve(token), 'michael');
  assert.deepEqual(s.activeSince(60_000).map((a) => a.account), ['michael']);
});

test('activity ages out, so a closed tab stops counting', () => {
  // The whole point of a liveness signal over a session: a 24h token must not mean 24h of
  // being shown as in-game.
  const s = new LockerSessionStore();
  s.resolve(s.mint('michael'));
  assert.equal(s.activeSince(60_000).length, 1);
  assert.equal(s.activeSince(0).length, 0, 'a zero window can match nothing');
});

test('a bad token marks nobody', () => {
  const s = new LockerSessionStore();
  assert.equal(s.resolve('not-a-token'), undefined);
  assert.deepEqual(s.activeSince(60_000), []);
});

test('several accounts are listed most recently active first', async () => {
  const s = new LockerSessionStore();
  const a = s.mint('alice');
  const b = s.mint('bob');
  s.resolve(a);
  await new Promise((r) => setTimeout(r, 5));
  s.resolve(b);
  assert.deepEqual(s.activeSince(60_000).map((x) => x.account), ['bob', 'alice']);
});

// --- machine health ------------------------------------------------------------------------

test('system readings are real numbers, and rates need two samples', async () => {
  const read = createSysInfo(process.cwd());
  const first = await read();

  // Memory and core count are absolute readings, available immediately.
  assert.ok(first.memory.totalBytes > 0, 'no memory total');
  assert.ok(first.memory.usedBytes > 0 && first.memory.usedBytes <= first.memory.totalBytes);
  assert.ok(first.memory.percent >= 0 && first.memory.percent <= 100);
  assert.ok(first.cpu.cores > 0);

  // CPU is a counter difference, so the FIRST call has nothing to difference against and must
  // say so rather than reporting a made-up 0%.
  assert.equal(first.cpu.percent, null, 'first sample cannot know a rate');

  const second = await read();
  assert.ok(second.cpu.percent === null || (second.cpu.percent >= 0 && second.cpu.percent <= 100));

  // The data directory always exists here, so disk must resolve.
  assert.ok(second.disk, 'no disk reading for a path that exists');
  assert.ok(second.disk!.totalBytes > 0 && second.disk!.freeBytes >= 0);
});

// --- the page ------------------------------------------------------------------------------

test('the single-player dashboard drops the multiplayer furniture', () => {
  const solo = /if \(solo\) \{[\s\S]*?\n    return;\n  \}/.exec(app);
  assert.ok(solo, 'no single-player branch on the overview');
  assert.doesNotMatch(solo[0], /setupChecklist\(\)/, 'the getting-started widget must be gone');
  assert.doesNotMatch(solo[0], /'World'/, 'the world card names an id nobody chose');
  assert.doesNotMatch(solo[0], /maxPlayers/, 'a player cap is meaningless here');
  // And keeps what a solo operator actually wants.
  assert.match(solo[0], /Playing now/);
  assert.match(solo[0], /sysCards\(o\.system\)/);
});

test('multiplayer keeps its own dashboard', () => {
  // The fix must not be "delete the multiplayer view".
  assert.match(app, /stat\(`Players \(of \$\{o\.maxPlayers\}\)`/);
  assert.match(app, /stat\('World', o\.world\.id/);
});

// --- settings that need a world, or a second person ------------------------------------------

test('the sections a lone player cannot use are named', () => {
  // Each of these is read by the server's own world simulation, by a join handshake, or by
  // there being somebody else. None of the three happens in single player.
  for (const s of ['rules', 'economy', 'time', 'gui', 'cellReset', 'sharing', 'moderation',
    'authority', 'content', 'engine', 'simPeer', 'gateway', 'worlds']) {
    assert.ok(MULTIPLAYER_ONLY.includes(s), `${s} should be hidden in single player`);
  }
});

test('sections that still do part of their job are NOT hidden', () => {
  // The cut is "does nothing here", not "sounds multiplayer-ish". [admin] holds the
  // dashboard's own owners and token, [limits] still rate-limits sign-in, [locker] is how the
  // one player gets their files, [login]/[auth] are how they sign in.
  for (const s of ['server', 'login', 'auth', 'admin', 'limits', 'locker', 'metrics',
    'notifications', 'integrations', 'dev']) {
    assert.ok(!MULTIPLAYER_ONLY.includes(s), `${s} still matters in single player`);
  }
});

test('every hidden name is a real section, not a typo', () => {
  // A misspelling here hides nothing and is invisible: the page just keeps showing it.
  const known = new Set([...SECTION_GROUPS.flatMap((g) => g.sections), 'engine']);
  assert.deepEqual(MULTIPLAYER_ONLY.filter((s) => !known.has(s)), []);
});

// --- fields the operator is not asked for ----------------------------------------------------

test('publicBase is never offered, in either mode', () => {
  // The wizard already asked for the domain, generated the proxy config from it and got a
  // certificate for it. Asking again under another name is a second chance to get it wrong,
  // and every wrong answer is silent.
  for (const mode of ['single', 'multiplayer']) {
    const v = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
      setup: { deploymentMode: mode }, locker: { publicBase: '', maxBytesPerAccount: 1 },
    });
    const locker = v.sections.find((s) => s.name === 'locker')!;
    assert.deepEqual(locker.fields.filter((f) => f.key === 'publicBase'), [], `shown in ${mode}`);
    assert.ok(locker.fields.some((f) => f.key === 'maxBytesPerAccount'), 'the section still renders');
  }
});

test('the shared admin token is offered in multiplayer and not in single player', () => {
  const build = (deploymentMode: string) => settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    setup: { deploymentMode }, admin: { dashboardToken: '', allowConsole: false },
  }).sections.find((s) => s.name === 'admin')!;

  assert.ok(build('multiplayer').fields.some((f) => f.key === 'dashboardToken'));
  const solo = build('single');
  assert.deepEqual(solo.fields.filter((f) => f.key === 'dashboardToken'), []);
  // The rest of [admin] still matters here, so the section must survive.
  assert.ok(solo.fields.some((f) => f.key === 'allowConsole'));
});

test('a nested table is a form, not also an "unsupported" row above it', () => {
  // [auth.discord] became its own editable section AND a flat field on the parent, so the
  // parent said "structured data a simple form cannot edit" directly above the form editing it.
  const v = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    setup: {}, auth: { allowPasswordLogin: true, discord: { enabled: false, clientId: '' } },
  });
  const auth = v.sections.find((s) => s.name === 'auth')!;
  assert.deepEqual(auth.fields.filter((f) => f.key === 'discord'), [], 'no blob row on the parent');
  assert.ok(auth.fields.some((f) => f.key === 'allowPasswordLogin'), 'flat fields still render');
  assert.ok(v.sections.find((s) => s.name === 'auth.discord'), 'and the real form is still there');
});

test('no settings field claims the shared token grants owner rights', () => {
  // It resolves to moderator (net/admin/auth.ts). The help said owner, which overstated a
  // risk the operator cannot check, on the one field where being believed matters.
  //
  // Asserted against the delivered strings, not the source: a first version scanned the file
  // and failed on a comment quoting the wording it was there to remove.
  const h = helpFor('admin', 'dashboardToken')!;
  const said = `${h.text ?? ''} ${h.danger ?? ''}`;
  assert.doesNotMatch(said, /owner rights|full-access|full owner/);
  assert.match(said, /moderator/);
});

// --- the wizard is first-run only, so its live answers moved to Settings ---------------------

test('the deployment answers that are read at runtime are editable', () => {
  // Closing the wizard left the domain editable by nothing, while Help still said to go and
  // change it there. These five are read at runtime: proxy config, boot mode, whether the
  // server publishes its files, and what the data checklist expects.
  const v = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    setup: {
      domain: '', hosting: 'internal', httpPort: 80, deploymentMode: 'single',
      deliveryModel: 'serve', contentProfile: 'expansions',
      storage: 'local', loginMethods: ['password'], registration: 'open', completed: true,
    },
  });
  const setup = v.sections.find((s) => s.name === 'setup');
  assert.ok(setup, '[setup] must render as a section');
  const keys = setup.fields.map((f) => f.key).sort();
  assert.deepEqual(keys,
    ['contentProfile', 'deliveryModel', 'deploymentMode', 'domain', 'hosting', 'httpPort']);
});

test('the answers that are only a RECORD are not offered', () => {
  // storage/loginMethods/registration had their effect written into [locker], [auth] and
  // [login] at the time. Editing the record would change nothing while looking like it had.
  for (const f of ['setup.storage', 'setup.loginMethods', 'setup.registration']) {
    assert.ok(DERIVED_FIELDS.includes(f), `${f} must not be editable`);
  }
  // And clearing this one reopens first-run over a configured server.
  assert.ok(DERIVED_FIELDS.includes('setup.completed'));
});

test('a pasted URL is normalised into a bare hostname on save', () => {
  // People paste out of the address bar. A scheme reaching the proxy config makes the site
  // address https://https://mp.example.com.
  const dir = mkdtempSync(join(tmpdir(), 'set-'));
  assert.deepEqual(applySection(dir, 'setup', { domain: 'https://MP.Example.com/' }), { ok: true });
  // Read what was STORED. settingsView reports the config object it is handed, so asking it
  // would only echo the unnormalised value back and prove nothing.
  const stored = readDashboardTree(dir) as { setup?: { domain?: string } };
  assert.equal(stored.setup?.domain, 'mp.example.com');
});

test('nothing user-facing still links to the closed wizard hash', () => {
  // Two Help entries told the operator to "re-run Setup", which now bounces to Overview.
  assert.doesNotMatch(app, /href="#setup"/);
});

test('the list ships with the settings payload', () => {
  const view = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    server: { name: 'x' }, rules: { pvp: true },
  });
  assert.deepEqual(view.multiplayerOnly, MULTIPLAYER_ONLY);
});

test('the page filters by it and drops groups left empty', () => {
  // "Platform (advanced)" is simPeer/gateway/worlds and nothing else, so in single player it
  // must go entirely rather than remain as a heading that opens onto nothing.
  assert.match(app, /const hide = singlePlayer\(\) \? new Set\(settingsCache\.multiplayerOnly \|\| \[\]\) : new Set\(\);/);
  assert.match(app, /\.filter\(\(g\) => g\.sections\.length\)/);
  const platform = SECTION_GROUPS.find((g) => g.group.startsWith('Platform'))!;
  assert.deepEqual(platform.sections.filter((s) => !MULTIPLAYER_ONLY.includes(s)), [],
    'the whole Platform group must be hidden, or the group survives with a gap in it');
});

// --- pages that cannot work in a one-person deployment ---------------------------------------

test('Players & commands is marked unavailable in single player', () => {
  // Every control on it acts on a player connected to a world. In single player the browser
  // runs the engine and never connects, so there is nobody to broadcast to or hand an item.
  assert.match(app, /hash: '#console'[^}]*solo: false/);
});

test('the sidebar filters those pages out', () => {
  assert.match(app, /i\.solo === false && singlePlayer\(\)/);
});

test('and the hash is closed too, not merely unlinked', () => {
  // A hidden link is still a working URL when typed, bookmarked, or followed from an older
  // link, which would land on a console whose every button acts on an empty world.
  const guard = /if \(singlePlayer\(\) && NAV\.some[\s\S]*?\n  \}/.exec(app);
  assert.ok(guard, 'no route guard for solo-hidden pages');
  assert.match(guard[0], /go\('#overview'\)/);
});

test('multiplayer still reaches the console', () => {
  assert.match(app, /'#console': pageConsole/);
});

// --- the row of cards ----------------------------------------------------------------------

const css = readFileSync(join(process.cwd(), 'web', 'app.css'), 'utf8');

test('stat cards fill their column, so a row of them cannot go ragged', () => {
  // Only some cards carry a second line. The columns always stretched to the tallest; the
  // boxes inside them did not, so the shorter cards floated with a gap beneath.
  assert.match(css, /\.row > \[class\*="col-"\] > \.small-box \{[^}]*height: 100%/);
  assert.match(css, /\.small-box > \.small-box-footer \{ margin-top: auto; \}/);
});

test('the margin is on the column, not on a box that now fills it', () => {
  // A margin on a height:100% box overflows its column and brings the ragged row back.
  assert.doesNotMatch(app, /<div class="small-box text-bg-\$\{raw\(tone\)\} mb-3">/);
  // Three across, not four: with five or six cards a four-wide row strands one on its own.
  // The class list is asserted loosely so a breakpoint tweak is not a test failure.
  assert.match(app, /<div class="col-\d+(?: col-\w+-\d+)* mb-3">/);
  assert.match(app, /col-lg-4 mb-3/, 'stat cards should be three across at desktop width');
});

test('every text-bg-* tone is neutralised, not a hand-kept list of four', () => {
  // The list did not cover text-bg-info, so the first card to use it returned in Bootstrap
  // cyan on a palette built to keep exactly that out.
  assert.match(css, /\.small-box\[class\*="text-bg-"\] \{/);
});

test('an unavailable reading is omitted, never drawn as a confident zero', () => {
  const cards = /function sysCards\(sys\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(cards);
  assert.match(cards[0], /if \(!sys\) return '';/);
  assert.match(cards[0], /sys\.cpu\.percent !== null/);
  assert.match(cards[0], /if \(sys\.disk\)/);
  assert.match(cards[0], /if \(sys\.network\)/);
});

// --- the mod manager page ---------------------------------------------------------------------

test('the mods card is a separate list from the base game load order', () => {
  // Mixing them would put a Remove button next to Morrowind.esm. One is files an operator
  // dropped in; the other is packages that were installed and can be uninstalled.
  assert.match(app, /function modsCard\(m, editable\)/);
  assert.match(app, /id="modList"/);
  assert.match(app, /id="modBody"/, 'the base-game table must still be there');
});

test('the upload asks before installing anything', () => {
  // The whole point: an archive with a core folder and optional extras must not install both.
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(wire, 'no wireMods');
  assert.match(app, /mods\/install\?name=/);
  assert.match(wire[0], /renderChooser/);
  assert.match(wire[0], /mods\/install\/commit/);
  // And commit must be reachable only from the chooser, never straight from the upload. The
  // staged answer now arrives as a resolved promise rather than a callback, which is the same
  // ordering said differently: nothing may call commit with what uploadArchive returned until
  // the chooser has rendered it and the operator has ticked something.
  assert.ok(wire[0].indexOf('renderChooser(await uploadArchive(file, stage))')
    < wire[0].indexOf("api('/mods/install/commit'"));
});

test('an unsupported archive is refused in the browser, before the bytes are sent', () => {
  // Telling somebody their .rar is unsupported after a 400 MB upload is the wrong moment. The
  // server sniffs the real format regardless; this only saves a wasted transfer.
  const u = /function uploadArchive\(file, stage\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(u[0], /\(zip\|7z\)\$\/i\.test\(file\.name\)/,
    'both formats Nexus actually serves must be accepted');
  assert.ok(u[0].indexOf('(zip|7z)$/i.test(file.name)') < u[0].indexOf('mods/install?name='));
});

test('removing a mod is type-to-confirm, like every other delete here', () => {
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(wire[0], /typeToConfirm: slug/);
});

test('the zip is sent raw rather than being buffered into a form', () => {
  // A multipart parser for a several-hundred-megabyte archive is a dependency and a memory
  // problem; the Data Files upload already settled this. The transport moved from fetch to
  // XHR for upload progress, but the body is still the File itself, not a FormData.
  const u = /function uploadArchive\(file, stage\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(u[0], /xhr\.send\(file\);/);
  assert.match(u[0], /application\/octet-stream/);
  assert.doesNotMatch(u[0], /FormData/);
});

test('filenames out of an uploaded zip are escaped, not injected', () => {
  // The candidate list renders plugin and archive names straight out of a stranger's archive.
  // They were joined into a string and passed through raw(), so a file named with markup went
  // into the owner's dashboard as markup. The page's CSP (script-src 'self', no unsafe-inline)
  // stops it executing, which makes it an injection rather than a takeover — not a reason to
  // leave it.
  const chooser = /const renderChooser = \(staged\) => \{[\s\S]*?\n  \};/.exec(app);
  assert.ok(chooser, 'renderChooser not found');
  assert.doesNotMatch(chooser[0], /raw\(\[\s*\n\s*c\.plugins\.length \? `/,
    'zip filenames must not be interpolated into a plain template inside raw()');
  // They must go through the escaping template instead.
  assert.match(chooser[0], /html`\$\{c\.plugins\.length === 1/);
});

test('[limits] keeps only the two knobs that still do anything in single player', () => {
  // Twenty-one of its twenty-three budget a CONNECTED player: messages per second, movement
  // updates, actor streams, buffered bytes, connections per address, interest radius, the LOD
  // ladder. None of that exists when the browser runs the engine and nobody connects.
  const limits = {
    msgsPerSec: 60, moveMsgsPerSec: 40, bytesPerSec: 1, maxConnsPerIp: 3, interestRadius: 1,
    lodNearHz: 1, renderLod: true, loginPerMinPerIp: 10, trustCloudflareIp: false,
  };
  const solo = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    setup: { deploymentMode: 'single' }, limits,
  }).sections.find((s) => s.name === 'limits')!;
  assert.deepEqual(solo.fields.map((f) => f.key).sort(), ['loginPerMinPerIp', 'trustCloudflareIp']);

  // Multiplayer still gets all of them: this is a view, not a deletion.
  const mp = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    setup: { deploymentMode: 'multiplayer' }, limits,
  }).sections.find((s) => s.name === 'limits')!;
  assert.equal(mp.fields.length, Object.keys(limits).length);
});

test('every name in the solo keep-list is a real field', () => {
  // A typo here would hide the field it was meant to keep, silently.
  const all = settingsView(mkdtempSync(join(tmpdir(), 'set-')), {
    setup: { deploymentMode: 'multiplayer' },
    limits: { loginPerMinPerIp: 1, trustCloudflareIp: false, msgsPerSec: 1 },
  }).sections.find((s) => s.name === 'limits')!;
  const known = new Set(all.fields.map((f) => f.key));
  assert.deepEqual(SOLO_KEEP_FIELDS.limits!.filter((k) => !known.has(k)), []);
});

// --- the pages the sidebar actually offers ------------------------------------------------------

test('the mod manager manages mods, and nothing else', () => {
  // It used to carry Morrowind too: a game-data uploader, a load order of the base game and its
  // expansions, and the mods underneath. Which EDITION this server runs is a setup question
  // answered in the wizard; installing and ordering mods is a thing done over and over.
  const page = /async function pageMods\(\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(page, 'pageMods not found');
  assert.match(page[0], /modsCard\(m, editable\)/);
  assert.doesNotMatch(page[0], /uploadPanel\(/, 'the game-data uploader belongs to Game files');
  assert.doesNotMatch(page[0], /modBody/, 'the base-game load order belongs to Game files');
  // And the base game still has somewhere to live.
  assert.match(app, /async function pageGameFiles\(\)/);
  assert.match(app, /hash: '#gamefiles'/);
});

test('each settings group is its own sidebar entry', () => {
  // The groups already existed and were already meaningful; they were just not navigable, so
  // the structure only appeared after clicking into Settings and then opening a row.
  for (const [hash, group] of [['#set-core', 'Core'], ['#set-access', 'Access'],
    ['#set-storage', 'Storage'], ['#set-operations', 'Operations']]) {
    assert.match(app, new RegExp(`hash: '${hash}', label: '${group}'`), `${group} is not in the nav`);
    // A plain substring rather than a built regex: escaping parens through a template
    // literal is exactly the kind of thing that fails the test instead of the code.
    assert.ok(app.includes(`'${hash}': () => pageSettings('${group}')`),
      `${hash} does not route to the ${group} group`);
  }
  // The old all-groups page still answers, so a bookmarked #settings does not 404.
  assert.ok(app.includes("'#settings': () => pageSettings()"));
});

test('the danger zone is four pages, not one', () => {
  // They share only "not configuration", which is not enough to make them one screen — and as
  // one screen the sidebar named one of the four and hid the other three behind it.
  for (const [hash, fn] of [['#updates', 'pageUpdates'], ['#maintenance', 'pageMaintenance'],
    ['#backup', 'pageBackup'], ['#restart', 'pageRestart']]) {
    assert.match(app, new RegExp(`hash: '${hash}'`), `${hash} is not in the nav`);
    assert.match(app, new RegExp(`'${hash}': ${fn}`), `${hash} has no route`);
    assert.match(app, new RegExp(`async function ${fn}\(\)`), `${fn} does not exist`);
  }
});

test('every page in the sidebar has a route and a role', () => {
  // A nav entry with no route renders the overview instead, silently; one with no role entry is
  // reachable by anyone who can see the page at all.
  const navs = [...app.matchAll(/\{ hash: '(#[a-z-]+)'/g)].map((m) => m[1]!);
  const routes = new Set([...app.matchAll(/^ {2}'(#[a-z-]+)': /gm)].map((m) => m[1]!));
  const needs = /const NEEDS = \{[\s\S]*?\n\};/.exec(app)![0];
  assert.deepEqual(navs.filter((h) => !routes.has(h)), [], 'nav entries with no route');
  assert.deepEqual(navs.filter((h) => !needs.includes(`'${h}'`)), [], 'nav entries with no role');
});

// --- installing a mod has to look like it is happening -------------------------------------------
//
// The transport lives in uploadArchive, shared with the wizard's Tamriel Rebuilt step: the two
// screens are the same three waits with a different question on the far side of them, and one
// copy means one place the session-expiry and dropped-connection cases are handled.

const uploader = () => /function uploadArchive\(file, stage\) \{[\s\S]*?\n\}/.exec(app)!;

test('the upload reports progress, which fetch cannot do', () => {
  // Installing is three waits with nothing between them: the bytes go up, the server opens the
  // archive, the chosen folders unpack. One "Reading…" line covered all of it, so a 400MB mod
  // looked frozen for minutes and the honest reaction was to click again.
  assert.match(uploader()[0], /new XMLHttpRequest\(\)/,
    'fetch has no upload-progress event, so the one knowable wait would have no bar');
  assert.match(uploader()[0], /xhr\.upload\.onprogress/);
  assert.match(uploader()[0], /installPhase\(stage, 'Uploading'/);
});

test('each wait says which one it is', () => {
  // The first two belong to the transport; the third is the extraction, which only the caller
  // knows it has asked for.
  for (const p of ["installPhase(stage, 'Uploading'", "installPhase(stage, 'Opening the archive'"]) {
    assert.ok(uploader()[0].includes(p), `missing phase: ${p}`);
  }
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.ok(wire[0].includes("installPhase(stage, 'Installing'"), 'missing phase: Installing');
});

test('a dropped connection or an expired session says so, rather than hanging', () => {
  // An upload long enough to need a progress bar is long enough to outlive a session or a
  // server restart, and XHR reports those as an error event rather than a rejected promise.
  assert.match(uploader()[0], /xhr\.onerror = \(\) => \{/);
  assert.match(uploader()[0], /Your session ended during the/);
  const onerror = /xhr\.onerror = \(\) => \{[\s\S]*?\};/.exec(uploader()[0])!;
  assert.match(onerror[0], /uploadRunning = false;/,
    'the run flag must be cleared on failure or the next upload is refused forever');
});

test('every way out of the upload clears the run flag', () => {
  // One flag guards the whole page, so a path that returns without clearing it refuses every
  // later upload until a reload. Now that the transport is shared, that would take the wizard
  // down with the mods page.
  const u = uploader()[0];
  assert.equal(u.split('uploadRunning = true;').length - 1, 1);
  assert.equal(u.split('uploadRunning = false;').length - 1, 3,
    'onload, onerror and onabort must each clear it');
});

test('the install step replaces the form instead of just disabling a button', () => {
  // A disabled button beside an unchanged form reads as a page that has died, and the
  // reasonable response to that is to reload — which abandons a staged upload that was fine.
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(wire[0], /installPhase\(stage, 'Installing', `unpacking \$\{files\}/);
  assert.doesNotMatch(wire[0], /\$\('#modGo'\)\.disabled = true;/);
});

// --- the mod list is rows, not a wall of text ------------------------------------------------
//
// Conflict sentences, the raw Nexus filename, the slug, and the plugin list all rendered
// inline, so three mods filled a screen. The row now carries a readable name, the counts, and
// compact badges; everything that explains itself in sentences moved to a per-mod modal behind
// a Details button.

test('every mod row has a Details button opening its modal', () => {
  const card = /const card = \(mod, i\) => \{[\s\S]*?\n  \};/.exec(app)!;
  assert.match(card[0], /data-bs-toggle="modal"/);
  assert.match(card[0], /data-bs-target="#modd-\$\{mod\.slug\}"/);
  assert.match(card[0], /class="modal fade" id="modd-\$\{mod\.slug\}"/);
});

const prettyFn = () => /const pretty = \(name\) => \{[\s\S]*?\n\};/.exec(app)![0];

test('the row shows a readable name, not the raw Nexus filename', () => {
  // "Cool Mod-45384-1-18-0-1751572864.7z" is a download artifact, not a name. The tail of
  // digits and the extension are stripped for display; the stored name is untouched and the
  // modal still shows it in full.
  const fn = prettyFn();
  // Plain includes: the target IS a regex literal, and matching a regex with a regex is how
  // this suite has burnt itself before.
  assert.ok(fn.includes(String.raw`replace(/\.(zip|7z|rar)$/i, '')`), 'extension strip missing');
  assert.ok(fn.includes(String.raw`replace(/(-\d+)+$/, '')`), 'digit-tail strip missing');
});

test('a name and the folder it came from are joined by a colon, old or new', () => {
  // The separator used to be an em dash, which reads as a pause in a sentence rather than a
  // label. Names already in modlist.json keep theirs — rewriting saved names over punctuation
  // is not worth doing — so the display has to render both and write one.
  const fn = prettyFn();
  assert.ok(fn.includes(String.raw`split(/ — |: /)`),
    'both separators must be split, or a mod installed before the change loses its strip');
  assert.ok(fn.includes('join(NAME_SEP)'));
  assert.ok(app.includes("const NAME_SEP = ': ';"));
  // And nothing writes the old one any more.
  assert.doesNotMatch(app, /` — \$\{c\.path\}`/);
});

const paintFn = () => /function paintConflicts\(list, m\) \{[\s\S]*?\n\}/.exec(app)![0];

test('conflicts are badges on the row and sentences only in the modal', () => {
  const paint = paintFn();
  assert.match(paint, /badge text-bg-warning">replaces \$\{winCount\}/);
  assert.match(paint, /badge text-bg-secondary">\$\{loseCount\} overridden/);
  // The explanation lives under the modal's own heading, not loose in the row.
  assert.match(paint, /Overlapping files/);
  // The order-independent one stays baked into the card, where it belongs.
  const card = /const card = \(mod, i\) => \{[\s\S]*?\n  \};/.exec(app)!;
  assert.match(card[0], /badge text-bg-danger">missing master/);
});

test('who overrides whom is decided by the order on screen, not the one the server sent', () => {
  // THE REPORTED BUG. The badges and the overlap sentences are the answer to "whose copy of
  // this file does the game use", which IS the list order — so dragging a mod left every one
  // of them describing an arrangement that no longer existed, until a save reloaded the page.
  // Reordering is the one action taken because of what they say, so stale is worse here than
  // anywhere else on the page.
  const paint = paintFn();
  // Direction comes from the row positions, not from the server's winner/loser fields.
  assert.match(paint, /const rank = new Map\(rows\.map\(\(el, i\) => \[el\.dataset\.slug, i\]\)\)/);
  assert.ok(paint.includes('const [winner, loser] = x > y ? [c.winner, c.loser] : [c.loser, c.winner];'),
    'the pair must be re-decided, not taken as given');
  // A mod switched off contests nothing.
  assert.ok(paint.includes('if (!on.has(c.winner) || !on.has(c.loser)) continue;'));
});

// RUN, not read. The two tests above pin the shape of paintConflicts; this one executes the
// source that actually ships against a stub of the few DOM calls it makes, drags a mod, and
// checks the badges turned around. Nothing else in this suite can catch a direction that is
// backwards, and backwards is the failure mode a reader is least likely to spot.

/** The minimum of a card element: a slug, a switch, and two containers it writes into. */
function fakeRow(slug: string, checked = true) {
  const store: Record<string, string> = {};
  return {
    dataset: { slug },
    querySelector: (sel: string) => (sel === '[data-modon]' ? { checked } : {
      set innerHTML(v: string) { store[sel] = v; },
      get innerHTML() { return store[sel] ?? ''; },
    }),
    html: (sel: string) => store[sel] ?? '',
  };
}

function runPaint(rows: ReturnType<typeof fakeRow>[], m: unknown) {
  const src = paintFn();
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]) =>
    strings.reduce((a, s2, i) => a + s2 + (i < vals.length ? String(vals[i]) : ''), '');
  const make = new Function('html', 'raw', 'pretty', `${src}; return paintConflicts;`) as
    (h: unknown, r: unknown, p: unknown) => (list: unknown, m: unknown) => void;
  make(tag, (v: unknown) => v, (n: unknown) => n)({ querySelectorAll: () => rows }, m);
}

test('dragging a mod turns the badges around, there and then', () => {
  const a = fakeRow('a');
  const b = fakeRow('b');
  // The server saw a before b, so b won. That is the only thing it can tell us.
  const m = { mods: [{ slug: 'a', name: 'Alpha' }, { slug: 'b', name: 'Beta' }],
    conflicts: [{ winner: 'b', loser: 'a', files: 5, sample: [] }] };

  runPaint([a, b], m);
  assert.match(b.html('[data-badges]'), /replaces 5/);
  assert.match(a.html('[data-badges]'), /5 overridden/);
  assert.match(a.html('[data-ordernotes]'), /overridden by\s+<strong>Beta<\/strong>/);

  // Now drag a below b, which is what the page does to its own DOM before repainting.
  runPaint([b, a], m);
  assert.match(a.html('[data-badges]'), /replaces 5/, 'the mod now last must win');
  assert.match(b.html('[data-badges]'), /5 overridden/);
  assert.doesNotMatch(a.html('[data-badges]'), /overridden/);
  assert.match(a.html('[data-ordernotes]'), /also in <strong>Beta<\/strong>/);
});

test('a mod switched off stops contesting anything', () => {
  const a = fakeRow('a');
  const b = fakeRow('b', false);
  const m = { mods: [{ slug: 'a', name: 'Alpha' }, { slug: 'b', name: 'Beta' }],
    conflicts: [{ winner: 'b', loser: 'a', files: 5, sample: [] }] };
  runPaint([a, b], m);
  // Not "a wins": b provides no files at all, so there is no contest to report.
  assert.equal(a.html('[data-badges]'), '');
  assert.equal(b.html('[data-badges]'), '');
  assert.equal(a.html('[data-ordernotes]'), '');
});

test('every way the order can change repaints it', () => {
  // Three: the arrow buttons, a drag, and a switch. Missing one leaves the page lying in
  // exactly the way this was meant to fix.
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.equal(wire[0].split('paintConflicts(list, m)').length - 1, 4,
    'first paint, arrows, drag and switch');
  // Under the cursor, not one gesture later: repainting on drop would show the answer after
  // the decision it informs has been made.
  const over = /el\.ondragover = \(e\) => \{[\s\S]*?\n    \};/.exec(wire[0])!;
  assert.match(over[0], /paintConflicts\(list, m\);/);
});

test('plugin toggles moved into the modal but stay inside the card element', () => {
  // Save reads [data-plug] via the card element, and Bootstrap shows a modal WITHOUT moving
  // its node — so nesting it in .vt-mod is what keeps the save wiring working. A modal
  // appended to <body> would silently save every plugin as untouched.
  const card = /const card = \(mod, i\) => \{[\s\S]*?\n  \};/.exec(app)!;
  assert.match(card[0], /data-plug="\$\{p\.file\}"/);
  assert.ok(card[0].indexOf('${raw(modal)}') > card[0].indexOf('data-plug'),
    'the modal must render inside the .vt-mod card');
});

test('a drag that starts inside the open modal does not reorder the list', () => {
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(wire[0], /e\.target\.closest\('\.modal'\)/);
});
