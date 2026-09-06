#!/usr/bin/env node
// A PERSISTENT two-player gateway stack for hands-on testing, wired exactly like
// mp-scenarios/_gateway.mjs (same entry point, same flags, same world-creation calls) so what
// you click through is what the harness exercises. Runs inside the harness-peer image because
// that is where node, python3 and a headless openmw live together.
//
// Stays up until killed. Prints one URL per player plus the one console line each tab needs.
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/repo';
const DATA = '/data/mp-local';
const GW = 8931;
const PLAY = 8910;
const FRESH = process.argv.includes('--fresh');

if (FRESH && existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
mkdirSync(join(DATA, 'worlds'), { recursive: true });

// Same shape the harness writes. allowHarnessAuth is what lets ?mpauto=1 in without SSO; a
// real server refuses that path outright.
writeFileSync(join(DATA, 'config.toml'), [
  '[server]', 'motd = "local mp"', 'password = "dev-local-peer"', '',
  '[login]', 'allowHarnessAuth = true', '',
  '[gateway]', `url = "http://127.0.0.1:${GW}"`,
  'serverToken = "harness-server-credential-not-for-production"', '',
  '[rules]', 'respawnCellKey = "26,25"',
  'respawnX = 216831.0', 'respawnY = 204909.0', 'respawnZ = 513.0', '',
].join('\n'));

const kids = [];
const bye = () => { for (const k of kids) { try { k.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('SIGTERM', () => { bye(); process.exit(0); });
process.on('SIGINT', () => { bye(); process.exit(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true; }
    catch { /* not up */ }
    await sleep(300);
  }
  return false;
}

// testhost.mjs, not server.mjs: spawned worlds must boot without retail game data. Same choice
// _gateway.mjs makes, and why ?nomw works.
const gw = spawn(process.execPath, [
  join(ROOT, 'server', 'dist', 'gateway.mjs'),
  '--worlds', join(DATA, 'worlds'),
  '--shared', DATA,
  '--port', String(GW),
  '--base-port', String(GW + 200),
  '--max-worlds', '4',
  '--server-entry', join(ROOT, 'server', 'dist', 'testhost.mjs'),
], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, OMW_ALLOW_HARNESS_AUTH: '1' } });
kids.push(gw);

// 0.0.0.0, not its 127.0.0.1 default: this runs in a container and the port is PUBLISHED,
// so a loopback bind is reachable from inside the container and nowhere else.
const play = spawn('python3', ['server.py'], {
  cwd: join(ROOT, 'play'), stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, OPENMW_HOST: '0.0.0.0' },
});
kids.push(play);

if (!await waitHttp(`http://127.0.0.1:${GW}/healthz`, 60_000)) { bye(); throw new Error('gateway never came up'); }
if (!await waitHttp(`http://127.0.0.1:${PLAY}/index.html`, 30_000)) { bye(); throw new Error('play server never came up'); }

async function session(account) {
  const r = await fetch(`http://127.0.0.1:${GW}/harness/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password: 'harness-pass-1' }),
  });
  if (!r.ok) throw new Error(`no session for ${account} (${r.status})`);
  return (await r.json()).token;
}

// Each player gets their OWN world — the only kind there is, and the state two people are
// actually in before they meet. 'priv-' is the only prefix the gateway revives on dial.
async function player(account, worldId) {
  const token = await session(account);
  const mk = await fetch(`http://127.0.0.1:${GW}/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: worldId, mode: 'private' }),
  });
  if (mk.status !== 200 && mk.status !== 409) throw new Error(`${account}'s world: ${mk.status}`);
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try { if ((await (await fetch(`http://127.0.0.1:${GW}/worlds/${worldId}`)).json()).up) break; }
    catch { /* booting */ }
    await sleep(1000);
  }
  const ws = encodeURIComponent(`ws://127.0.0.1:${GW}/w/${worldId}`);
  return {
    account, worldId, token,
    url: `http://127.0.0.1:${PLAY}/index.html?nomw&skipintro=1&start=Village`
      + `&mp=${ws}&mpauto=1&mpuser=${encodeURIComponent(account)}#mphome=${ws}`,
  };
}

const host = await player('alice', 'priv-alice');
const guest = await player('bob', 'priv-bob');

const line = (p) => `window.__omwLockerToken=${JSON.stringify(p.token)};`
  + `window.__lockerHttpBase=function(){return 'http://127.0.0.1:${GW}'};'granted'`;

console.log(`
=======================================================================
  TWO PLAYERS, TWO GAMES, ONE SERVER — open each URL in its own window
=======================================================================

  ALICE (host)
  ${host.url}

  BOB (guest)
  ${guest.url}

  AFTER each page has loaded, paste its line into that tab's devtools
  console. ?mpauto skips SSO but grants no LOCKER session, and joining a
  friend's game mints a ticket with it — without this, join dies at
  "no locker session" before it touches the network.

  ALICE:  ${line(host)}

  BOB:    ${line(guest)}

  THE WALKTHROUGH (this is s95, by hand)
    1. both:   press O -> Profile, take a public handle ("alice" / "bob")
    2. alice:  O -> Friends -> add by username -> bob
    3. bob:    O -> Friends -> alice's request is THERE (it crossed worlds)
               -> accept
    4. alice:  O -> Worlds/mode -> Party (opens her game to friends)
    5. bob:    O -> Friends -> alice -> join
    6. both:   T -> chat. You are in the same world.

  NPCs stand still: no sim peer holds cell authority here. By design.
  data: ${DATA}  (--fresh resets)   docker stop omw-mp-local to end
=======================================================================
`);

await new Promise(() => {}); // stay up
