# Admin commands

<!-- Generated from ADMIN_COMMANDS in server/src/core/admin.ts by
     server/test/admin-commands-doc.ts. Do not edit; run `npm run docs:admin` in server/. -->

There are no in-game commands: since 1.3.1 a chat line starting with `/` is ordinary chat.
Operators run these from the dashboard, on a game's **Players & commands** page. The forms there
cover the common ones; the **Anything else** box at the bottom takes any line below (the leading
`/` is optional), and `help` lists what your rank may run. Every command goes through the same
rank check and leaves an audit line in the server log.

## Ranks

Each command needs a minimum rank. The dashboard runs your commands at a rank set by your
dashboard role: **moderator** runs at rank 2, **owner** at rank 3, and a viewer cannot open the
page. A player's own account rank still protects them: nobody can kick, ban or IP-ban someone
who outranks them.

| Rank | Name |
|---|---|
| 0 | player |
| 1 | moderator |
| 2 | admin |
| 3 | owner |

## Commands

| Command | Minimum rank | What it does |
|---|---|---|
| `/help` | 0 (player) | list the commands your rank permits |
| `/list` | 0 (player) | list players in world with id, rank and cell |
| `/motd [text]` | 0 (player) | show the message of the day, or set it (rank 2) |
| `/reports [n]` | 1 (moderator) | list the most recent player reports (moderator) |
| `/quest [player] \| /quest set <player> <questId> <index>` | 0 (player) | inspect quest state, or (moderator) force a stage when a quest is stuck |
| `/chatlog <player> [minutes]` | 1 (moderator) | read one player's recent chat (moderator) |
| `/kick <player> [reason]` | 1 (moderator) | disconnect a player (they may reconnect) |
| `/tp <player>` | 1 (moderator) | teleport a player to you |
| `/tpto <player>` | 1 (moderator) | teleport yourself to a player |
| `/give <player> <recordId> [count]` | 2 (admin) | add an item to a player's inventory |
| `/ban <account> [reason]` | 2 (admin) | ban an account (kicks them if online) |
| `/unban <account\|ip>` | 2 (admin) | lift an account or IP ban |
| `/ipban <player\|ip> [reason]` | 2 (admin) | ban the address of an online player, or a literal IP |
| `/setrank <account> <0-3>` | 3 (owner) | set an account rank (owner only) |
| `/console <player> <script>` | 3 (owner) | run a script on a player's client (owner only) |

## Notes

- `/tp` and `/tpto` move your own character, so they only work while your account is also in
  the world.
- `/console` can be switched off with `[admin] allowConsole = false`; every use logs the full
  script.
- Mute, unmute, broadcast, cell reset and setting the respawn point are buttons on the same page
  with no command form. Cell reset and the respawn point are owner-only.
