# Changelog

Notable changes to OpenMW-Web. Dates are release dates, newest first.

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
group to another world in one action. Party difficulty scaling, loot rules with a roll UI, and
quest credit shared across the party.

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
