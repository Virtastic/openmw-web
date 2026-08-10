// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// SCOPE RESOLUTION FOR play/index.html. Reading a name that is not in scope throws
// ReferenceError at RUNTIME, so the page parses perfectly and dies on the first tick of
// whatever callback contains it. That has shipped three times:
//
//   - `append` and `lockerHttpBase`, block-local, called from the world-switch watcher in
//     another block: the first Public click did nothing and every click after it was swallowed
//     as a duplicate, because the latch was set before the throw.
//   - `seenNetState` / `everJoinedOnce` / `resumePointerLock`, declared nowhere at all, read
//     from noticeWatch — which runs every 150 ms — so chat stopped echoing entirely.
//   - `cachePut`, called from a SIBLING closure of the one it is declared in, inside a
//     try/catch that swallowed the ReferenceError: every uploaded file was silently
//     re-downloaded from S3 on first play.
//
// The previous version of this file reasoned about BRACE DEPTH and script blocks, and could
// not have caught the third: it skipped same-block references outright, and one block is 182 KB
// of the file's 258 KB. It also treated a name declared anywhere in the concatenated file as
// declared everywhere — the exact cross-scope case it existed to police.
//
// This walks the real scope chain instead. `typescript` is already a dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const PAGE = join(import.meta.dirname, '..', '..', 'play', 'index.html');

function scriptBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]!);
  return out;
}

// Everything the page may reference without declaring: JS builtins, the browser, and the
// globals the Emscripten glue (play/openmw.js, streamfs.js) defines with `var` at top level.
// Deliberately explicit — an allowlist that grows silently is how a checker stops checking.
const AMBIENT = new Set([
  // language
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Symbol', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'BigInt',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Atomics', 'Intl', 'escape', 'unescape',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'eval', 'arguments', 'AggregateError', 'FinalizationRegistry',
  // browser
  'window', 'document', 'location', 'navigator', 'history', 'screen', 'console', 'self', 'top',
  'parent', 'frames', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'crypto',
  'performance', 'fetch', 'Request', 'Response', 'Headers', 'FormData', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FileList', 'Image', 'Audio', 'Worker', 'WebSocket', 'XMLHttpRequest',
  'EventSource', 'AbortController', 'AbortSignal', 'MessageChannel', 'BroadcastChannel',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'requestIdleCallback', 'alert', 'confirm', 'prompt',
  'atob', 'btoa', 'structuredClone', 'getComputedStyle', 'matchMedia', 'open', 'close', 'postMessage',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'Event', 'CustomEvent', 'ErrorEvent',
  'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLInputElement', 'HTMLImageElement',
  'Node', 'NodeList', 'DOMParser', 'XMLSerializer', 'MutationObserver',
  'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream', 'AudioContext',
  'IntersectionObserver', 'ResizeObserver', 'TextEncoder', 'TextDecoder', 'CompressionStream',
  'DecompressionStream', 'ReadableStream', 'WritableStream', 'TransformStream', 'Notification',
  'CSS', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'scrollTo', 'scrollBy', 'gc',
  'WebAssembly', 'OffscreenCanvas', 'createImageBitmap', 'showOpenFilePicker', 'showDirectoryPicker',
  'showSaveFilePicker', 'reportError', 'isSecureContext', 'origin', 'name',
  // emscripten glue + the engine's own module-level vars (play/openmw.js, play/streamfs.js)
  'Module', 'FS', 'ENV', 'StreamFS', 'addRunDependency', 'removeRunDependency', 'IDBFS', 'MEMFS',
  'HEAP8', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'HEAPF32', 'HEAPF64',
  'ccall', 'cwrap', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8', '_malloc', '_free',
]);

interface Scope {
  names: Set<string>;
  parent?: Scope;
  /** var/function declarations hoist to the nearest FUNCTION scope, not the nearest block. */
  isFunction: boolean;
}

const newScope = (parent: Scope | undefined, isFunction: boolean): Scope =>
  ({ names: new Set(), parent, isFunction });

function resolves(scope: Scope | undefined, name: string): boolean {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return AMBIENT.has(name);
}

/** Every identifier bound by a binding pattern: `const {a, b: [c]} = x`, params, catch, etc. */
function bindNames(node: ts.Node | undefined, into: Set<string>): void {
  if (!node) return;
  if (ts.isIdentifier(node)) { into.add(node.text); return; }
  if (ts.isBindingElement(node)) { bindNames(node.name, into); return; }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    node.elements.forEach((e) => { if (!ts.isOmittedExpression(e)) bindNames(e, into); });
    return;
  }
  if (ts.isParameter(node)) { bindNames(node.name, into); return; }
}

function fnScope(s: Scope): Scope {
  let cur = s;
  while (!cur.isFunction && cur.parent) cur = cur.parent;
  return cur;
}

/** Collect declarations made DIRECTLY in this scope, before walking into it — JS hoists, so a
 *  function declared at the bottom of a block is callable from the top of it. */
function hoist(body: ts.Node, scope: Scope): void {
  const visit = (n: ts.Node, blockRoot: boolean): void => {
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) {
      if (n.name) scope.names.add(n.name.text);
      return; // do not descend: its body is a different scope
    }
    if (ts.isVariableStatement(n)) {
      const isVar = !(n.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
      // `var` hoists past blocks to the function scope; let/const stop at this block.
      const target = isVar ? fnScope(scope) : scope;
      n.declarationList.declarations.forEach((d) => bindNames(d.name, target.names));
      return;
    }
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return; // nested scopes handle themselves
    // `var` inside a nested BLOCK still hoists here, so keep descending through plain blocks.
    if (blockRoot || ts.isBlock(n) || ts.isIfStatement(n) || ts.isTryStatement(n)
      || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)
      || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isSwitchStatement(n)
      || ts.isCaseBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)
      || ts.isLabeledStatement(n) || ts.isCatchClause(n) || ts.isSourceFile(n)) {
      n.forEachChild((c) => visit(c, false));
    }
  };
  body.forEachChild((c) => visit(c, true));
}

/** True when this identifier is a REFERENCE that would throw if unresolved — as opposed to a
 *  property name, a label, or the declaration itself. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isShorthandPropertyAssignment(p)) return true; // {x} DOES read x
  if (ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p)
    || ts.isSetAccessor(p)) return p.name !== id;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false;
  if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)
    || ts.isClassExpression(p)) return p.name !== id;
  if (ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p)) return p.name !== id;
  if (ts.isMetaProperty(p)) return false;
  // `typeof x` never throws on an undeclared name, so it is not a defect.
  if (ts.isTypeOfExpression(p)) return false;
  return true;
}

function unresolvedIn(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const seen = new Set<string>();

  const walk = (node: ts.Node, scope: Scope): void => {
    let inner = scope;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      inner = newScope(scope, true);
      inner.names.add('arguments');
      // A named function expression can call itself by name.
      if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) {
        inner.names.add(node.name.text);
      }
      node.parameters.forEach((p) => bindNames(p, inner.names));
      if (node.body) hoist(node.body, inner);
    } else if (ts.isCatchClause(node)) {
      inner = newScope(scope, false);
      bindNames(node.variableDeclaration?.name, inner.names);
      hoist(node.block, inner);
    } else if (ts.isBlock(node) && !ts.isFunctionLike(node.parent)) {
      inner = newScope(scope, false);
      hoist(node, inner);
    } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      inner = newScope(scope, false);
      const init = ts.isForStatement(node) ? node.initializer : node.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        init.declarations.forEach((d) => bindNames(d.name, inner.names));
      }
    } else if (ts.isClassLike(node)) {
      inner = newScope(scope, false);
      if (node.name) inner.names.add(node.name.text);
    }

    if (ts.isIdentifier(node) && isReference(node) && !resolves(inner, node.text)) {
      const key = node.text;
      if (!seen.has(key)) {
        seen.add(key);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push(`${node.text} (line ${line + 1})`);
      }
    }
    node.forEachChild((c) => walk(c, inner));
  };

  const top = newScope(undefined, true);
  hoist(sf, top);
  sf.forEachChild((c) => walk(c, top));
  return out;
}

// The server image builds from server/ alone, so the page is not in that context. Skip rather
// than fail there: this guards the CLIENT page and runs wherever that page ships.
const skip = existsSync(PAGE) ? false : 'play/index.html is not in this build context';

test('every identifier in play/index.html resolves in its own scope chain', { skip }, () => {
  const blocks = scriptBlocks(readFileSync(PAGE, 'utf8'));
  assert.ok(blocks.length >= 2, 'expected several inline script blocks');

  // Script blocks share ONE global scope, and they run in order: a `var`/`function` at the top
  // level of block 1 is visible to block 2. Anything nested inside a function or a block is
  // not — that asymmetry is the whole bug class.
  const globals = newScope(undefined, true);
  for (const src of blocks) {
    hoist(ts.createSourceFile('b.js', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), globals);
  }
  for (const n of globals.names) AMBIENT.add(n);

  const offences: string[] = [];
  blocks.forEach((src, i) => {
    for (const u of unresolvedIn(src, `block${i + 1}.js`)) offences.push(`block ${i + 1}: ${u}`);
  });

  assert.deepEqual(offences, [],
    'an identifier does not resolve in its scope chain — that is a ReferenceError the moment '
    + 'the line runs, which is how the world switch, chat and the upload cache each broke '
    + 'silently. Declare it, or hoist the declaration to a scope both sites share.');
});

// A checker that cannot fail is not a checker. This proves the walk catches the exact shape
// that shipped: a helper declared inside one closure, called from a sibling closure, which is
// what `cachePut` was.
test('the checker catches a call to a sibling closure’s local', () => {
  const bad = `
    (function outer(){
      function a(){ helper(1); }
      function b(){ function helper(n){ return n; } helper(2); }
      a(); b();
    })();
  `;
  const found = unresolvedIn(bad, 'fixture.js');
  assert.deepEqual(found.map((f) => f.split(' ')[0]), ['helper']);

  // ...and does not cry wolf on the legitimate shapes the page is full of.
  const good = `
    var hoisted = 1;
    (function(){
      const { a, b: [c] } = obj();
      let d = 0;
      for (const k of list) { d += k; }
      try { d = a + c; } catch (e) { console.log(e); }
      function obj(){ return { a: 1, b: [2] }; }
      var list = [1, 2];
      return function inner(){ return hoisted + d; };
    })();
    label: for (var i = 0; i < 2; i++) { if (i) break label; }
  `;
  assert.deepEqual(unresolvedIn(good, 'fixture2.js'), []);
});
