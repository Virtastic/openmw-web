// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The memory card: page cache the kernel can drop on demand is not memory in use.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cgroupUsedBytes } from '../src/net/admin/sysinfo';

test('used memory is memory.current minus inactive_file, clamped at zero', () => {
  const stat = 'anon 400\nfile 4000\nactive_file 1000\ninactive_file 3000\n';
  assert.equal(cgroupUsedBytes(5000, stat), 2000);
  assert.equal(cgroupUsedBytes(1000, stat), 0, 'never negative across racing reads');
});

test('without memory.stat, or without the field, memory.current stands', () => {
  assert.equal(cgroupUsedBytes(5000, undefined), 5000);
  assert.equal(cgroupUsedBytes(5000, 'anon 400\n'), 5000);
  assert.equal(cgroupUsedBytes(5000, 'active_inactive_file 9\n'), 5000);
});
