// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// From package.json, not a literal: the hardcoded copy sat at 1.1.0 while v1.2.0 shipped,
// so a freshly updated server kept reporting itself out of date. One source of truth, and
// the release workflow refuses a tag that does not match it. Its own module because both
// programs (a game, and the multiplayer server) show it in their dashboard footer.

import pkg from '../package.json';

export const VERSION: string = (pkg as { version: string }).version;
