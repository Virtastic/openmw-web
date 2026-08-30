# Testing the admin dashboard

Scratch notes for the first run-through, not documentation. Delete this file before merge.

## Start it

```bash
docker compose up -d
```

That brings up two containers: `openmw-web` (the server plus the dashboard) and
`openmw-web-caddy` (HTTPS in front of it). First start takes a few seconds.

Then open **https://localhost/admin**

Your browser will warn that the connection is not private. **That is expected** — there is
no domain configured, so Caddy serves a certificate it signed itself. Click *Advanced* →
*Proceed*. The connection is still encrypted; nothing independent vouches for the
certificate, which is what the warning means.

That is the whole start-up procedure. No key to copy, no script to run, no terminal after
the first command — the browser takes it from here.

`./setup.sh` (or `.\setup.ps1`) exists for convenience only: it checks Docker is installed
and running, warns about port clashes, waits for the server and opens the browser for you.
It is not required.

### About the setup key you will not be asked for

There is a key, and from your own machine or your own network you never see it. It is only
demanded when the first admin account is claimed from *outside* the network — a VPS over
the internet — because otherwise whoever found `/admin` first could take the server. That
operator has a shell on the box by definition, and the key is in the startup log and in
`data/setup-token`.

Worth knowing only because it explains the line in the log.

## What you should see

1. **Create your administrator account** — username and password (12+ characters).
2. **What kind of server is this?** — *Just me* skips four of the following questions;
   *Multiplayer* asks all of them.
3. *(multiplayer)* **How will players sign in?** — tick any combination.
4. *(multiplayer)* **Anyone else helping you run this?** — skippable.
5. **Which game content?** — Morrowind / + expansions / Tamriel Rebuilt.
6. **How do players get the game files?**
7. *(multiplayer)* **Reachable from the internet?**
8. *(multiplayer)* **Server name.**
9. **Where should uploads live?** — this server, or S3.
10. **Game data files** — shows which expected files are present, and lets you drag
    `.esm`/`.bsa` files straight in.
11. **Review** → *Save and restart*.

After the restart **you will be signed out** — admin sessions live in memory, so the
restart ends them. The page says so rather than dumping you on a login form with no
explanation. Sign back in and you land on the dashboard.

## Expected state on a first run

`docker compose ps` will show **openmw-web as `unhealthy`**, and that is correct. With no
Morrowind files the server cannot simulate a world, so it refuses players and reports
itself unhealthy — while still serving the dashboard so you can fix it. It would be worse
to exit, because then the page explaining the problem would be gone too.

Once real game data is in `gamedata/` and the container is restarted, it goes healthy.

## Worth poking at

- **Settings** — every section, with help under each field. The genuinely dangerous ones
  (`allowHarnessAuth`, `allowConsole`) are marked and ask before saving.
- **Game data & mods** — drag to reorder, or the ↑/↓ buttons. The three base-game masters
  are locked to the front because Morrowind requires it.
- **Players & commands** — the full in-game command set. `/tp` will tell you it only works
  from in-world, which is honest rather than faking a position.
- **My security** — two-factor with a QR code.
- **Accounts** — roles. Try demoting yourself: it refuses, because you are the only owner.
- **Maintenance & restart** — including a backup download. It warns that the archive
  contains password hashes, because it does.
- **Logs / Audit trail** — the audit view is the same stream filtered to admin actions.

## If you get stuck

```bash
docker compose logs -f openmw-web        # what the server is doing
cat data/logs/server.log                # survives crashes and restarts
docker compose down                     # stop; your data/ is kept
```

Locked out of the dashboard:

```bash
docker compose run --rm openmw-web node dist/server.mjs --data /data --admin-reset Michael
```

Prints a temporary password and clears two-factor on that account.

## Known, deliberate

- **`unhealthy` before game data is added** — see above.
- **No player-facing game client in this compose.** Building it needs a prepared toolchain
  image and a ~13 minute WebAssembly compile, so it is not part of a two-minute setup.
  Unpack a release zip into `client/` if you want to serve it from the same host, which
  multiplayer requires.
- **The dashboard is not available in gateway (multi-world) mode.** The gateway supervises
  world processes and has no world of its own to administer. That is why switching modes is
  a marker file rather than a button.
