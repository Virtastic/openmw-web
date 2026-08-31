// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Node driver for the MEMORY64 gate. See wasm-build/memory64-gate.cpp.
//
// main() answers questions 1-5 on its own and prints them. This driver answers the sixth,
// which cannot be asked from inside wasm: calling an exported function that takes a POINTER
// from JavaScript -- the play/index.html:1051-1054 clipboard path, which is the only raw
// pointer round-trip in the repo's hand-written JS.
//
// Both spellings are tried on purpose. The engine currently uses the raw-export form; under
// MEMORY64 the export takes an i64 and a JS Number throws, so the answer decides whether
// Phase 3 has to rewrite that call site or can leave it alone.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const modPath = process.argv[2];
if (!modPath) {
  console.error('usage: node memory64-gate-run.mjs <path-to-gate.js>');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const createGate = require(modPath);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${name.padEnd(28)} ${cond ? 'PASS' : 'FAIL'} ${detail}`);
  if (!cond) failures++;
};

const Module = await createGate({
  // main() runs on load; its printf output is what questions 1-5 report.
  print: (s) => console.log(s),
  printErr: (s) => console.error(s),
});

console.log('--- JS -> C++ pointer boundary ---');

// The form play/index.html:1051-1054 uses today: allocate in JS, hand the raw pointer to a
// raw export, free it. Under MEMORY64 this is the call that changes shape.
let rawWorked = false;
let rawError = '';
try {
  const p = Module.stringToNewUTF8('clip-é-raw');
  Module._gate_set_clipboard(p);
  Module._free(p);
  rawWorked = Module.ccall('gate_get_clipboard', 'string', [], []) === 'clip-é-raw';
} catch (e) {
  rawError = `(${e.constructor?.name ?? 'Error'}: ${String(e.message ?? e).slice(0, 70)})`;
}
// A raw pointer export REFUSING a JS Number is the correct MEMORY64 behaviour, not a
// failure: the export takes an i64 now. So it is reported, not counted -- what would be a
// real failure is this still working, because then play/index.html:1051-1054 has some other
// reason to break and we have not found it yet.
// Which model this build is, passed in by memory64-gate.sh. NOT probed off Module._malloc:
// emscripten generates a signature-aware wrapper for its OWN exports, so _malloc hands back a
// plain Number even under MEMORY64. That wrapper is exactly what a hand-written KEEPALIVE
// export like omw_set_clipboard does NOT get, which is the whole reason the raw call below
// breaks while _malloc/_free keep working. Told rather than guessed: an earlier version
// sniffed the filename and quietly mislabelled every build whose name it did not recognise.
const is64 = process.argv[3] !== '0';
console.log(`model                      wasm${is64 ? '64' : '32'} (from ${modPath.replace(/\\/g, '/').split('/').pop()})`);
if (is64) {
  console.log(
    `${'raw _export(ptr)'.padEnd(28)} ${rawWorked ? 'UNEXPECTED-PASS' : 'BREAKS (expected)'} ${rawError}`,
  );
  if (rawWorked) failures++; // see above: a pass here means the ABI is not what we think
} else {
  check('raw _export(ptr)', rawWorked, rawError);
}

// The form Phase 3 proposes instead: let ccall marshal the string. No malloc, no free, no
// pointer in JS at all -- which is why it is the fix regardless of how the raw form behaves.
let ccallWorked = false;
let ccallError = '';
try {
  Module.ccall('gate_set_clipboard', null, ['string'], ['clip-é-ccall']);
  ccallWorked = Module.ccall('gate_get_clipboard', 'string', [], []) === 'clip-é-ccall';
} catch (e) {
  ccallError = `(${e.constructor?.name ?? 'Error'}: ${String(e.message ?? e).slice(0, 70)})`;
}
check('ccall string arg', ccallWorked, ccallError);

// What the heap actually grew to. Read off wasmMemory, NOT Module.HEAPU8: when a heap view
// is not in EXPORTED_RUNTIME_METHODS emscripten installs a getter that calls abort(), so
// touching it to print a diagnostic takes the whole run down with a bare
// `RuntimeError: unreachable` -- which reads exactly like a wasm bug and is not one.
const buf = Module.wasmMemory?.buffer;
check('wasmMemory readable', !!buf, buf ? '' : '(not in EXPORTED_RUNTIME_METHODS)');
if (buf) {
  const gib = buf.byteLength / (1024 ** 3);
  console.log(`heap at exit               ${gib.toFixed(2)} GiB` + (buf.growable !== undefined ? ` (growable=${buf.growable})` : ''));
  console.log(`buffer kind                ${buf.constructor.name}`);
}

console.log(failures ? `--- DRIVER FAILED (${failures}) ---` : '--- DRIVER PASSED ---');
process.exit(failures ? 1 : 0);
