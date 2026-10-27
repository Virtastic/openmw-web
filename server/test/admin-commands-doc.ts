// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Writes docs/ADMIN-COMMANDS.md from ADMIN_COMMANDS, so the page cannot drift from the table
// the server enforces. Run `npm run docs:admin`; test/admin-commands-doc.test.ts fails when
// the committed page is stale.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ADMIN_COMMANDS, RANK_NAMES } from '../src/core/admin';

export const DOC_PATH = join(import.meta.dirname, '..', '..', 'docs', 'ADMIN-COMMANDS.md');

// A `|` ends a table cell even inside a code span unless it is escaped.
const cell = (s: string) => s.replace(/\|/g, '\\|');

export function renderAdminCommandsDoc(): string {
  const ranks = Object.entries(RANK_NAMES).map(([n, name]) => `| ${n} | ${name} |`);
  const commands = Object.values(ADMIN_COMMANDS).map((spec) =>
    `| \`${cell(spec.usage)}\` | ${spec.minRank} (${RANK_NAMES[spec.minRank]}) | ${cell(spec.help)} |`);
  return `# Admin commands

<!-- Generated from ADMIN_COMMANDS in server/src/core/admin.ts by
     server/test/admin-commands-doc.ts. Do not edit; run \`npm run docs:admin\` in server/. -->

There are no in-game commands: since 1.3.1 a chat line starting with \`/\` is ordinary chat.
Operators run these from the dashboard, on a game's **Players & commands** page. The forms there
cover the common ones; the **Anything else** box at the bottom takes any line below (the leading
\`/\` is optional), and \`help\` lists what your rank may run. Every command goes through the same
rank check and leaves an audit line in the server log.

## Ranks

Each command needs a minimum rank. The dashboard runs your commands at a rank set by your
dashboard role: **moderator** runs at rank 2, **owner** at rank 3, and a viewer cannot open the
page. A player's own account rank still protects them: nobody can kick, ban or IP-ban someone
who outranks them.

| Rank | Name |
|---|---|
${ranks.join('\n')}

## Commands

| Command | Minimum rank | What it does |
|---|---|---|
${commands.join('\n')}

## Notes

- \`/tp\` and \`/tpto\` move your own character, so they only work while your account is also in
  the world.
- \`/console\` can be switched off with \`[admin] allowConsole = false\`; every use logs the full
  script.
- Mute, unmute, broadcast, cell reset and setting the respawn point are buttons on the same page
  with no command form. Cell reset and the respawn point are owner-only.
`;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  writeFileSync(DOC_PATH, renderAdminCommandsDoc());
  console.log(`wrote ${DOC_PATH}`);
}
