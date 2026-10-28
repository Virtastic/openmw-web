// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-63: a backup of the data dir with a consistent snapshot of every SQLite database in it,
// safe to take while the server writes. Other files (chat logs, JSON stores) are copied as-is. `VACUUM INTO` copies one transaction-consistent image per DB (no
// SIGUSR1, no torn WAL trio), each copy must pass PRAGMA integrity_check, and the set is tarred
// into one archive. --ship runs an operator command on that archive to move it OFF the box
// (rclone, aws s3 cp, scp...): its credentials live in the operator's own config, never here.
//
// On success it writes <data>/backup-status.json; the server exports its age as
// omwmp_backup_age_seconds (alert at > 7200).
//
// Usage (hourly cron, inside the container or on the host):
//   node server/tools/backup-sqlite.mjs --data /data --out /data/backups \
//        [--keep 48] [--ship 'rclone copy {} offsite:openmw-backups/']
// `{}` in --ship is replaced by the archive path. Exit nonzero = no good backup this hour.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, mkdirSync, rmSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const data = resolve(opt('--data', ''));
const out = resolve(opt('--out', join(data, 'backups')));
const keep = Number(opt('--keep', '48'));
const ship = opt('--ship', '');
if (!opt('--data')) { console.error('usage: backup-sqlite.mjs --data <dir> [--out <dir>] [--keep N] [--ship <cmd {}>]'); process.exit(2); }

// gamedata is the operator's own Morrowind files; the backup dir must not back itself up.
// -wal/-shm are folded into the VACUUM INTO image, so they are not copied.
function walk(dir) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'gamedata' && resolve(p) !== out) found.push(...walk(p)); }
    else if (!/[.]db-(wal|shm|journal)$/.test(e.name) && e.name !== 'backup-status.json') found.push(p);
  }
  return found;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const stage = join(out, `snap-${stamp}`);
const archive = join(out, `sqlite-${stamp}.tar.gz`);
mkdirSync(stage, { recursive: true });
try {
  const files = walk(data);
  const dbs = files.filter((f) => f.endsWith('.db'));
  if (dbs.length === 0) throw new Error(`no .db files under ${data}`);
  for (const src of files) {
    const dst = join(stage, relative(data, src));
    mkdirSync(dirname(dst), { recursive: true });
    if (!src.endsWith('.db')) { copyFileSync(src, dst); continue; }
    const db = new DatabaseSync(src);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(dst);
    db.close();
    const snap = new DatabaseSync(dst, { readOnly: true });
    const ok = snap.prepare('PRAGMA integrity_check').get();
    snap.close();
    if (Object.values(ok)[0] !== 'ok') throw new Error(`${relative(data, src)}: integrity_check ${JSON.stringify(ok)}`);
  }
  // Relative paths: GNU tar reads "C:..." as a remote host.
  execFileSync('tar', ['czf', basename(archive), '-C', basename(stage), '.'], { cwd: out });
  if (ship) execSync(ship.replaceAll('{}', JSON.stringify(archive)), { stdio: 'inherit' });
  writeFileSync(join(data, 'backup-status.json'), JSON.stringify({ at: new Date().toISOString(), archive, dbs: dbs.length, shipped: !!ship }) + '\n');
  console.log(`backup ok: ${dbs.length} dbs -> ${archive} (${statSync(archive).size} bytes)${ship ? ', shipped' : ''}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

// Retention: newest `keep` archives stay locally; off-box retention is the bucket's lifecycle rule.
const old = readdirSync(out).filter((f) => /^sqlite-.*\.tar\.gz$/.test(f)).sort().reverse().slice(keep);
for (const f of old) rmSync(join(out, f));
