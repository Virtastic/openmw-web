# Changelog

Notable changes to OpenMW-Web. Dates are release dates, newest first.

## Unreleased

**Setting a server up no longer involves a terminal.** `./setup.sh` starts the stack and opens
a browser, and everything after that is a wizard: the administrator account, single player or
multiplayer, how people sign in, who may register, which edition of Morrowind this is, whether
players bring their own copy or the server hands one out, how the server is reached, where
uploads are stored, and the game files themselves. Answers are written to the same
configuration a hand-editor would have produced, and every one of them can be changed
afterwards from Settings. A server set up from outside its own network is additionally asked
for a setup key, printed at startup and saved to the data folder, so the first stranger to find
`/admin` cannot claim it; from your own machine or LAN you are never asked.

**The unfinished answers are shown, greyed out, and off until you ask for them.** Multiplayer,
handing the game files out from this server, and keeping players' files in S3 are each real and
each rough, and each was previously offered in the wizard beside answers that have been
exercised for months. They are now disabled by default and marked experimental, with
`OMW_EXPERIMENTAL=multiplayer,s3` (or `all`) turning on whichever you want. They are shown
rather than hidden on purpose: an operator who came here for multiplayer and finds no mention
of it concludes they have the wrong software, where a greyed tile naming the variable answers
the question they actually have. Only a **new** setup is affected; a server already configured
for any of them keeps running, and the server refuses a gated answer even when it is submitted
without the page.

**A server can be reached over plain HTTP on a port you choose.** The hosting question used to
assume the internet. Answering "internal or behind your own proxy" now takes a port number and
configures the bundled proxy for plain HTTP, which is what a home network, a LAN party, a
tunnel, or your own reverse proxy in front actually wants. The page says plainly which browsers
will refuse that: the engine needs shared memory, which browsers grant only on a secure origin,
so `http://localhost` is fine and `http://` to an IP or a machine name is not.

**Mods install from the dashboard, in an order you control.** Drop a `.zip` or a `.7z` in and
the server reads what is inside it, shows you the data folders it found with their plugins and
asset directories, and installs the ones you tick, each into its own folder. There is a list
with the mods in load order: drag to reorder, switch one off without removing it, untick a
single plugin to keep a mod's assets and skip its plugin, or remove it entirely. Nexus has no
packaging standard, so a download routinely carries a core install plus optional extras;
installing all of them silently is how a game ends up broken somewhere far from the mod that
did it.

**The dashboard says what overwrites what, while you are dragging.** Two mods providing the
same file is normal and usually deliberate, and OpenMW's rule is that the one later in the list
wins. Each mod now carries badges for how many files it replaces and how many of its own are
overridden, with the pairs spelled out per mod, and they are recomputed as the list moves
rather than describing the order the page was loaded with. A plugin whose master is not loaded
is called out separately and in red, because that one is not a preference: the engine aborts at
startup and the player sees a black screen.

**Tamriel Rebuilt has a setup path of its own.** It is a separate download from the game, in
two archives (the landmass and its assets), and neither is part of a `Data Files` folder, so
choosing that edition previously left a server that reported itself complete and ran plain
Morrowind. The wizard now asks for the archives, and identifies which release they are by the
SHA-256 of the file rather than its name, because release names vary and every browser and chat
client renames a download. A release the table has not been told about installs exactly the
same and says so; refusing anything newer than a hard-coded list would be worse than not naming
it. A plugin missing its master is reported by name, which is what catches the assets archive
being forgotten.

**Archives up to 100,000 files are accepted, and big uploads are not cut off.** The reader
stopped at 20,000 entries, which is under half of Tamriel Data; a listing too large to read was
silently truncated, so an archive could install looking complete with its last files missing;
and Node's five-minute request cap aborted any upload slower than that, which on a 2.7 GB
archive is most connections that are not localhost. All three are fixed, and the guard against
a client dribbling headers forever is untouched.

**An operator can see, export and import a player's savegames.** Support for "my save is gone"
previously meant shell access to the storage backend. Saves are listed per account with their
sizes and dates, downloadable as a file, and restorable by upload, with the quota enforced on
the way in.

**Streamed game data stops being re-downloaded every session.** The engine reads its data in
chunks over HTTP Range, and browsers do not put range responses in the ordinary HTTP cache, so
roughly 300 MB was fetched again on every boot no matter what the server's cache headers said.
Chunks now persist in the Cache API, keyed so that a re-signed storage URL still hits and a
replaced file does not.

**The public world stops leaking items into real characters.** It is a social lobby with no
quest progress and no stakes, but inventory persisted straight out of it — and quest items
never deplete from a container, so any number of strangers could each take the same artifact
and keep it forever. The guard that was supposed to prevent this claimed the lobby was safe
because its cells reset; no cells were configured to reset, so nothing did. The lobby now
persists nothing at all: you arrive with your gear, play, and leave with exactly what you had,
losses included. A reconnect inside the resume window still puts you back where you were.

**Multiplayer capacity is governed by measured memory, not by a count.** Every occupied world
runs its own headless simulation peer, so worlds multiply that cost rather than sharing it. The
gateway had a cap derived from the player limit — 256 worlds against a container sized for
about two — on the explicit reasoning that peers were capped separately, which was the opposite
of the truth. There is now a memory budget (`[worlds] memBudgetMb`), the binding ceiling is
logged at boot and reported on `/healthz`, and a player who cannot get in is told the server
is full instead of being left retrying. The per-world cost it divides by was measured on a real
Linux container with real game data — 623 MB, against the 780 MB previously assumed from two
figures in comments.

**Party difficulty scaling is off by default.** Scaling enemies to the party is something a
group can now choose rather than something that happens to them; friends mostly want to play
Morrowind together, not to have it quietly made harder.

**Dying near your friends puts you back near your friends.** Death respawned every player at a
fixed pair of coordinates that were only ever meant as a demo placeholder — a spot outside Seyda
Neen, wherever in Vvardenfell you actually died. A party member who fell in a Telvanni tower was
sent across the map and the session was effectively over for them. You now come back beside a
living party member if there is one, at the operator's configured point if they set one, and
otherwise where you fell; and the rest of the party is told you went down instead of silently
losing you. An operator who leaves the placeholder configured on a real world is now warned at
startup rather than discovering it through a player.

**Party settings stop lying about themselves.** The leader could toggle gold splitting and rare-item
rolls, but the update sent to everyone afterwards carried none of those values — so each client
kept rendering whatever it had assumed at join, the buttons showed the wrong state, and toggling
one appeared to do nothing. The settings now travel with the update, difficulty scaling is a
button beside the others rather than a server-only setting, and the result of a rare-item roll is
announced to the party instead of being resolved in silence.

**Attacks are always forwarded when the target can be addressed.** In multiplayer the attacker's
own client cancels its local damage and forwards the raw attack to whoever owns the target, so
anything that then declines to send does not lose a message, it loses the whole swing — no
damage, no miss, no sound. The client used to decline whenever it did not know the target cell's
authority "epoch", a condition the server had long since stopped caring about: it checks that
number only when one is offered, and otherwise proves you were there by how close you stood. The
client now matches that.

Being straight about what this does and does not fix: the case it closes is narrower than it
first appeared. A creature only becomes a remote-controlled puppet in a place whose epoch your
game has already been told, because both arrive in the same message — so the gap is real but
narrow, mostly a creature that has since wandered across a boundary. It is not the explanation
for an attack going nowhere against something standing in front of you.

**Fixed: creatures that would not fight, and one frozen mid-swing.** Away from wherever the
world's simulator happened to be standing, nothing thought at all: creatures never noticed you,
never attacked, and anything already swinging stopped where it was. The engine only runs a
creature's mind if it is close to the player — and on the machine that simulates a shared world
the "player" is that machine's own idle stand-in, parked in one spot. Everyone else's
surroundings were outside the radius, which is under one map square wide. The check now measures
to the nearest place the world is actually being simulated, which is what the matching visibility
check had always done; single-player is unchanged, because there is only ever one such place and
it is you.

**Fixed: the weather forgot itself every time you loaded.** A region's weather is meant to carry
on where it left off — the server stores it when nobody is left in the region and hands it back to
the next person who arrives. It was handing it back correctly and the game was throwing it away.
Whoever is in charge of a region ignores incoming weather for it, so that their own broadcast does
not echo back onto them; the handback arrives a moment after you are put in charge, so it looked
exactly like an echo. Playing alone, that meant every session began by rolling fresh weather and
discarding whatever the world had before.

**Spells work in multiplayer.** They never did. Casting anything harmful at a creature or another
player simply had no effect: your own game worked out the damage and applied it to its local copy
of them, nobody else was ever told, and the health you saw drop sprang back a moment later. Every
mage was playing alone.

The reason was a quiet asymmetry. When you hit something with a weapon the engine asks the game's
own scripts to apply the damage, which is the moment multiplayer uses to send it to whoever is in
charge of the target. Magic is applied by the engine itself with nothing to intercept, so there
was no such moment — and simply adding one would have made it worse, applying the damage twice.
The engine now asks, before it applies harmful magic, whether the target is somebody else's to
damage; if it is, it holds off and hands the effect to multiplayer to deliver. Single-player is
untouched.

A second fault was hiding behind the first: the code that applies an incoming spell on the
receiving side counted its effects from one where the engine counts from zero, so it would have
failed on every spell it was ever given. Nothing had ever given it one, so nobody found out.

**Attacks no longer vanish when the world is between simulators.** An area whose simulation has
momentarily gone — one restarting, or one that has not picked the area up yet — used to swallow
every attack made into it, and because your own game gives up its copy of the damage the instant
it sends, that cost you the whole swing rather than a message. Those attacks are now held for a
few seconds and land as soon as the area is being simulated again, so a restart is a moment of
lag rather than a run of attacks that did nothing. They are held in strictly bounded numbers and
only briefly: past a few seconds the fight has moved on, and landing an old blow is worse than
admitting it missed.

**Attacks the world genuinely cannot accept still say so.** That case — where the area you are fighting in
has no simulator at that moment, because one is restarting or has not picked the area up yet — is
the one most likely to look like "my hits do not register". The server discards the attack, and
it used to say nothing at all to the person who threw it, who had already lost the damage
locally. They are now told, once, in plain words. Reasons that are really about cheating stay
silent, because telling a client which check it tripped only helps it tune.

Combat events the server discards are also counted now, by reason. Every one of them is an attack
a player made that did nothing, and until now an operator asked about it had only scattered log
lines to answer with.

**Fixed: two things the server said that the game never passed on.** An event the server sends
and the client has no handler for is not an error anywhere — it arrives, matches nothing, and is
dropped in silence, so the feature looks unbuilt while the server half is finished and tested.
Resting or waiting where the world does not allow it now says so, instead of the bed simply
doing nothing and being pressed again — which matters more than it used to, because the shared
world no longer lets anyone skip time at all. And being removed from a party, or having it
disband because the leader left, is now something you are told rather than something you notice.

**Fixed: the WebAssembly engine died on every boot, in the settings window.** It got as far as
loading Morrowind, starting physics and bringing up the renderer, then stopped with a bare
"null function" and no message. The cause was localisation, not graphics: the build linked
Unicode support against a placeholder data package and never supplied the real one, so the
library that formats text had no locale data at all. Asked to put a number into a slider label —
which happens while the settings window is being built, on every start — it fetched a number
formatter, got nothing back, and called into it anyway. The data package the toolchain already
ships is now included and pointed at before anything formats a message. Two other explanations
were tested first and both were wrong; the graphics one was ruled out by reproducing the crash
identically on a completely different graphics backend, and the fault was finally reproduced in
a twelve-line program with no game engine involved at all.

**Fixed: loot that quietly went missing.** When two people reach for the same item, the loser's
game takes the item back out of their inventory — correctly, because they never got it. It said
nothing while doing so, which looks exactly like the game eating your loot. Every reason the
server can refuse a container action is now a sentence, including the one that matters most: with
party loot rolls turned on, grabbing a rare item is *supposed* to refuse and start a roll
instead, so the most interesting thing that feature does used to be indistinguishable from a bug.

**Attacks that the world could not accept now say so.** Where the server discards a hit because
the area is not being simulated at that moment — a simulation peer restarting, or one that has
not picked the area up yet — the attacker is told, once, rather than swinging into silence.
Reasons that are really about cheating are still not reported, because telling a client which
check it tripped only helps it tune.

**The social menu speaks English.** Every social action answers with a protocol code, and the
game showed you the code: inviting somebody who already had a party popped up "PartyInvite:
already_in_party", and an invite that *worked* read "PartyInvite: ok". Each of the twenty
actions now says what happened in a sentence. One code needed care rather than a lookup table —
"already in a party" is a fact about *them* when you invite and about *you* when you accept, so
sharing one sentence between the two would have made one of them false. WebRTC voice signalling
stopped narrating itself at the player entirely; a dropped offer because someone left the party
is routine, and it was interrupting the game to say so.

**The shared world has lobby rules.** Nobody can rest and fast-forward the clock for everyone
else, and PvP is on in the wilderness so there is something to do besides chat — towns, shops
and guildhalls stay places you can stand still in, and party members still cannot hit each
other. Self-hosted servers are unaffected: these apply only to the gateway's public world, and
only where the operator has not stated otherwise.

**Fair play.** An engine build can now be pinned by the operator instead of being adopted from
whoever connects first, and a client that declines to identify itself is no longer waved
through the check meant to stop it. In the public world, sustained impossible movement within a
cell stops being relayed rather than merely counted — travelling between cells is still taken on
trust, because the server has no way to tell a real door from an invented one. Drop conservation became enforceable — clients report
what they pick up as it happens, closing the timing gap that made "you cannot drop what you do
not have" unanswerable — though it stays off by default until it has been exercised against a
real engine.

**The public world tidies up after itself.** Anything strangers drop there used to stay on the
ground forever, so its saved state only ever grew and every new arrival paid to download the
accumulated rubbish. Cells that have collected something are now reset on a schedule, skipping
any a player is standing in. This is only safe because nothing in the lobby is permanent — an
item on its floor could never have become anyone's property.

**Fixed: the WebAssembly dependency stack could not be built from a clean checkout.** Eight
separate faults, each hiding the next — a missing build tool, a graphics library whose headers
were never copied, plugin targets that only built when something else had already failed, a
video library rejected as "too old" because nothing could read its version, and an audio library
rejected as too old when it was in fact eleven years newer than required. The scripts now work
end to end, which as far as we can tell they never had.

**Fixed: none of the build scripts ran on a Windows checkout.** Sixteen shell scripts and the
OpenSceneGraph patch were stored with Windows line endings, which makes a shell script fail with
an unhelpful error about an invalid option and makes the patch fail to apply at all — so the
WebAssembly dependency stack simply could not be built there, and the error pointed at the patch
rather than at the checkout. Line endings are now pinned for scripts and patches.

**Fixed: the multiplayer server image could not be built on an ordinary machine.** It let the
compiler use every core, which on a normal amount of memory runs the machine out of RAM — and
it shows up as the build silently stopping partway through rather than as an error. Build
parallelism is now capped and configurable.

**A restart no longer throws everyone out.** The server has always told its players it was
shutting down before closing their connection — but the client treated that as fatal and dropped
them into an error screen they could only escape by reloading. So every deploy ejected everyone,
and the rolling-restart machinery built to prevent exactly that had no way of helping. The
client now waits for the world to come back and puts the player where they were, and says "the
server is restarting" instead of "connection lost".

**Operators can roll worlds without an outage.** Rolling restart existed and was tested, but
nothing could ask for it — no command, no route, no signal. `SIGHUP` to the gateway now restarts
worlds one at a time, emptiest first, waiting for each to come back before touching the next.

**Every world's metrics from one place.** Worlds listen on internal ports that nothing
publishes, so per-world numbers could not be scraped from outside the container at all. The
gateway's `/metrics` now carries them.

**Teleporting around the map is bounded.** Movement checks deliberately forgive a change of cell,
because a door genuinely is a teleport — which left declaring one as a way around them. The
server cannot tell a real door from an invented one, but it does not have to: walking is always
into a neighbouring cell and doors go through interiors, so jumping across the map is a spell, a
silt strider, or a lie. Those are rare, so the rate is now limited. Walking any distance and
using doors as often as you like are untouched.

**Fixed: the world-switch loading screen dropping and coming back.** Two paths cleared the boot
screen while the destination world was still settling, so it vanished, the music started, and
it reappeared a moment later.

**The client scripts have tests now.** The browser suite needs a built engine, which is a
maintainer artifact, so changes to the in-game Lua could sit in the tree with nothing having
executed them — and a Lua mistake does not crash the game, it quietly disables one subsystem.
`wasm-build/lua-tests/` runs the real scripts against stubbed engine APIs. It does not replace
the browser suite; it means the logic has been run.

**Fixed: `wasm-build/dev-local.sh` could not start a server.** It had not been updated for two
requirements added in 1.1.0 — a server password for the simulation peer, and a peer binary — so
it died on startup. It now writes the password it needs, and picks the entry point to match what
is on the machine: the real server when a peer binary is there, the harness server when it is
not. Without a peer it says so plainly, because NPCs genuinely do not move in that mode. It can
also run the full multi-world gateway with `--gateway`, so solo/party/public switching is
exercisable locally for the first time.

**Locker uploads over 100 MB no longer fail silently.** A configured `[locker]` S3 endpoint
with missing credentials used to fall back to filesystem storage with one info line; uploads
then rode the site origin through Cloudflare, whose free-plan 100 MB body cap rejected every
BSA and voice-pack upload at the edge — invisible in server logs, while the wizard showed a
generic failure players read as "files not genuine". The server now logs
`locker.s3_creds_missing` at error level, the production deploy fails its health gate on that
event, and `docker-compose.prod.yml` actually loads the credentials file the bring-up doc
described. The upload wizard also explains the Windows/Chromium "contains system files" folder
block (default Steam installs live in `Program Files`) instead of showing a raw error.

**File-mode lockers get an upload host that bypasses the CDN.** When the locker stores blobs
on the server's own disk, presigned URLs can now point at a dedicated unproxied hostname
(`[locker] publicBase`), so big uploads no longer have to fit through a fronting proxy's body
cap. S3 mode is unaffected and still uploads directly to object storage.

## 1.1.0

The multiplayer release. 1.0.x was a single player engine in the browser. 1.1.0 adds a hosted
multiplayer service around it, a way to bring your own copy of Morrowind with you to any
machine, and a launcher that ties the two together.

If you self host, nothing here forces you into the hosted shape. Every new subsystem is off by
default and the permissive defaults are still the shipped ones.

### Multiplayer

**Worlds.** A gateway process runs in front of many world processes and hands each player to the
right one. There is a shared public world, and every player also gets a private world of their
own that starts when they dial it and is reaped when they leave. Worlds reachable through a
single port, so a world's own port never leaves the container.

**Server authoritative NPCs.** A headless OpenMW instance, the sim peer, holds cell authority and
is the only thing that simulates actors. One peer covers every occupied cell, with interiors
anchored so a peer is not spawned per room.

**Identity.** Sign in with Google, Discord or Microsoft. Accounts are keyed on (issuer, subject)
and never on email, because providers reassign email and keying on it would hand one player's
character to another. No email scope is requested. First login picks a public handle, and your
real name is never shown.

**Characters.** Accounts own character slots. Player state is keyed per character, so your
progress follows the character and not the account.

**Social.** Friends, parties, whisper, chat with history so a room reads as inhabited, presence
that spans worlds so a friend in their own world does not read as offline, and party voice over
a WebRTC mesh scoped to the party.

**Party play.** Parties persist across worlds and across restarts. The leader can move the whole
group to another world in one action. Party difficulty scaling, and loot rules with a roll UI.

A guest in someone else's world keeps what they carry out — items, skills and levels are
theirs — but the QUEST LOG belongs to the world's owner. You advance the campaign you are
visiting, and your own story is neither moved nor spoiled by the visit.

**Quests.** Instance owned journals with the guest journal stashed and restored, durable quest
steps, non depleting quest items, and a whitelist for the quests that are safe to share.

**Moderation and fair play.** An anti cheat envelope on declared state, PvP zoning, persistent
mutes and blocks, a report flow, a web admin dashboard, and an in game console that is disabled
in multiplayer.

### Cloud locker

Upload your own Morrowind once and it streams back to you on any machine you sign in from,
including your saves. Per account isolation with no deduplication, so no player's files are ever
served to anyone else. Uploads are checked against a manifest generated from the server's own
game data and sniffed after upload, so unrelated files are refused rather than stored.

There is now a single player tile for this as well. Same account, same locker, same uploaded
files, with multiplayer simply not booting. Upload once, play anywhere, on your own.

### Savegames

Saves are stored on the server and follow your account. Multiplayer saves and cloud locker saves
are kept in separate namespaces and cannot appear in each other's load screens. The server falls
back to its own disk when no S3 bucket is configured.

### Launcher

A rebuilt front page with a tile per way in, a themed sign in modal showing every configured
provider, a first visit upload wizard with a multi file picker and an ownership gate, and help on
each tile rather than a wall of text.

### Operators

- One container image runs the gateway and the sim peer together, with the peer binary auto probed.
- Linux sim peer builds, so tier 2 is deployable.
- `simPeer` mode can be `auto`, `on` or `off`, with a start deadline.
- Bucket CORS is registered from the deployment's own origin.
- Strict content mode is real: per file SHA-256 closes the tampering hole.
- Optional CRM capture on signup.
- Development bots that hold accounts and characters, accept friend and party invites, and stand
  where players begin. Off unless enabled, and the server now says loudly at boot when they are
  running, because they register real accounts and reserve real handles.

### Security and reliability

The pre release hardening pass. Several of these were found by probing a running deployment
rather than by reading code, and are listed plainly because they were real:

- The per IP login limit was one bucket for the entire server, because the client address was
  read from the socket and behind a reverse proxy that is always the proxy. The sixth person to
  sign in within a minute was refused. Client addresses are now resolved through a single trust
  boundaried helper.
- A client could forge its own address past the proxy and get a fresh login budget, evade an IP
  ban and evade the per address connection cap. The edge now strips client supplied address
  headers, and the server trusts the gateway's stamp only from loopback. `CF-Connecting-IP` is
  ignored unless a deployment opts in with `[limits] trustCloudflareIp`.
- A private world revived after being reaped came back with no owner, which every access check
  read as "public, admit anyone". Any signed in account could enter another player's world. The
  owner is now recorded beside the world and recovered on revival, and a world that cannot be
  attributed is not started.
- The shared social database was the only store opened without a busy timeout, and it threw from
  inside a timer, which exits the process. Two populated worlds was enough to eject everyone in
  one of them.
- Two worlds booting at the same moment could both run the same migration, and the loser died at
  startup.
- The gateway had no crash handlers and left its worlds running when it died, holding the ports
  the next gateway then tried to use.
- Party membership was cached per process and never invalidated, so a member who left in one
  world stayed a member in another, kept appearing in the panel, and stayed reachable by voice.
- Inviting someone created a party of one immediately, which made the inviter uninvitable by
  anyone else if the invite was never accepted.
- A promotion or an unban could be silently rolled back by the next character mutation.
- Absurd declared inventory and level changes are now refused rather than only counted, and
  combat is bounded by a per attacker rate limit and a proximity check.

Known and deliberate: the server does not compute damage, because armour, resistances and
difficulty live in game data the server process does not load. The victim's client applies the
hit, and the server bounds shape, rate and proximity rather than truth. Position is client
authored on the same terms.

### Notes for operators upgrading

- A hosted deployment should set `[auth] requireSso = true`. It forces password login off. The
  shipped default stays permissive for self hosters, and the front door now warns at boot when
  SSO providers are configured while password login is still accepted.
- A deployment behind Cloudflare must set `[limits] trustCloudflareIp = true`. Leaving it off
  behind Cloudflare makes every player resolve to the edge address, which collapses every per IP
  limit into one global bucket. The active mode is logged at boot as `net.client_ip_mode`.

## 1.0.2 and earlier

Single player OpenMW in the browser: the engine compiled to WebAssembly, the demo content, the
rendering and performance work, and the launcher that boots it. See the git history for detail.
