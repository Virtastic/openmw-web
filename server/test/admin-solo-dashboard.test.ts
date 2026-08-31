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
  assert.match(wire[0], /mods\/install\?name=/);
  assert.match(wire[0], /renderChooser/);
  assert.match(wire[0], /mods\/install\/commit/);
  // And commit must be reachable only from the chooser, never straight from the upload.
  assert.ok(wire[0].indexOf('renderChooser(body)') < wire[0].indexOf("api('/mods/install/commit'"));
});

test('a non-zip is refused in the browser, before the bytes are sent', () => {
  // Telling somebody their .rar is unsupported after a 400 MB upload is the wrong moment.
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(wire[0], /\.zip\$\/i\.test\(file\.name\)/);
  assert.ok(wire[0].indexOf('.zip$/i.test(file.name)') < wire[0].indexOf('mods/install?name='));
});

test('removing a mod is type-to-confirm, like every other delete here', () => {
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(wire[0], /typeToConfirm: slug/);
});

test('the zip streams rather than being buffered into a form', () => {
  // A multipart parser for a several-hundred-megabyte archive is a dependency and a memory
  // problem; the Data Files upload already settled this.
  const wire = /function wireMods\(m\) \{[\s\S]*?\n\}/.exec(app)!;
  assert.match(wire[0], /duplex: 'half'/);
  assert.match(wire[0], /application\/octet-stream/);
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
