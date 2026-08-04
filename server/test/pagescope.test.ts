// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// SCRIPT BLOCKS DO NOT SHARE LOCALS, and one line of forgetting that killed every world
// switch. play/index.html has four inline <script> blocks. `append` (block 2, brace depth 2)
// and `lockerHttpBase` (block 2, depth 4) are block-LOCAL, not globals — so the world-switch
// watcher in block 4 threw ReferenceError before it could navigate, having already set its
// dedupe latch. Result: the first Public click did nothing and every click after it was
// swallowed as a duplicate. Silent, permanent, and invisible in the server logs.
//
// The parse check (`new Function`) that guarded this file cannot catch it: the code is
// syntactically perfect and only fails when the callback runs. This asserts the SCOPE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = join(import.meta.dirname, '..', '..', 'play', 'index.html');

function scriptBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]!);
  return out;
}

// Brace depth of a declaration. 0 = a real global other blocks may call.
function declDepth(src: string, rx: RegExp): number | null {
  const idx = src.search(rx);
  if (idx < 0) return null;
  let depth = 0, str: string | null = null, prev = '';
  for (let i = 0; i < idx; i++) {
    const c = src[i]!;
    if (str !== null) { if (c === str && prev !== '\\') str = null; }
    else if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    prev = c;
  }
  return depth;
}

const stripComments = (s: string): string =>
  s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// The server image builds from server/ alone, so the page is not in that context. Skip
// rather than fail there: this guards the CLIENT page and runs wherever that page ships.
test('no script block calls a function that is local to another block', {
  skip: existsSync(PAGE) ? false : 'play/index.html is not in this build context',
}, () => {
  const html = readFileSync(PAGE, 'utf8');
  const blocks = scriptBlocks(html);
  assert.ok(blocks.length >= 2, 'expected several inline script blocks');

  // Every function DECLARED inside a block (depth > 0) is invisible to the others.
  const blockLocal = new Map<string, number>(); // name -> owning block index
  blocks.forEach((src, i) => {
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1]!;
      const d = declDepth(src, new RegExp(`function\\s+${name}\\s*\\(`));
      if (d !== null && d > 0 && !blockLocal.has(name)) blockLocal.set(name, i);
    }
  });

  const offences: string[] = [];
  blocks.forEach((src, i) => {
    const body = stripComments(src);
    for (const [name, owner] of blockLocal) {
      if (owner === i) continue;
      // Declared here too? Then this block has its own and is fine.
      if (new RegExp(`function\\s+${name}\\s*\\(`).test(body)) continue;
      // A bare call — not window.x(), not obj.x().
      if (new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(body)) {
        offences.push(`block ${i + 1} calls ${name}(), local to block ${owner + 1}`);
      }
    }
  });

  assert.deepEqual(offences, [],
    'a block-local function is called from another script block — that is a ReferenceError '
    + 'at runtime, which is how the world switch broke silently');
});

// UNDECLARED IDENTIFIERS. `seenNetState`, `everJoinedOnce` and `resumePointerLock` were read
// and assigned in noticeWatch while being declared NOWHERE in the file. Reading an undeclared
// identifier throws, so that function died on its first tick — and it runs every 150 ms from
// the mirror poll, gated on a flag that turns true the moment chargen finishes. Everything
// after it in that callback was dead from that instant, which is why chat stopped echoing.
//
// The function-scope check above could not see this: these names are declared in no block at
// all, so they never enter its map. Same runtime-ReferenceError class, different shape.
test('no script block reads an identifier that is never declared anywhere', {
  skip: existsSync(PAGE) ? false : 'play/index.html is not in this build context',
}, () => {
  const html = readFileSync(PAGE, 'utf8');
  const blocks = scriptBlocks(html);
  const all = blocks.join('\n');

  // Names ASSIGNED bare (`x = ...`) anywhere. An assignment to an undeclared name is the
  // signature of the bug: someone meant a variable and never declared one.
  const assigned = new Set<string>();
  for (const m of all.matchAll(/(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    assigned.add(m[1]!);
  }

  const declared = (name: string): boolean =>
    new RegExp(`\\b(?:var|let|const)\\s+(?:[\\w$]+\\s*(?:=[^;\\n]*)?,\\s*)*${name}\\b`).test(all)
    || new RegExp(`function\\s+${name}\\s*\\(`).test(all)
    // a parameter of ANY function form: named, anonymous, or arrow
    || new RegExp(`function[^(]*\\([^)]*\\b${name}\\b[^)]*\\)`).test(all)
    || new RegExp(`\\(([^)]*\\b${name}\\b[^)]*)\\)\\s*=>`).test(all)
    || new RegExp(`\\bcatch\\s*\\(\\s*${name}\\b`).test(all)
    || new RegExp(`\\bfor\\s*\\(\\s*(?:var|let|const)\\s+${name}\\b`).test(all);

  // Globals the page legitimately assigns through (window.*, DOM, engine).
  const GLOBALS = new Set(['window', 'document', 'location', 'Module', 'ENV', 'self', 'globalThis']);

  const undeclared = [...assigned]
    .filter((n) => !GLOBALS.has(n) && !declared(n))
    .sort();

  assert.deepEqual(undeclared, [],
    'an identifier is assigned but never declared — reading it throws ReferenceError at '
    + 'runtime and silently kills the rest of its function');
});
