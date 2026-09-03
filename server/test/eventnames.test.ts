// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// THE ENGINE OWNS THE `MP_` PREFIX. mwmp/netmanager.cpp dispatches every event-tier message
// from the server as `addGlobalEvent({ "MP_" + name, ... })`, so the server must send the BARE
// name: `sendEvent('AvatarState')` is received by a Lua handler called `MP_AvatarState`.
//
// Sending 'MP_SelfStats' therefore produced a handler lookup for `MP_MP_SelfStats`, which does
// not exist, and the event was dropped on the floor. It shipped because nothing catches it:
// TypeScript sees a string, the Lua handler exists and looks right, and the server-side tests
// read RAW wire names off a TestClient that does no prefixing at all -- so a feature whose
// events never reached a single real player had a fully green suite behind it.
//
// This is a source-text invariant rather than a behavioural test because the mistake is
// invisible at runtime on this side of the wire: the sender is happy either way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('no server-sent event name carries the MP_ prefix the engine adds itself', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      // sendEvent('MP_Foo', …) in any receiver position (peer.sendEvent, api.sendEvent, …).
      const m = /sendEvent\(\s*['"`]MP_([A-Za-z0-9_]+)['"`]/.exec(line);
      if (m) offenders.push(`${file.replace(process.cwd(), '.')}:${i + 1} sends 'MP_${m[1]}' `
        + `— send '${m[1]}'; the client handler is already MP_${m[1]}`);
    });
  }
  assert.deepEqual(offenders, [],
    'the engine prefixes MP_ on arrival, so these events reach a handler that does not exist '
    + `and are silently dropped:\n${offenders.join('\n')}`);
});
