// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// docs/ADMIN-COMMANDS.md is generated from ADMIN_COMMANDS; a command added, renamed or re-ranked
// without regenerating the page fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DOC_PATH, renderAdminCommandsDoc } from './admin-commands-doc';

const skip = existsSync(DOC_PATH) ? false : 'docs/ is not part of the server image';

test('docs/ADMIN-COMMANDS.md matches the command table (npm run docs:admin)', { skip }, () => {
  assert.equal(readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n'), renderAdminCommandsDoc());
});
