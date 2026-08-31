// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// What the machine is doing: CPU, memory, disk and network for the dashboard.
//
// CGROUPS FIRST, os.* SECOND, AND THAT ORDER MATTERS. Inside a container os.totalmem() and
// os.freemem() report the HOST's memory, not the limit this container actually runs under. An
// operator with a 2 GB container on a 64 GB box would be shown 64 GB and told they had plenty
// of headroom right up until the kernel killed the process. os.cpus() has the same problem
// against a cpu quota. So every reading prefers the cgroup v2 files, which describe the real
// budget, and falls back to os.* only where there is no cgroup to read (a bare-metal install,
// macOS, Windows).
//
// RATES NEED TWO SAMPLES. CPU time and network bytes are counters, so a single reading says
// nothing; each is stored and differenced against the previous call. The first call after
// boot therefore reports no rate rather than a fabricated one.

import { statfs } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

export interface SysInfo {
  cpu: { percent: number | null; cores: number; load1: number | null };
  memory: { usedBytes: number; totalBytes: number; percent: number };
  disk: { freeBytes: number; totalBytes: number; percent: number } | null;
  network: { rxBytesPerSec: number; txBytesPerSec: number } | null;
}

/** Read a cgroup v2 file as a number. `max` (no limit) and any unreadable file yield undefined. */
async function cgroupNum(path: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    if (raw === '' || raw === 'max') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Cumulative CPU microseconds used by this cgroup, or by the whole host as a fallback. */
async function cpuMicros(): Promise<{ used: number; cores: number } | undefined> {
  const cores = cpus().length || 1;
  try {
    const stat = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
    const m = /^usage_usec (\d+)/m.exec(stat);
    if (m) {
      // A cpu.max quota is the real core budget, which may be a fraction of the host's cores.
      let budget = cores;
      try {
        const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/);
        if (quota && quota !== 'max' && period) budget = Number(quota) / Number(period);
      } catch { /* no quota: the whole machine is the budget */ }
      return { used: Number(m[1]), cores: budget > 0 ? budget : cores };
    }
  } catch { /* not cgroup v2 */ }
  // Fallback: sum the per-core times os.cpus() reports, in microseconds for one shared unit.
  let busy = 0;
  for (const c of cpus()) {
    busy += (c.times.user + c.times.nice + c.times.sys + c.times.irq) * 1000;
  }
  return { used: busy, cores };
}

/** Cumulative bytes across every interface except loopback. */
async function netBytes(): Promise<{ rx: number; tx: number } | undefined> {
  try {
    const raw = await readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || (name ?? '').trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0] ?? 0);
      tx += Number(f[8] ?? 0);
    }
    return { rx, tx };
  } catch {
    return undefined; // not Linux; the dashboard hides the card rather than inventing a zero
  }
}

/**
 * A reader with memory, because rates need a previous sample.
 *
 * One instance per server, called by the overview endpoint. Sampling more often than the
 * dashboard polls is pointless, and sampling less often is simply a longer, equally valid
 * averaging window, so there is no timer here: it measures the gap between callers.
 */
export function createSysInfo(diskPath: string): () => Promise<SysInfo> {
  let prevCpu: { used: number; at: number } | undefined;
  let prevNet: { rx: number; tx: number; at: number } | undefined;

  return async (): Promise<SysInfo> => {
    const now = Date.now();

    // --- cpu
    let percent: number | null = null;
    const c = await cpuMicros();
    let cores = c?.cores ?? (cpus().length || 1);
    if (c) {
      if (prevCpu && now > prevCpu.at) {
        const elapsedUs = (now - prevCpu.at) * 1000;
        const busyUs = c.used - prevCpu.used;
        // Clamped: a counter reset (container restart) would otherwise show a negative or
        // absurd figure, and "unknown" is the honest answer for a sample that spans one.
        const pct = (busyUs / (elapsedUs * cores)) * 100;
        percent = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
      }
      prevCpu = { used: c.used, at: now };
    }
    if (!Number.isFinite(cores) || cores <= 0) cores = cpus().length || 1;

    // --- memory
    const limit = await cgroupNum('/sys/fs/cgroup/memory.max');
    const current = await cgroupNum('/sys/fs/cgroup/memory.current');
    let usedBytes: number;
    let totalBytes: number;
    if (limit !== undefined && current !== undefined) {
      totalBytes = limit;
      usedBytes = current;
    } else if (current !== undefined) {
      // Container with no memory cap: the host's total is the real ceiling, and the cgroup
      // still gives a truer "used" for this container than host free memory would.
      totalBytes = totalmem();
      usedBytes = current;
    } else {
      totalBytes = totalmem();
      usedBytes = totalBytes - freemem();
    }

    // --- disk
    let disk: SysInfo['disk'] = null;
    try {
      const fs = await statfs(diskPath);
      const total = fs.blocks * fs.bsize;
      // bavail, not bfree: blocks reserved for root are not free space for this process.
      const free = fs.bavail * fs.bsize;
      if (total > 0) {
        disk = { freeBytes: free, totalBytes: total, percent: Math.round(((total - free) / total) * 100) };
      }
    } catch { /* unreadable mount: the card is hidden */ }

    // --- network
    let network: SysInfo['network'] = null;
    const n = await netBytes();
    if (n) {
      if (prevNet && now > prevNet.at) {
        const secs = (now - prevNet.at) / 1000;
        network = {
          rxBytesPerSec: Math.max(0, Math.round((n.rx - prevNet.rx) / secs)),
          txBytesPerSec: Math.max(0, Math.round((n.tx - prevNet.tx) / secs)),
        };
      }
      prevNet = { ...n, at: now };
    }

    // Zero on Windows, where there is no load average to report.
    const load = loadavg()[0] ?? 0;
    return {
      cpu: { percent, cores: Math.round(cores * 10) / 10, load1: load > 0 ? load : null },
      memory: {
        usedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
      },
      disk,
      network,
    };
  };
}
