// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// s170: A STRANGER CAN HOST THIS. The whole first evening, end to end, on an EMPTY data dir:
// the container's own entrypoint brings the multiplayer server up with nothing in /data, the
// operator claims it and finishes the setup wizard through the routes the dashboard page
// calls (owner, game files, a friend's account, the answers, the restart), the server comes
// back through the entrypoint on the marker the wizard wrote, and then two people play a
// session through the LAUNCHER -- password sign-in, the onboarding handle, the character
// tiles, "Friends playing now" -- not the harness's ?mp= shortcut. Everything the other
// scenarios get pre-seeded (config.toml, harness auth, a locker session minted by hand) is
// absent here on purpose: what this proves is the shipped defaults.
//
// Runs only where ci/jenkins/run-fresh-install.sh put it: the play server must proxy the
// launcher's same-origin /auth, /worlds and /w/ paths to THIS scenario's gateway
// (OPENMW_MP_UPSTREAM), exactly as Caddy does in front of a real deployment, and a peer
// binary plus retail data must exist for the worlds to simulate anything.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { adminApi } from './_gateway.mjs';
import { drown } from './_death.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GW_PORT = 18700; // below the 18860..19150 band the other gateway scenarios use
const PLAY = 'http://127.0.0.1:8910';
const STEP = 30_000;
// FIVE ENGINE BOOTS (host, guest twice, the guest's relog, and the peer-held cells around
// each) on a SwiftShader box, plus a real upload of the game files. The 20-minute default
// ceiling is for a scenario that boots twice.
export const timeoutMs = 50 * 60_000;

const OWNER = { name: 'owner@example.com', password: 'a-long-enough-passphrase' };
const SPOT = '-12500,-53100,512'; // inside -2,-7, where the peer names scrib / kwama forager (s109/s164)
const WEAPON = 'iron longsword';
const REACH = 110;
const NEW_DOC_SCRIPT = `(function(){
  // MORROWIND'S OWN CHARACTER CREATION CANNOT BE DRIVEN HEADLESSLY: the launcher boots a fresh
  // slot with #mpnew=1 (--new-game: the intro, the ship, the census office's MyGUI dialogs on
  // the canvas), and nothing in CDP clicks a MyGUI button. ?start= is the engine's own QA aid
  // for exactly this (index.html: OPENMW_QA_AUTOCHARGEN) -- the boot it produces is still the
  // launcher's: same ticket, character id, mphome, locker; only the opening is skipped.
  if (!/index\\.html$/.test(location.pathname)) return;
  if (!/[#&]mpnew=1/.test(location.hash || '')) return;
  if (/[?&]start=/.test(location.search)) return;
  location.replace(location.pathname + '?novid&skipintro=1&start=Seyda%20Neen' + location.hash);
})();`;

const shown = (id) => `(function(){ var e = document.getElementById('${id}'); return !!e && e.classList.contains('show'); })()`;
const onGamePage = "/index\\.html$/.test(location.pathname)";
const poseOf = async (c) => JSON.parse(await c.eval('window.omw.state.pose||"{}"'));
// A LEGAL approach on a real server. This server is production-shaped (no [limits] harness),
// so a same-cell jump past SAME_CELL_JUMP (1024 u, connection.ts) is refused as a teleport
// hack -- fresh7: `conn.cell_change_refused dist 1110` and the avatar never followed. The
// suite's testhost waves those through, which is why s164 may snap beside its mark and this
// may not. Hop in 900 u legs, each settled on the snapper before the next.
async function hopTo(ctx, c, x, y, z) {
  for (let leg = 0; leg < 12; leg++) {
    const at = await poseOf(c);
    const dx = x - at.x, dy = y - at.y, d = Math.hypot(dx, dy);
    if (d < 50) return;
    const f = Math.min(1, 900 / d);
    const tx = Math.round(at.x + dx * f), ty = Math.round(at.y + dy * f), tz = Math.round(f < 1 ? at.z + 8 : z);
    await c.cmd(`snapto:${tx},${ty},${tz}`);
    await c.waitFor(`(function(){ var p = JSON.parse(window.omw.state.pose||"null"); return !!p && Math.hypot(p.x - (${tx}), p.y - (${ty})) < 120; })()`, 20_000, `${c.name} hop ${leg + 1} landed`);
    await ctx.sleep(1_500); // the avatar's follow-teleport, so the next leg is measured from here
  }
}
const probeOf = async (c, rec) => JSON.parse(await c.eval('window.omw.state.actorProbe||"{}"'))[rec];
const rowOf = (handle) => `(JSON.parse(window.omw.state.players || '[]').find(function (p) { return p.name === ${JSON.stringify(handle)}; }) || {})`;
const puppetOf = (id) => `(JSON.parse(window.omw.state.puppets||"{}")[${JSON.stringify(id)}]||{})`;
const corpseHas = (netId, itemId, n) =>
  `(JSON.parse(window.omw.state.containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}] === ${n}`
  + (n === 0 ? ` || !((JSON.parse(window.omw.state.containerItems||"{}")["n:${netId}"]||{})[${JSON.stringify(itemId)}])` : '');

async function waitHttp(url, timeoutMs) {
  const by = Date.now() + timeoutMs;
  while (Date.now() < by) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** THE IMAGE'S OWN ENTRYPOINT, on this tree's dist/: the same script docker runs as PID 1,
 *  with the tier2 image's environment (OMW_DEFAULT_MODE=gateway). A restart is what docker's
 *  restart policy does -- run it again -- and it re-reads <data>/.mode like the real thing. */
function bootGateway(ctx, dataDir) {
  const gw = spawn('sh', [join(ROOT, 'server', 'docker-entrypoint.sh')], {
    cwd: join(ROOT, 'server'),
    env: { ...process.env, OMW_DATA: dataDir, OMW_DEFAULT_MODE: 'gateway',
      OMW_PORT: String(GW_PORT), OMW_BASE_PORT: String(GW_PORT + 2000) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its worlds and their peers go with it
  });
  ctx.watchChild('gateway', gw);
  return gw;
}

/** Sign in at the real launcher with a username and password, and take the onboarding
 *  handle if it is asked for. Leaves the page on the character screen -- or already on its
 *  way into the game, when the screen auto-creates a first character. */
async function launcherSignIn(ctx, client, creds, handle) {
  await client.waitFor("(function(){ var t = document.getElementById('card-mp'); return !!t && !t.hidden; })()", STEP, 'the launcher shows the multiplayer tile');
  await client.click('#card-mp');
  await client.waitFor("!!document.getElementById('mp-pw-go')", STEP, 'the sign-in sheet offers a password form (the server said allowPasswordLogin)');
  await client.eval(`document.getElementById('mp-pw-name').value = ${JSON.stringify(creds.name)};`
    + `document.getElementById('mp-pw-pass').value = ${JSON.stringify(creds.password)}; 'filled';`);
  await client.click('#mp-pw-go');
  const errNote = "(function(){ var n = document.getElementById('mp-note'); return n && /err/.test(n.className) ? n.textContent : ''; })()";
  await client.waitFor(`${shown('ob-bd')} || ${shown('cs-bd')} || ${onGamePage} || ${errNote} !== ''`, 60_000, 'the launcher answered the sign-in');
  const err = await client.eval(`(function(){ try { return ${errNote}; } catch (e) { return ''; } })()`);
  assert.equal(err, '', `the launcher refused the sign-in: ${err}`);
  if (await client.eval(`(function(){ try { return ${shown('ob-bd')}; } catch (e) { return false; } })()`)) {
    // First sign-in: the public handle, and an address when the account has none.
    await client.eval(`document.getElementById('ob-username').value = ${JSON.stringify(handle)};`
      + `if (document.getElementById('ob-email-wrap').style.display !== 'none') document.getElementById('ob-email').value = ${JSON.stringify(handle + '@example.com')}; 'filled';`);
    await client.click('#ob-continue');
    await client.waitFor(`${shown('cs-bd')} || ${onGamePage}`, 60_000, 'the handle was accepted and the character screen followed');
    ctx.log(`${client.name}: signed in at the launcher, took the handle ${handle}`);
  } else {
    ctx.log(`${client.name}: signed in at the launcher (handle already set)`);
  }
}

/** The page has navigated into the game: wait for the join, the loading screen and the
 *  character to settle -- what launchClient does for a ?mp= boot, for a launcher boot. */
async function awaitInWorld(ctx, client, what) {
  await client.waitFor(onGamePage, 60_000, `${what}: the launcher handed off to the game page`);
  const t0 = Date.now();
  await client.waitFor('window.omw.state.state === "Joined"', Number(process.env.JOIN_TIMEOUT_MS || 300_000), `${what}: Joined`);
  await client.waitFor("(function(){var el=document.getElementById('loading');return !el || el.classList.contains('hide') || el.style.display === 'none';})()",
    Number(process.env.LOADING_CLEAR_MS || 45_000), `${what}: the loading screen cleared`);
  await client.waitFor('String(window.omw.state.baselineReady||"") === "1"', 120_000, `${what}: the character settled (chargen done or record restored)`);
  ctx.log(`${client.name}: in the world (${what}) after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

export default async function run(ctx) {
  const mwdata = join(ROOT, 'play', 'mwdata');
  if (!process.env.OMW_SIM_PEER_BIN || !existsSync(process.env.OMW_SIM_PEER_BIN)) { ctx.log('SKIP: no sim peer binary (OMW_SIM_PEER_BIN): a fresh install spawns its own peers'); return; }
  if (!existsSync(join(mwdata, 'Morrowind.esm'))) { ctx.log('SKIP: no retail data under play/mwdata to upload'); return; }
  if (process.env.OPENMW_MP_UPSTREAM !== `127.0.0.1:${GW_PORT}`) {
    ctx.log(`SKIP: OPENMW_MP_UPSTREAM must point the play server at this scenario's gateway (127.0.0.1:${GW_PORT}); run it through ci/jenkins/run-fresh-install.sh`);
    return;
  }
  // An EMPTY data dir. The shell script hands one over so the run's artefacts (setup-token,
  // .mode, logs, the uploaded game files) can be inspected afterwards; alone, a temp dir.
  const dataDir = process.env.OMW_FRESH_DATA || mkdtempSync(join(tmpdir(), 'omw-fresh-'));
  assert.ok(existsSync(dataDir) && readdirSync(dataDir).length === 0, `the fresh data dir must be EMPTY: ${dataDir} holds ${readdirSync(dataDir).join(', ')}`);
  ctx.syncPeerScripts(); // the worlds' peers run the scripts under test, not the image's baked copy
  const gwLog = () => ctx.childLogTail('gateway', 20_000);
  const gwBase = `http://127.0.0.1:${GW_PORT}`;
  const tag = String(ctx.runId).replace(/[^a-z0-9]/gi, '').slice(-6);
  const FRIEND = { name: `friend${tag}`, password: 'another-long-passphrase' };
  const HOST_HANDLE = `host${tag}`, GUEST_HANDLE = `pal${tag}`;
  const phase = (n, s) => ctx.log(`--- ${n}: ${s}`);

  // ===================================================================== 1. FIRST BOOT
  phase(1, 'the entrypoint boots the multiplayer server on an empty data dir');
  let gw = bootGateway(ctx, dataDir);
  assert.ok(await waitHttp(`${gwBase}/healthz`, 60_000), 'the gateway must come up on an empty data dir');
  assert.match(gwLog(), /"event":"entrypoint.mode","mode":"gateway"/, 'the entrypoint must announce the gateway branch');
  assert.ok(existsSync(join(dataDir, 'setup-token')), 'first run mints a setup token beside the data');
  assert.match(gwLog(), /FIRST-TIME SETUP/, 'the setup banner is printed at boot');
  const api = adminApi(GW_PORT);
  let state = (await api.get('/state')).body;
  assert.equal(state.firstRun, true, `a fresh server is a first run: ${JSON.stringify(state)}`);
  assert.equal(state.needsSetupKey, false, 'from this machine the key is not demanded');
  assert.equal(state.platform, true, 'the multiplayer server answers, not a single game');
  assert.equal(state.setupCompleted, false);
  let front = await fetch(`${gwBase}/`, { redirect: 'manual' });
  assert.equal(front.status, 302, 'before setup the front door sends everyone to /admin');
  assert.equal(front.headers.get('location'), '/admin');
  ctx.log('ok: empty dir -> gateway up, first run, front door parked on the wizard');

  // ===================================================================== 2. THE WIZARD
  phase(2, 'the wizard, through the routes app.js calls');
  // Step 1 (owner). The dashboard refuses a weak password before creating anything.
  const weak = await api.post('/setup/owner', { name: OWNER.name, password: 'short' });
  assert.equal(weak.status, 400, `a weak owner password is refused (${weak.status})`);
  const owner = await api.post('/setup/owner', OWNER);
  assert.equal(owner.status, 200, `the owner is created (${owner.status}: ${JSON.stringify(owner.body)})`);
  assert.equal(owner.body.role, 'owner');
  api.token = owner.body.token;
  assert.ok(!existsSync(join(dataDir, 'setup-token')), 'the setup token is spent the moment an owner exists');
  const again = await api.post('/setup/owner', { name: 'second@example.com', password: OWNER.password });
  assert.equal(again.status, 409, `a second owner claim is refused (${again.status})`);
  state = (await api.get('/state')).body;
  assert.equal(state.firstRun, false); assert.equal(state.role, 'owner'); assert.equal(state.name, OWNER.name);

  // Step 3 (content) + step 9 (files): the checklist is empty, then the upload fills it.
  const have = new Set(readdirSync(mwdata).map((f) => f.toLowerCase()));
  const profile = ['tribunal.esm', 'tribunal.bsa', 'bloodmoon.esm', 'bloodmoon.bsa'].every((f) => have.has(f)) ? 'expansions' : 'morrowind';
  let mods = (await api.get(`/mods?profile=${profile}`)).body;
  assert.equal(mods.writable, true, 'the game data folder is writable');
  const requires = mods.profiles[profile].requires;
  const present = () => new Set([...(mods.entries || []).map((e) => e.file.toLowerCase()), ...(mods.archives || []).map((a) => a.toLowerCase())]);
  assert.equal([...present()].length, 0, `an empty install lists no game files: ${[...present()].join(', ')}`);
  const realName = (f) => readdirSync(mwdata).find((e) => e.toLowerCase() === f.toLowerCase());
  const uploads = requires.map((f) => [f, realName(f)]);
  // One loose media file per directory the profile lists, so the subdirectory path (the
  // "Music/Explore/mx_explore_1.mp3" shape) is exercised without shipping the whole Sound tree.
  for (const dir of mods.profiles[profile].media) {
    const real = realName(dir);
    if (!real || !statSync(join(mwdata, real)).isDirectory()) continue;
    const walk = (d) => readdirSync(join(mwdata, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    // The smallest file the upload route ACCEPTS (api-mods.ts MEDIA_EXT): a Data Files tree
    // also carries Sound/Vo/.../Warnings.txt and the like, which the dashboard skips as "not
    // game data, expected in bulk" -- picking one of those asserted a 200 on a by-design 400.
    const smallest = walk(real).filter((f) => /.(mp3|wav|bik|fnt|tex|dds|tga|bmp)$/i.test(f)).sort((a, b) => statSync(join(mwdata, a)).size - statSync(join(mwdata, b)).size)[0];
    if (smallest) uploads.push([smallest.replace(/\\/g, '/'), smallest]);
  }
  const notData = await api.upload('README.txt', Readable.toWeb(Readable.from(['not game data'])));
  assert.equal(notData.status, 400, `a file that is not game data is refused (${notData.status})`);
  let bytes = 0;
  const t0 = Date.now();
  for (const [rel, src] of uploads) {
    const size = statSync(join(mwdata, src)).size;
    const r = await api.upload(rel, Readable.toWeb(createReadStream(join(mwdata, src))));
    assert.equal(r.status, 200, `upload of ${rel} (${r.status}: ${JSON.stringify(r.body)})`);
    assert.equal(r.body.bytes, size, `${rel}: the server received every byte`);
    assert.equal(r.body.restartRequired, true);
    bytes += size;
  }
  ctx.log(`ok: uploaded ${uploads.length} files, ${Math.round(bytes / 1048576)} MB, in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  mods = (await api.get(`/mods?profile=${profile}`)).body;
  for (const f of requires) assert.ok(present().has(f.toLowerCase()), `${f} is on the checklist after the upload`);
  for (const dir of mods.profiles[profile].media) {
    if (uploads.some(([rel]) => rel.toLowerCase().startsWith(dir.toLowerCase() + '/'))) assert.ok((mods.media?.[dir] ?? 0) > 0, `${dir}/ counts its file`);
  }
  for (const [rel, src] of uploads) {
    const st = statSync(join(dataDir, 'gamedata', rel));
    assert.equal(st.size, statSync(join(mwdata, src)).size, `${rel} landed in <data>/gamedata byte-for-byte`);
  }

  // A friend's account: the accounts page, role '' = a player with no dashboard access.
  const friend = await api.post('/accounts/create', { ...FRIEND, role: '' });
  assert.equal(friend.status, 200, `the friend's account is created (${friend.status}: ${JSON.stringify(friend.body)})`);
  const listed = (await api.get('/accounts')).body.accounts;
  assert.ok(listed.some((a) => a.name === FRIEND.name && a.dashboardRole === null), 'the friend is listed as a plain player');
  assert.ok(listed.some((a) => a.name === OWNER.name && a.dashboardRole === 'owner'));

  // The review step: every answer at once, completed, then the restart the page asks for.
  const answers = {
    deploymentMode: 'multiplayer', loginMethods: ['password'], registration: 'closed', inviteCode: '',
    contentProfile: profile, deliveryModel: 'serve', hosting: 'internal', httpPort: 80, domain: '',
    serverName: `Fresh ${tag}`, storage: 'local', domainVerified: '',
    s3: { endpoint: '', bucket: '', region: 'auto', accessKeyId: '', secretAccessKey: '' },
    ssoCreds: {}, completed: true,
  };
  const applied = await api.post('/setup', answers);
  assert.equal(applied.status, 200, `the wizard answers are applied (${applied.status}: ${JSON.stringify(applied.body)})`);
  assert.equal(applied.body.restartRequired, true, 'the wizard says a restart is needed');
  assert.equal(readFileSync(join(dataDir, '.mode'), 'utf8').trim(), 'gateway', 'the wizard wrote the entrypoint marker for multiplayer');
  state = (await api.get('/state')).body;
  assert.equal(state.setupCompleted, true, 'the page unlocks before the restart lands');
  assert.equal(state.setup.deploymentMode, 'multiplayer');
  assert.equal(state.setup.contentProfile, profile);
  assert.ok(existsSync(join(dataDir, 'caddy', 'Caddyfile')), 'the proxy config was written next to the data');
  ctx.log('ok: owner, files, a friend, the answers; .mode=gateway written');

  // ===================================================================== 3. THE RESTART
  phase(3, 'the restart the wizard asks for: the entrypoint re-reads the marker');
  const exited = new Promise((res) => gw.once('exit', res));
  const restart = await api.post('/restart');
  assert.equal(restart.status, 200);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 60_000))]);
  assert.equal(code, 0, `the gateway drains and exits cleanly on the restart request (exit ${code})`);
  assert.match(gwLog(), /gateway\.restart_requested/, 'the restart is in the log');
  gw = bootGateway(ctx, dataDir);
  assert.ok(await waitHttp(`${gwBase}/healthz`, 60_000), 'the gateway comes back');
  assert.equal((gwLog().match(/"event":"entrypoint.mode","mode":"gateway"/g) || []).length, 2, 'the second boot took the gateway branch (from the marker)');
  assert.doesNotMatch(gwLog(), /FIRST-TIME SETUP[\s\S]*FIRST-TIME SETUP/, 'the setup banner is not printed twice');
  state = (await api.get('/state')).body;
  assert.equal(state.firstRun, false, 'setup does not reopen after the restart');
  assert.equal(state.setupCompleted, true);
  assert.equal(state.serverName, answers.serverName, 'the wizard answers were loaded');
  front = await fetch(`${gwBase}/`, { redirect: 'manual' });
  assert.equal(front.status, 200, 'after setup the front door is the sign-in landing page');
  // The old session died with the old process; the owner signs in with the password again.
  assert.equal((await api.get('/overview')).status, 401, 'sessions do not outlive the process');
  const login = await api.post('/login', OWNER);
  assert.equal(login.status, 200, `the owner signs in with the password after the restart (${login.status})`);
  api.token = login.body.token;
  const providers = await (await fetch(`${gwBase}/auth/providers`)).json();
  assert.equal(providers.allowPasswordLogin, true, 'players may sign in with a password');
  assert.equal(providers.allowRegistration, false, 'sign-ups are closed, as answered');
  const manifest = await (await fetch(`${gwBase}/mwdata-manifest.json`)).json();
  for (const [rel, src] of uploads) {
    const entry = manifest.find((e) => e.p === rel);
    assert.ok(entry && entry.s === statSync(join(mwdata, src)).size, `the server hands out ${rel} at its real size`);
  }
  const head = await fetch(`${gwBase}/mwdata/Morrowind.esm`, { headers: { range: 'bytes=0-3' } });
  assert.equal(head.status, 206, 'game files stream by range');
  assert.equal(Buffer.from(await head.arrayBuffer()).toString('latin1'), 'TES3', 'and the bytes are Morrowind');
  ctx.log('ok: back on the marker, answers loaded, password sign-in on, the game served');

  // ===================================================================== 4. THE HOST
  phase(4, 'the owner plays: launcher -> password -> handle -> new character -> own world');
  const launcher = { url: `${PLAY}/launcher.html`, waitExpr: "document.readyState === 'complete' && !!document.getElementById('card-mp')", waitWhat: 'the launcher page', newDocScript: NEW_DOC_SCRIPT, joinTimeoutMs: 120_000 };
  const host = await ctx.launchClient('host', '', launcher);
  await launcherSignIn(ctx, host, OWNER, HOST_HANDLE);
  // No characters yet: the tile screen creates the first one itself and boots.
  await awaitInWorld(ctx, host, 'the host');
  assert.equal(await host.eval('String(window.omw.state.amHost||"")'), 'true', 'the owner is the host of the world the launcher opened');
  assert.equal(await host.eval('String(window.omw.state.profileUsername||"")'), HOST_HANDLE, 'the handle from onboarding is what the world knows');
  const hostLocker = await host.eval("JSON.parse(sessionStorage.getItem('omw-mp-session')||'{}').lockerToken||''");
  assert.ok(hostLocker, 'the launcher parked a locker session for the tab');
  const hostChars = await (await fetch(`${gwBase}/auth/characters`, { headers: { authorization: `Bearer ${hostLocker}` } })).json();
  assert.equal(hostChars.characters.length, 1, `creation finished and the character exists: ${JSON.stringify(hostChars)}`);
  assert.equal(hostChars.characters[0].needsChargen, false, 'the character is finished, not a half-made slot');
  // The operator's dashboard lists the game, labelled by the handle (s101), with the owner in it.
  const games = (await api.get('/games')).body.games;
  const hostWorld = games.find((g) => g.up && g.playerCount > 0);
  assert.ok(hostWorld, `the host's world is up with a player in it: ${JSON.stringify(games).slice(0, 300)}`);
  assert.equal(hostWorld.ownerName, HOST_HANDLE, 'the dashboard labels the game by the owner\'s handle');
  assert.equal(hostWorld.mode, 'private', 'a new world opens Solo');
  await host.waitFor('String(window.omw.state.simReady||"") === "1"', 300_000, "the world's own peer is up (spawned by the world, from the uploaded files)");
  ctx.log(`ok: the host is in ${hostWorld.id}, simulated by the world's own peer`);

  // ===================================================================== 5. THE FRIEND
  phase(5, 'the friend: own world first (a character has to exist), then Party from the O panel, then "Friends playing now"');
  const guest = await ctx.launchClient('guest', '', launcher);
  await launcherSignIn(ctx, guest, FRIEND, GUEST_HANDLE);
  await awaitInWorld(ctx, guest, "the friend's own world");
  assert.equal(await guest.eval('String(window.omw.state.profileUsername||"")'), GUEST_HANDLE);
  await host.cmd(`social:FriendRequest:${GUEST_HANDLE}`);
  await guest.waitFor(`JSON.parse(window.omw.state.friendRequests||'[]').length > 0`, STEP, 'the request arrives across worlds');
  await guest.cmd(`social:FriendAccept:${HOST_HANDLE}`);
  await host.waitFor(`JSON.parse(window.omw.state.friends||'[]').length === 1`, STEP, 'they are friends');
  // THE O PANEL: a real key, then a real click on Party. The host is a first-timer, so the
  // feature tour is up and sits ABOVE the social panel: fresh4 clicked Party and the browser
  // handed the click to omw-tour. A player closes the tour first; so does this.
  if (await host.eval("document.getElementById('omw-tour').classList.contains('show')")) {
    await host.eval("document.getElementById('omw-tour-x').click()");
    await host.waitFor("!document.getElementById('omw-tour').classList.contains('show')", 3000, 'the tour closed');
  }
  await host.key({ key: 'o', code: 'KeyO', keyCode: 79 });
  await host.waitFor("document.getElementById('omw-social').classList.contains('show')", STEP, 'O opened the social panel');
  const hit = await host.click('#omw-social .whererow .seg button:nth-child(2)');
  ctx.log(`clicked Party (the browser handed the click to ${hit})`);
  await host.waitFor(`JSON.parse(window.omw.state.socialResult||'{}').op === 'SetWorldMode' && String(JSON.parse(window.omw.state.socialResult||'{}').detail) === 'party'`, STEP, 'the server flipped the world to Party');
  assert.match(gwLog(), /world\.mode_flip.*"mode":"party"/, 'the flip reached the world');
  // The friend leaves their own world the way a player does (Exit), lands on the tiles...
  await guest.eval('window.__omwExitToLauncher(); "bye"');
  await guest.waitFor(`/launcher\\.html$/.test(location.pathname) && ${shown('cs-bd')}`, 60_000, 'Exit landed the friend on their character tiles');
  // ...where the host is listed as playing, and one click joins.
  await guest.waitFor("(function(){ var b = document.querySelector('.cs-friends .cs-friend button'); return !!b && !b.disabled; })()", 90_000, '"Friends playing now" lists the host with a Join button');
  const who = await guest.eval("document.querySelector('.cs-friends .cs-friend b').textContent");
  assert.equal(who, HOST_HANDLE, 'the friend playing is the host, by handle');
  await guest.click('.cs-friends .cs-friend button');
  await awaitInWorld(ctx, guest, "the host's world, from the launcher");
  await host.waitFor(`${rowOf(GUEST_HANDLE)}.id !== undefined`, STEP, 'the host sees the friend arrive');
  await guest.waitFor(`String(window.omw.state.worldHost||"") === ${JSON.stringify(HOST_HANDLE)} && String(window.omw.state.amHost||"") === "false"`, STEP, 'the friend knows whose world this is');
  const hp0 = await poseOf(host), gp0 = await poseOf(guest);
  assert.ok(Math.hypot(hp0.x - gp0.x, hp0.y - gp0.y) < 600, `the friend landed beside the host (${Math.hypot(hp0.x - gp0.x, hp0.y - gp0.y).toFixed(0)} u)`);
  const hostId = String(await host.eval('window.omw.state.playerId'));
  const guestId = String(await guest.eval('window.omw.state.playerId'));
  ctx.log('ok: the friend joined from the launcher and stands beside the host');

  // ===================================================================== 6. THE SESSION
  phase(6, 'ten minutes together: walk, fight, loot, die, relog, the host blips, both exit');
  // WALK TOGETHER: each sees the other's puppet cover the ground.
  await host.cmd('snapto:' + SPOT);
  await guest.cmd('snapto:-12300,-53100,512');
  // The puppet must have FOLLOWED the snap before the walk is measured, or the teleport
  // itself would count as the walk.
  const settled = (watcher, id, at) => watcher.waitFor(`Math.hypot(${puppetOf(id)}.x - ${at.x}, ${puppetOf(id)}.y - ${at.y}) < 250`, STEP, `${watcher.name} sees ${id}'s puppet where the snap put it`);
  // ...and the snap itself must have LANDED on the snapper first: fresh6 read the host's pose
  // before its teleport ran (a frame a second), matched the puppet at the OLD spot, and
  // measured a walk against a puppet nobody had told to move.
  const arrived = (c, at) => c.waitFor(`(function(){ var p = JSON.parse(window.omw.state.pose||"null"); return !!p && Math.hypot(p.x - (${at[0]}), p.y - (${at[1]})) < 250; })()`, STEP, `${c.name} arrived at the snap`);
  await arrived(host, SPOT.split(',').map(Number));
  await arrived(guest, [-12300, -53100]);
  await settled(guest, hostId, await poseOf(host));
  await settled(host, guestId, await poseOf(guest));
  const before = JSON.parse(await guest.eval(`JSON.stringify(${puppetOf(hostId)})`));
  const walked = await host.walk(0, 1, 2500, 100);
  // fresh5: the friend never saw the walk while their puppet of the host was distance-snapped
  // every ~3.5 s (under a concurrent engine bake, load 30). Say what each side holds.
  // fresh6 (quiet box) had the same shape: backlog 480 -- a despawn in the same frame as an
  // in-flight teleport could not remove the body (count 0), and the orphan's puppet.lua drove
  // the tracked successor to its stale target every 3 s; the successor itself had been spawned
  // by a lagging pose into the UNLOADED old cell, where its script never runs. Client Lua fix;
  // needs a bake before this phase is a verdict. `settled` above is the right wait either way.
  ctx.log(`host walked to ${JSON.stringify(walked)} on their own screen; avatar divergence ${await host.eval("window.omw.state.selfDivergence")}; friend's puppet of the host before ${JSON.stringify(before)} now ${await guest.eval(`JSON.stringify(${puppetOf(hostId)})`)}`);
  await guest.waitFor(`Math.hypot(${puppetOf(hostId)}.x - ${before.x}, ${puppetOf(hostId)}.y - ${before.y}) > 80`, STEP, "the friend saw the host walk");
  const gb = JSON.parse(await host.eval(`JSON.stringify(${puppetOf(guestId)})`));
  await guest.walk(0, 1, 2500, 100);
  await host.waitFor(`Math.hypot(${puppetOf(guestId)}.x - ${gb.x}, ${puppetOf(guestId)}.y - ${gb.y}) > 80`, STEP, 'the host saw the friend walk');
  ctx.log(`ok: walked together (host to ${walked.x.toFixed(0)},${walked.y.toFixed(0)})`);

  // FIGHT: the s164 idiom -- a real sword, the stance, the use bit; the peer's avatar swings.
  await host.waitFor('Object.keys(JSON.parse(window.omw.state.netObjects||"{}")).length > 0', 120_000, 'the peer named a creature');
  await host.waitFor('Number(window.omw.state.puppetedActors||0) > 0', STEP, 'the cell is peer-held');
  const me = await poseOf(host);
  const probe = JSON.parse(await host.eval('window.omw.state.actorProbe||"{}"'));
  const dist = (r) => { const p = probe[r]; return p && !p.dead ? Math.hypot(p.x - me.x, p.y - me.y) : Infinity; };
  const [netId, victim] = Object.entries(JSON.parse(await host.eval('window.omw.state.netObjects||"{}"'))).sort((x, y) => dist(x[1]) - dist(y[1]))[0];
  assert.ok(Number.isFinite(dist(victim)), `no living named creature nearby: ${JSON.stringify(Object.keys(probe))}`);
  await guest.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.actorProbe||"{}"), ${JSON.stringify(victim)})`, STEP, `the friend sees the ${victim} too`);
  await host.cmd(`equip:${WEAPON}:16`);
  await host.waitFor(`(window.omw.state.equippedIds||"").indexOf(${JSON.stringify(WEAPON)}) >= 0`, 15_000, 'the sword is in hand');
  await host.cmd('setskill:longblade:100');
  await ctx.sleep(3_000);
  await host.cmd('stance:weapon');
  await host.waitFor('window.omw.state.stance === "weapon"', 10_000, 'the sword is drawn');
  const p0 = await probeOf(host, victim);
  await hopTo(ctx, host, p0.x + 60, p0.y, p0.z + 8);
  await host.eval("if (window.omw.state) window.omw.state.selfDivergence = null; 'cleared';");
  await host.waitFor('typeof window.omw.state.selfDivergence === "string" && Number(window.omw.state.selfDivergence) < 96', 60_000, 'the avatar rules our pose beside the mark');
  await host.cmd(`hitn:${victim}:1`);
  await ctx.sleep(2_000);
  await host.eval("if (window.omw.state) window.omw.state.hitFwd = undefined; 'cleared';");
  const deadExpr = `((JSON.parse(window.omw.state.actorProbe||"{}")[${JSON.stringify(victim)}]||{}).dead === true)`;
  let swings = 0, died = false, resnaps = 0;
  for (const by = Date.now() + 90_000; Date.now() < by && !died;) {
    const p = (await probeOf(host, victim)) || p0;
    const now = await poseOf(host);
    if (Math.hypot(p.x - now.x, p.y - now.y) > REACH) {
      if (resnaps++ < 4) { await hopTo(ctx, host, p.x + 60, p.y, p.z + 8); await ctx.sleep(2_500); }
      else await ctx.sleep(1_000);
      continue;
    }
    await host.cmd(`face:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z + 20)}`);
    await host.cmd('stance:weapon');
    await ctx.sleep(200);
    await host.cmd('attack:1500'); swings++;
    if (swings === 1) await host.waitFor('(Number(window.omw.state.selfFlags||0) & 8) === 8', 10_000, 'the avatar reports swinging');
    await ctx.sleep(2_000);
    died = (await host.eval(deadExpr)) === true;
  }
  assert.ok(died, `the ${victim} never died after ${swings} swings`);
  assert.equal(String(await host.eval('window.omw.state.hitFwd')), 'undefined', 'the owner sent no hit of its own');
  await guest.waitFor(deadExpr, STEP, "the creature is dead on the friend's screen too");
  ctx.log(`ok: the peer's ${victim} killed with ${swings} real swing(s)`);

  // LOOT: the corpse is a shared container; the friend takes what the host put in.
  await host.cmd('equiptest'); // a dynamic helmet record (global.lua mpTestItem), equipped beside the sword
  await host.waitFor(`(window.omw.state.equippedIds||"").split(",").some(function(id){ return id && id !== ${JSON.stringify(WEAPON)}; })`, 12_000, 'the host holds a test item');
  const itemId = (await host.eval('window.omw.state.equippedIds')).split(',').find((id) => id && id !== WEAPON);
  await host.cmd(`chest:open:${netId}`);
  await host.waitFor(`Object.prototype.hasOwnProperty.call(JSON.parse(window.omw.state.containerItems||"{}"), "n:${netId}")`, STEP, 'the corpse registered as a container');
  await host.cmd(`chest:put:${itemId}`);
  await host.waitFor(corpseHas(netId, itemId, 1), STEP, 'the corpse holds the item');
  await guest.cmd(`chest:open:${netId}`);
  await guest.waitFor(corpseHas(netId, itemId, 1), STEP, "the corpse's contents reached the friend");
  await guest.cmd(`chesttake:${netId}:${itemId}`);
  await guest.waitFor('!!window.omw.state.chestOp', STEP, 'the take was answered');
  const op = JSON.parse(await guest.eval('window.omw.state.chestOp'));
  assert.equal(op.ok, true, `the friend's take was refused: ${JSON.stringify(op)}`);
  await host.waitFor(corpseHas(netId, itemId, 0), STEP, 'the corpse is empty on the host');
  ctx.log('ok: looted the kill');

  // DIE AND RESPAWN. Stock rules: where you fell, health restored (no respawn point set).
  await guest.waitFor('Number(window.omw.state.hp||"0") > 0', STEP, 'the friend has health');
  await drown(guest, ctx, 180_000);
  const fell = await poseOf(guest);
  await host.waitFor(`${puppetOf(guestId)}.dead === true`, 300_000, 'the host sees the friend drown');
  await guest.cmd('walk:0,0,1'); // stop holding the body under
  await guest.waitFor('Number(window.omw.state.hp||"0") > 0', 60_000, 'health restored by the respawn');
  { const [sx, sy, sz] = SPOT.split(',').map(Number); await hopTo(ctx, guest, sx, sy, sz); } // out of the water before it drowns again (stock rules respawn in place)
  assert.equal(await guest.eval('window.omw.state.state'), 'Joined', 'dying keeps the friend connected');
  assert.equal(await guest.eval('String(window.omw.state.worldClosed||"")'), '', 'dying does not send the friend home');
  await host.waitFor(`${puppetOf(guestId)}.dead !== true`, STEP, 'the host sees the friend get up');
  assert.match(gwLog(), /respawn\.sent.*where_they_fell|where_they_fell.*respawn\.sent/, 'the world logged the respawn under the stock rule');
  ctx.log(`ok: the friend drowned at z=${fell.z.toFixed(0)} and respawned`);

  // RELOG (F5): the page reloads, the parked resume token rejoins the same world.
  await guest.eval('setTimeout(function(){ location.reload(); }, 50); "reloading"');
  await awaitInWorld(ctx, guest, 'the friend after F5');
  assert.equal(await guest.eval('String(window.omw.state.worldHost||"")'), HOST_HANDLE, "F5 came back into the host's world");
  await host.waitFor(`${rowOf(GUEST_HANDLE)}.id !== undefined`, STEP, 'the host sees the friend back');
  const guestId2 = String(await guest.eval('window.omw.state.playerId'));
  ctx.log(`ok: F5 relog (player id ${guestId} -> ${guestId2})`);

  // THE HOST BLIPS AND RETURNS INSIDE THE GRACE. The transport drops (a wifi blip); the
  // client's own redial brings the host back in seconds, well inside the 90 s grace, so the
  // friend is never sent home. A full page reload cannot fit inside the grace on a
  // SwiftShader box, which is why the blip is the transport and not the tab.
  const dropped = Date.now();
  await host.cmd('netdrop');
  await guest.waitFor('String(window.omw.state.lastChatLine||"").toLowerCase().indexOf("host has disconnected") >= 0', STEP, 'the friend is told the host dropped');
  await host.waitFor('window.omw.state.state === "Joined" && Number(window.omw.state.reconnectTotal||0) > 0', 120_000, 'the host redialled and rejoined');
  assert.ok(Date.now() - dropped < 90_000, `the host came back inside the grace (${((Date.now() - dropped) / 1000).toFixed(0)} s)`);
  assert.match(gwLog(), /world\.owner_left/, 'the world armed the grace');
  assert.doesNotMatch(gwLog(), /world\.owner_gone/, 'the grace never expired');
  assert.equal(await guest.eval('String(window.omw.state.worldClosed||"")'), '', 'the friend stayed');
  await guest.waitFor(`${rowOf(HOST_HANDLE)}.id !== undefined`, STEP, 'the friend sees the host again');
  ctx.log(`ok: the host dropped and was back in ${((Date.now() - dropped) / 1000).toFixed(0)} s`);

  // BOTH EXIT, the friend first (a deliberate leave), then the host (the world closes).
  await guest.eval('window.__omwExitToLauncher(); "bye"');
  await guest.waitFor(`/launcher\\.html$/.test(location.pathname) && ${shown('cs-bd')}`, 60_000, 'the friend is back on the tiles');
  await host.waitFor(`${rowOf(GUEST_HANDLE)}.id === undefined`, STEP, 'the host sees the friend leave');
  await host.eval('window.__omwExitToLauncher(); "bye"');
  await host.waitFor(`/launcher\\.html$/.test(location.pathname) && ${shown('cs-bd')}`, 60_000, 'the host is back on the tiles');
  await host.waitFor("document.querySelectorAll('.cs-tile:not(.new)').length === 1", STEP, "the host's character is on the tiles for next time");
  const by = Date.now() + STEP;
  let empty = false;
  while (Date.now() < by && !empty) {
    empty = (await api.get('/games')).body.games.every((g) => !g.up || g.playerCount === 0);
    if (!empty) await ctx.sleep(1_000);
  }
  assert.ok(empty, 'every world is empty after both exits');
  assert.match(gwLog(), /world\.owner_leaving/, "the host's exit closed the world on purpose, not by grace");

  // ===================================================================== 7. THE LOG
  phase(7, 'nothing in the server log a stranger would have to google');
  const log = gwLog() + '\n' + (existsSync(join(dataDir, 'logs', 'server.log')) ? readFileSync(join(dataDir, 'logs', 'server.log'), 'utf8') : '');
  for (const bad of [/BAD_[A-Z_]+/, /conn\.cell_change_refused/, /simpeer\.crashed/, /players\.flush_failed/, /server\.setup_mode/, /gateway\.crash/, /world\.crashloop/]) {
    const m = log.match(bad);
    assert.ok(!m, `the server log carries ${bad}: ${log.split('\n').find((l) => bad.test(l))}`);
  }
  for (const c of [host, guest]) assert.equal(c.luaErrors().length, 0, `${c.name}: Lua errors:\n${c.luaErrors().slice(0, 5).join('\n')}`);
  ctx.log('PASS: a stranger can host this -- empty dir, wizard, restart, launcher sign-in, a session with a friend, clean logs');
}
