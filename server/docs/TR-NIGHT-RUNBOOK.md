# TR night runbook (2026-09-15 build)

What the operator does, in order, to take `test/posture-seen` to prod and play Tamriel Rebuilt
with a friend. Every item points at the backlog row that explains it.

## 0. Gate

- Jenkins `openmw-web-dev` sweep on the tip is green (or every red is a known open row).
  The last sweep before the merge is the one that counts; the engine and the peer are baked
  from the branch there, prod bakes them again from `ovhcloud`.
- `cd server && npm test` on the tip; the same suite runs inside the tier2 image build.

## 1. Merge and deploy

1. PR `test/posture-seen` → `main`, `gh pr merge --rebase --delete-branch`.
2. On the VPS, before pushing: `docker tag morrowind:ovh morrowind:prev && docker tag openmw-mp:ovh openmw-mp:prev`
   (rollback = `sed -i s/:ovh/:prev/` in the two compose files + `up -d`, minutes not 70). (#376)
3. Fast-forward **`ovhcloud`** to `main` — that is the deploy trigger; `main` alone deploys
   nothing. Then `dev` and `multiplayer912026`. (#376)
4. Both Actions runs serialise on one runner (~35 min each, undefined order). The hello is
   **proto 3** now (#375): a client on the old engine gets `BAD_PROTO` until deploy-ovh lands,
   a new client on the old server the same. Wait for both before inviting anyone.

## 2. Prod config (`/opt/openmw-mp/data/config.toml`)

| key | set to | why |
|---|---|---|
| `[setup] deliveryModel` | `"serve"` | TR reaches a browser only on the hosted-data path; the locker refuses non-retail files. The container Caddy proxies `/mwdata/*` now (#374). |
| `[limits] trustCloudflareIp` | `true` **only after** the origin is firewalled to Cloudflare ranges | otherwise every player shares the edge IP (one login budget, one household). Without a firewall a direct hit forges its address (#377). |
| `[simPeer] startTimeoutMs` | leave unset (default 300000) | a TR peer cold-starts in minutes; an old override of 120000 SIGKILLs it mid-load (#177). |
| `[notify] events` | if overridden, merge the new persistence events in | an override replaces the default list (#192). |
| `[content] enforce` | `"names"` | `strict` now works for server-served plugins but locker clients send no hash (#299). |
| `[sharing] crime` | default `false` | a guest's guards hunt the guest; the host is not arrested for a guest's theft (#353). |

`[rules] respawnCellKey` defaults to `""` = where you fell, no warning (#355).

## 3. Data

1. Upload Morrowind + Tribunal + Bloodmoon over the LAN/SSH dashboard, never through
   Cloudflare (100 MB body cap, 100 s origin timeout, #175). Keep both expansions enabled:
   TR_Mainland masters them (#128).
2. Install Tamriel_Data first, then TR (either order is reordered by masters, #118). The
   installer packs 54k loose files into `<slug>.bsa` (split past 4 GiB, #120/#176) and needs
   ~4× the extracted size free transiently. The MP image has 7z (#170).
3. Mods are a **platform** page on the multiplayer server now (#378) — no game needs to be
   open. Rolling restart after the installs; a TR peer takes minutes, the page shows a
   "world still starting" banner past 30 s (#274).
4. Verify in the logs: `content.authoritative` lists `TR_Mainland.esm`; no `mods.missing_master`.

## 4. Accounts

- Create the friend in Accounts → Add someone (role player). Set their password from the row
  (#379). Both pick a public username on first launcher login (#180).
- Both open `https://<host>/launcher.html` (prod: `?experimental=1` on the first visit shows
  the MP tile). Host: in-game (O) panel → Party. Guest: launcher "friends playing now" → join.

## 5. What to watch (`journalctl CONTAINER_NAME=openmw-mp -f`)

Good: `world.spawned`, `simpeer.ready`, `player.cell_change` ×2 with the same `cellKey`,
`content.authoritative` with TR.

Rollback triggers: `simpeer.crashed` / `simpeer.crash_loop` / `cells_unsimulated` within 5 min
of a join; `BAD_CONTENT` on a client that has the server's files; `players.flush_failed`;
`world.crashed`; `conn.cell_change_refused` storms on legitimate play (#361's bound: a
same-cell jump over 1024 u without a door/cast in the last 5 s is refused).

## 6. Known open rows worth knowing on the night

- #100 fall damage on the avatar (three sweeps red; a peer probe in this build names it).
- #183 s114 client silence after a snap (harness only so far).
- #265 two anchored interiors share one physics world (enter shop A then B within 60 s:
  NPCs in A collide with B's walls) — unanchor interiors faster if it shows.
- #315 custom records are per deployment now; items minted BEFORE this build in a prod
  world's `records.db` are not migrated (their ids collide by construction).
- #366 a guest's dialogue-driven quest writes are accepted; a guest's script-driven ones are
  relay-only unless they hold a dialogue lock — a TR quest advanced by a guest's global script
  timer will not persist.
