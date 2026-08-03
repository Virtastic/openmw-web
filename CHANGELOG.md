# Changelog

All notable changes to openmw-web are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-03

Multiplayer. Morrowind is a single-player game, so this is not a port of anything
upstream — it is a server that owns the shared world and a client that asks it what
happened. 268 commits since 1.0.2.

Single-player is unchanged and still needs no server: the example world and the
bring-your-own-Morrowind path work exactly as they did.

### Added

- **Play together, three ways.** *Solo* is your own world. *Party* puts your group in
  one world. *Public* is a shared world with strangers in it. You switch from inside
  the game and your character comes with you — no restart, no re-picking your data.

- **The server simulates the world, not the clients.** NPCs, combat, loot and cell
  state are owned by a headless copy of the engine running server-side, holding
  authority over the cells players are actually standing in. A modified client can
  lie about its own input and gets nowhere: it cannot author what an NPC did, conjure
  an item, or vouch for its own damage.

- **Sign in with Google, Discord or Microsoft.** There is no password to phish or
  leak, because there is no password. Only `openid profile` is requested — never an
  email scope — and your public handle is a username you pick, never the name your
  provider hands over.

- **Your own game data, your own copy.** Upload your Morrowind files once to a private
  locker and stream them back on any device. Every account stores its own bytes with
  no deduplication between accounts, gated on an ownership attestation and a check of
  what actually landed. The reasoning is written down in `docs/LEGAL.md`.

- **Savegames on the server.** Sign in and your saves follow you: clear your browser,
  move to another machine, and the same game is there. The upload happens when you
  click Save and at no other time — no autosave, no background snapshots.

- **The social layer that makes a world habitable.** Friends and presence, parties
  with loot rolls, whisper, mute and block, and in-game reporting that hands a
  moderator the surrounding chat rather than a bare accusation.

- **Self-hosting a server takes an OAuth app and about ten minutes**
  (`docs/MULTIPLAYER-SETUP.md`). Object storage is optional: with no S3 bucket
  configured, lockers and savegames are stored in a folder on the server.

### Changed

- Saves now go to whichever of the three places fits how you are playing — your own
  folder, the server, or browser storage. `README.md` spells out which is which.

## [1.0.2] - 2026-07-31

Mostly about the downloadable bundle: it behaves like the live site now, it can
serve your own copy of the game, and you don't need a terminal to start it.
Nothing here changes the hosted site at morrowind.virtastic.app.

### Fixed

- **The download now opens the same chooser as the website.** It shipped with
  the data-chooser page present but unreachable, so unzipping and running it
  dropped you straight into the game with no way to pick the demo or point at
  your own Morrowind.

- **Self-hosting your own copy works with whatever you actually own.** The
  no-chooser path used to insist on both expansions *and* five pre-packed
  archives that exist in no retail install — so a normal copy of the game could
  not satisfy it, and owning only the base game failed outright. Copy your
  `Data Files` into `mwdata/` and it loads what's there: base game alone,
  expansions, mods, any combination. See `SELF_HOSTING.md`.

- A port conflict printed a Python traceback; it now says that openmw-web is
  probably already running, and how to use a different port.

### Added

- **Double-click to start** — `Start openmw-web.command` (macOS/Linux) and
  `Start openmw-web.bat` (Windows). Each checks for Python and says where to get
  it. No terminal required.
- **Your browser opens by itself** when the server starts (`OPENMW_OPEN=0` to
  skip).
- **`START-HERE.txt`** in the download: what to click, why it must be Chrome,
  and the Steam/`Program Files` gotcha.
- **Performance asset pack, included in the download.** Mesh and texture
  optimisations from the Morrowind Optimization Patch and Project Atlas, packed
  into a single archive the engine reads on demand. Measured in a Balmora
  interior: **1193 → 885 draw calls** and **9.2 ms → 7.7 ms** per frame, roughly
  a quarter off both. Interiors gain most, since they get no distant-object
  batching. It only applies to your own copy of the game; it costs nothing until
  a mesh is actually read, and `?noassets=1` turns it off.

  Credit: the Morrowind Optimization Patch contributors and the Project Atlas
  team — see `THIRD-PARTY-LICENSES.md`.

### Changed

- Game files are now streamed in chunks rather than downloaded whole into
  memory, which lowers peak memory use on the self-host path.

### Notes

`SELF_HOSTING.md` documented port 8795; the default has been 8910.

## [1.0.1] - 2026-07-27

A bug-fix release. Everything here affects displays with **fractional** scaling,
which in practice means Windows machines set to 125%, 150%, or 175% (the Windows
defaults), and anyone using browser zoom. Displays at 100% and Retina Macs were
never affected and are unchanged by this release.

### Fixed

- **The mouse cursor and your clicks now line up.** On Windows display scaling,
  clicks landed away from where the pointer was drawn, and the error grew the
  further you moved from the top-left corner. The mouse position was converted
  between coordinate spaces with integer division, which silently discarded a
  fractional scaling factor, so the pointer you saw (drawn by the browser) and
  the position the game used had drifted apart.

- **The game no longer renders far more pixels than it was asked to.** On a
  125% display the engine was rendering 1.56x the intended pixel count, and at
  150% it was 2.25x. This cost framerate for no visual benefit. Windows HiDPI
  users should see a straightforward performance improvement.

- **Menus and HUD are the correct size** on fractionally-scaled displays. The
  interface was being laid out against the wrong screen ratio and drawn smaller
  than intended.

- **Camera look sensitivity is correct** on those same displays. Mouse-look was
  scaled by the same faulty factor.

- **Mouse-wheel events no longer report a doubled cursor position.** A latent
  bug that could not show up while the scaling factor was 1.

- **Zooming the browser below 100% no longer risks a divide-by-zero** in the
  window-sizing and input paths.

### Notes

Verified across device pixel ratios 1.0, 1.25, 1.5, 1.75 and 2.0: the drawing
buffer now matches the requested render size at every step, and the interface
scale matches the true buffer-to-CSS ratio. Integer ratios produce numerically
identical results to 1.0.0, so Retina and 100% displays are untouched.

## [1.0.0] - 2026-07-19

First public release. The OpenMW engine cross-compiled to WebAssembly and
playable in a desktop browser.

- Play the freely-distributable OpenMW example world with no game data required.
- Bring your own legally-obtained Morrowind `Data Files` folder, streamed from
  disk on demand via the File System Access API with no upload or copy.
- Saves on the bring-your-own path are written to a real `openmw-web-saves`
  folder on disk; settings, keybindings and saves otherwise persist in the
  browser.
- Tribunal, Bloodmoon and loose mod `.esp`/`.esm`/`.bsa` files are detected and
  loaded automatically.
- Resolution scaling (Full / High / Half / Third / Quarter) renders the 3D scene
  at a fraction of native while keeping menus and text crisp.
- Self-host bundle and GPLv3 Complete Corresponding Source published with the
  release.

[1.1.0]: https://github.com/Virtastic/openmw-web/releases/tag/v1.1.0
[1.0.2]: https://github.com/Virtastic/openmw-web/releases/tag/v1.0.2
[1.0.1]: https://github.com/Virtastic/openmw-web/releases/tag/v1.0.1
[1.0.0]: https://github.com/Virtastic/openmw-web/releases/tag/v1.0.0
