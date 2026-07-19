#!/usr/bin/env node
// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Bundles the server into a single dist/server.mjs. Only @node-rs/argon2 stays external
// (native .node addon); ws's optional native accelerators are externalized so its
// try/catch require of them survives bundling.

import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'inline',
  external: ['@node-rs/argon2', 'bufferutil', 'utf-8-validate'],
  // ws is CJS and require()s node builtins; an ESM bundle needs a real require.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
