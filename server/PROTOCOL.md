# omw-mp.2 wire protocol

Authoritative contract between the browser client (C++ `mwmp/` transport + `scripts/mp/` Lua)
and the `openmw-mp` server. This file is the source of truth; both sides cite it in code
comments. Scope grows per milestone — sections are tagged with the milestone that introduces
them. Current: **M8** (M0-M7 shipped).

## Transport (M0)

- WebSocket, path `/ws`, subprotocol `omw-mp.2` (server rejects other subprotocols).
  The dot is deliberate: `/` is not a legal RFC 6455 subprotocol token character — WHATWG
  WebSocket clients throw on it before any I/O. The protocol NAME in prose stays "omw-mp/2".
- **Text frames** carry the JSON control tier: one JSON object per frame, discriminated by
  `"t"` — used **only** for the `Session*` family (debuggable in DevTools).
- **Binary frames** carry everything else: little-endian 6-byte header
  `[u16 type][u32 seq]` followed by the payload.
  - `seq` is per-sender, monotonic from 1, independent per direction. Receivers use it for
    stale-drop on movement families (M1+); for the event tier it is informational.
- Keepalive: the server sends WS protocol-level pings every 25 s (browsers auto-pong).
  App-level `SessionPing`/`SessionPong` exist for RTT/clock display (client-initiated).

## Binary type registry

| type | name | milestone |
|---|---|---|
| `0x0002` | Event | M0 |
| `0x0100` | PlayerMove (C→S) | M1 |
| `0x0101` | PlayerMoveBatch (S→C) | M1 |
| `0x0200` | ActorMoveBatch | M4 (reserved) |
| `0x0102` | PlayerInput (C→S; S→peer with u16 id prefix) | Phase 3 |
| `0x0103` | PlayerStateBatch (S→C) | Phase 3 |
| `0x0105` | AvatarMoveBatch (peer→S) | Phase 3 |

### Phase 3 input tier (`0x0102` / `0x0105` / `0x0103`)

The server (via the sim peer) is authoritative over the player's own movement. The three
types sit BESIDE the M1 movement tier, which remains the DEGRADED MODE: with no peer
holding the world, `0x0102` frames are dropped (counted) and the client-authored `0x0100`
path is authoritative again — a peer crash never freezes every player, and no switchover
signal exists or is needed (the peer-pose freshness window, 300 ms, is the whole switch).

- **`0x0102` PlayerInput (C→S, ~30 Hz).** 12-byte payload: `0` u32 seq (client-monotonic,
  echoed back as `lastInputSeq`) · `4` i8 move axis (−127..127 ≡ −1..1) · `5` i8 side axis ·
  `6` u16 yaw · `8` u8 pitch (same quantization as PlayerMove) · `9` u8 flags (bit0 run,
  bit1 sneak, bit2 jump-edge, bit3 use/attack) · `10` u16 reserved 0. Authenticated by
  CONNECTION IDENTITY — this connection owns exactly one avatar — which is deliberately a
  different check from ActorMoveBatch's holder/epoch ("may you author this cell's
  actors"); do not conflate them. Forwarded to the world peer as the same 12 bytes
  prefixed with the owning player's u16 id; a client never receives this type.
- **`0x0105` AvatarMoveBatch (peer→S, ~20 Hz).** `[u8 count]` + count × (`u16 id` +
  `u32 lastInputSeq` + 20-byte pose). The authoritative result of simulating the avatars.
  Only the world peer may send it: a client's frame is dropped and counted
  (`omwmp_avatar_batch_rejected_total{reason="not_peer"}`), the negative control mirroring
  `actor_batch_rejected{not_holder}`. Accepted poses become each player's canonical pose
  and feed the ordinary `0x0101` fan-out, so every other client renders the authoritative
  result with no second channel; while the stream is fresh a client's own `0x0100` claim
  is consumed but not applied.
- **`0x0103` PlayerStateBatch (S→C).** Same entry layout as `0x0105`. Each player receives
  their OWN entry on the broadcast tick — pose + `lastInputSeq` — which is the anchor for
  client-side reconciliation (predict + smooth blend via capped physics offsets; hard snap
  past the threshold). The local player never renders from the delayed interpolation
  buffer: `RENDER_DELAY` is for remote puppets only.

### `0x0100` PlayerMove (M1, C→S)

20-byte payload, little-endian, explicit offsets: `0` f32 x · `4` f32 y · `8` f32 z
(world units) · `12` u16 yaw (0..65535 ≡ 0..2π, wraps) · `14` u8 pitch
(0..255 ≡ −π/2..+π/2, clamped) · `15` u8 flags (bit0 run, bit1 sneak, bit2 jump-edge,
bit3 inAir, bit4 weaponDrawn, bit5 spellReady) · `16` u8 animVel (0..255 ≡ 0..2× base walk
speed, clamped) · `17` u8 counter (0 in M1) · `18-19` reserved, MUST be zero.
Sent at ~15 Hz while moving + edge-triggered (jump, stop); receivers drop any frame whose
envelope `seq` ≤ the last seen from that sender. Movement has its OWN server rate budget
(~40 msg/s) separate from the general bucket.

### `0x0101` PlayerMoveBatch (M1, S→C)

`u8 count` then `count ×` (`u16 playerId` + the 20-byte PlayerMove payload). Server
broadcasts on a 66 ms tick containing the latest pose of every VISIBLE player that moved
since the last tick. Visibility = same cell, or adjacent exterior grid cells, narrowed by
interest management (below). When a player first becomes visible (join, cell entry, or
re-entering the interest radius), the server sends their current pose in the next batch
unconditionally. Client transport decodes this in C++ and delivers ONE global Lua
event `MP_MoveBatch` whose body is an LSER array of
`{id=number, x=..., y=..., z=..., yaw=..., pitch=..., flags=..., animVel=...}`.

## Event-tier additions (M1)

| name | dir | body |
|---|---|---|
| `PlayerCellChange` | C→S, relayed S→C with `id` added | `{cellKey=string, x=number, y=number, z=number}` — `cellKey` = `"x,y"` for exteriors (comma, integers) or the lowercased interior cell name. Updates server occupancy; receivers despawn/teleport that player's puppet. |
| `PlayerLeaveView` | S→C only | `{id=number}` — that player is no longer in YOUR view. See below. |

### Interest management & LOD (M9, `0x0101` and `0x0200`)

Cell-granular visibility alone makes one busy cell an N×N pose mesh. On top of the cell
rule the server applies, **for exterior cells only** (interiors stay cell-granular):

- **Distance culling.** A peer enters your view within `[limits] interestRadius` and leaves
  it only beyond `interestRadius + interestHysteresis` — the two thresholds differ so a
  player pacing the boundary does not flicker in and out. The nearest
  `interestMinPeers` are always in view regardless of radius. `interestRadius = 0`
  disables culling.
- **Rate tiering.** Pose updates are sent at `lodNearHz` within `lodNearRadius`,
  `lodMidHz` within `lodMidRadius`, and `lodFarHz` beyond it (rounded to whole 66 ms
  ticks). `0x0200` ActorMoveBatch is tiered the same way on the recipient's distance from
  the authority holder — but it is **never culled**, so NPC puppets can't freeze.
  Rates are per-peer; a first sighting or re-entry always bypasses the tier.

**`PlayerLeaveView {id}` — required client behaviour.** Puppets are spawned on the first
`MP_MoveBatch` entry for a rostered id, so if pose sends simply stopped the peer would keep
a **ghost frozen at the boundary**. The server therefore sends exactly one
`PlayerLeaveView` to a client at the moment a player it had been receiving poses for leaves
that client's view (cull, or cell exit). On receipt the client MUST, for that `id`:

1. despawn the puppet immediately and deterministically — no stale timeout;
2. drop cached pose/interpolation state so a later re-entry starts clean;
3. **keep the roster entry** — the player is still in the world, just not visible to you.
   Only `PlayerLeaveWorld` removes them from the roster and the player list.

It is idempotent and safe for an unknown id (drop it). Re-entry needs no signal: the server
force-sends that player's pose in the next batch, which respawns the puppet through the
normal first-sighting path. `PlayerLeaveView` is never sent for a player whose pose never
actually reached that client.

**Envelope seq for the lossy binary family.** `0x0101` and `0x0200` draw their envelope
`seq` from a single server-global counter minted once per broadcast group, not from the
per-connection event counter. A recipient receives at most one frame per group, so its
socket still sees a strictly increasing `seq` and the client's shared stale-drop cursor is
unaffected — this is what lets one serialized `0x0200` frame be sent to every peer in a
cell. Clients MUST NOT assume these sequences are dense or shared with the event tier.

M1 semantics: clients MUST send `PlayerCellChange` immediately after `SessionReady` (until
then they are visible to nobody and receive no batches); the relay goes to ALL in-world
players INCLUDING the sender (ignore your own id); the server synthesizes/refreshes the
stored pose at the cell-change coordinates so never-moving players still spawn for newly
visible peers; move `seq` is strictly increasing per connection; movement bytes count
against `bytesPerSec` but not `msgsPerSec` (own `moveMsgsPerSec` budget, default 40, and a
separate `actorMoveMsgsPerSec` budget, default 60, for `ActorMoveBatch`). Exceeding either
movement budget DROPS the frame; it does not close the session. Outbound, movement and
actor batches are also dropped for a client whose send queue is over `maxBufferedBytes`, and
such a client is disconnected with `RATE` past `maxBufferedBytesHard`.

### `0x0002` Event (M0)

Payload: `[u8 nameLen][name: nameLen bytes, ASCII][body: LSER blob]`.

- `name` is the event name without any prefix (e.g. `ChatSend`). The client transport
  delivers inbound Events to Lua as global events named `MP_<name>` whose data is the raw
  `body` bytes — which are exactly the engine's `LuaUtil::serialize` format, so the Lua VM
  decodes them natively. The transport never parses `body`.
- `body` encoding ("LSER") = OpenMW's `LuaUtil::serialize`
  (`openmw/components/lua/serialization.cpp`, FORMAT_VERSION 0). The server implements a
  hardened codec for it (depth ≤ 16, node/length caps). Server-arbitrated event bodies are
  restricted to numbers/strings/booleans/nested tables (no userdata); peer-relayed bodies
  may additionally contain RefNum userdata (typeName `"o"`, 8 bytes: u32 index + i32
  contentFile).

## Session tier (JSON text frames, M0)

Flow: `CONNECTED → (Hello ≤10 s) → HELLO_OK → (auth) → AUTHED → (Ready) → IN_WORLD`.

### World modes

A world is `private` (one character's solo world) or `party` (that world opened to the
owner's **friends**, up to 32 players). There is no public world and no party membership
list: being in someone's world is the relationship, and the friends list is the only door.
Every world has an owner.

- **Movement is measured, never enforced.** Sustained implausible speed is counted as an
  anomaly for moderation. Speed is measured over a **200 ms window**, not between consecutive
  frames: frame spacing is ARRIVAL spacing, and a stalled connection delivers a burst of
  ordinary little movements milliseconds apart, which per-frame reads as an enormous speed for
  a player who did nothing wrong.

  **`PlayerCellChange` is bounded separately, and only bounded.** A cell change is a legitimate
  teleport — a door, a silt strider, Recall, Divine Intervention — so the envelope resets its
  baseline on every one, which would otherwise leave "declare a cell change" as a free teleport.
  The server ships no game data and cannot tell a real door from an invented one, but it does
  not need to: **walking is always into an ADJACENT exterior cell, and a door goes through an
  interior.** An exterior-to-exterior jump across the grid is a spell, a silt strider, or a lie,
  and those are rare in play — so `[limits] farTravelPerMin` (default 6) bounds the RATE rather
  than refusing the act. Over the limit the change is counted as an anomaly.

  This makes map-hopping useless without touching a real player: walking any distance and using
  doors any number of times are both unaffected, by construction. It is still **not** a teleport
  check — a single unearned jump inside the budget goes through. Closing that needs the sim peer
  to validate arrivals against the real cell graph, which is not built.
- **Rule floor.** `timeSkip` is `off` and PvP is on with `pvpZone = "wilderness"` unless the
  operator has stated otherwise.

None of this applies to a standalone single-world server, which defaults to `public` but is
that operator's real game.

`SessionHello` carries an optional **`simulatesActors: true`**. A client that omits it is
never granted cell actor authority — neither by election nor by claiming a dormant cell.
Authority is otherwise chosen on network fitness, and a protocol-only client (a load bot, a
headless tool) is a near-perfect RTT candidate that simulates nothing: it wins the cell and
every NPC in it freezes for everyone. A cell with no capable occupant stays **dormant**,
which is the same amount of simulation without the server believing the job is covered.

Client → server:

- `{"t":"SessionHello", "proto":1, "engineHash":"<12-hex or empty>", "lserVersion":0,
   "manifest":[{"name":"Morrowind.esm","size":123,"idx":0}, …], "resumeToken":"<opt>"}`
  **`engineHash` may only be empty under `[engine] enforce = "warn"` or `"off"`.** Under
  `"refuse"` a client that sends none is refused with `BAD_ENGINE` — an absent hash used to be
  an unconditional pass, which let anything opt out of the check by declining to identify
  itself, while still catching honest players on a stale build. `[engine] pin` additionally
  fixes the canonical build to an operator statement rather than adopting whichever client
  connects first. The **sim peer is exempt**: it is the operator's own binary, a native build
  whose hash could never equal a wasm one, and refusing it would leave every cell unsimulated
  while the server reported itself healthy.

  Manifest = the client's content files in load order (`strict` mode adds `"sha256"`,
  M0 implements `names` mode: name+size+order). Reality check: OpenMW 0.52 Lua exposes
  content-file NAMES only (`core.contentFiles.list`, lowercased) — sizes are unreachable,
  so clients always send `size:0` and `names` mode effectively compares name+order.
- `{"t":"SessionRegister", "account":"name", "password":"…", "serverPassword":"<opt>",
   "inviteCode":"<opt>"}`
- `{"t":"SessionLoginRequest", "account":"name", "password":"…", "serverPassword":"<opt>"}`
- `{"t":"SessionResume", "token":"<hex>"}` — M8 rejoin-in-place; valid in `HELLO_OK`
  instead of a Register/Login (see §Ops).
- `{"t":"SessionLoginTicket", "ticket":"<base64url>", "serverPassword":"<opt>"}` — Phase B
  SSO; valid in `HELLO_OK` instead of a Register/Login (see §Single sign-on).
- `{"t":"SessionReady"}` — after the client has applied `SessionWelcome` and is in-game.
- `{"t":"SessionPing", "clientTime":<ms>}`

Server → client:

- `{"t":"SessionHelloOk", "serverName":"…", "contentPolicy":"names|strict|off"}`
- `{"t":"SessionWelcome", "playerId":<u16>, "sessionToken":"<hex>", "motd":"…",
   "flags":{…}, "playerRecord":null, "serverSeq":<u32>}`
  (`playerRecord:null` → fresh character; non-null restore lands in M2. `serverSeq` = binary
  seq already consumed on this connection: 0 at welcome, first server Event frame is seq 1.)

  `flags` are session rules the client applies locally:

  | field | meaning |
  | --- | --- |
  | `pvp` | player-vs-player hits are relayed (M5) |
  | `difficulty` | applied client-side, in the victim's own combat pipeline |
  | `renderLod` | `"tiered"` degrades distant avatars; `"full"` simulates every avatar |
  | `lodNearRadius` / `lodMidRadius` | render tier boundaries, in world units |
  | `lodNearMaxAvatars` | hard ceiling on fully-simulated avatars; `0` = radius only |

  The render-LOD fields are sent rather than baked into the client because the client's
  scripts live inside `openmw.data` and changing a constant there costs a full relink.
  **A client that does not understand them must default to full fidelity** — the fallback
  for a missing tier is "near", never a silent degrade. They intentionally mirror the
  server's own network-LOD radii so an avatar receiving poses at 1 Hz is not also being
  asked to walk smoothly between them.
- `{"t":"SessionPong", "clientTime":<ms>, "serverTime":<ms>}`
- `{"t":"SessionDisconnect", "code":"<CODE>", "detail":"human-readable"}` then close.
  Codes: `BAD_PROTO BAD_ENGINE BAD_CONTENT AUTH_FAILED BANNED SUPERSEDED KICKED RATE
  SERVER_FULL SHUTDOWN`.

Rules: one active session per account (later login supersedes, old socket gets
`SUPERSEDED`); Hello timeout 10 s (disconnect code `BAD_PROTO`); auth attempts limited
5/min/IP; failed auth = `AUTH_FAILED` + close (retry = reconnect). Engine-hash and content
policies use adopt-first-canonical: the first player's Hello sets the reference until the
server empties (`strict` content mode is an M0 stub behaving as `names`). Join semantics:
`PlayerJoinWorld` broadcasts to everyone in-world including the joiner; `PlayerList` goes to
the joiner only; MOTD arrives both in Welcome and as a `channel:"server"` ChatMessage.
Event-body conventions: arrays = 1-based integer-keyed tables; nil fields = omitted keys.

## Event-tier messages (M0)

| name | dir | body |
|---|---|---|
| `ChatSend` | C→S | `{text=string}` — `/`-prefixed text is a command |
| `ChatMessage` | S→C | `{channel="say"\|"server"\|"whisper", from=string\|nil, fromId=u16\|nil, text=string}` |
| `PlayerJoinWorld` | S→C | `{id=u16, name=string}` |
| `PlayerLeaveWorld` | S→C | `{id=u16}` |
| `PlayerList` | S→C | `{players={{id=u16, name=string}, …}}` |

## Event-tier additions (M2)

| name | dir | body |
|---|---|---|
| `PlayerAppearance` | C→S on join/chargen-done/change; relayed S→C to ALL in-world with `id` | `{race=string, head=string, hair=string, isMale=bool, class=string, name=string}` (record-id strings from the player's own NPC record) |
| `PlayerEquipment` | C→S on change (client diffs); relayed to ALL with `id` | `{slots={[slotNumber]=recordId, …}}` — full snapshot, slot numbers per `types.Actor.EQUIPMENT_SLOT` |
| `PlayerStatsDynamic` | C→S on change (0.25 s poll, instant on death); relayed to VISIBLE with `id` | `{hp={c=number,b=number}, mp={c=,b=}, ft={c=,b=}}` (current/base) |
| `PlayerAttributes` / `PlayerSkills` | C→S on change (1 s diff) | the body IS the flat `{name=number}` map (≤64 entries, keys ≤32 chars) — no wrapper key, unlike the other bodies | 
| `PlayerLevel` | C→S on change | `{level=int 1..255}`; stored for persistence; not relayed in M2 |
| `PlayerSpellbook` | C→S `{add={id,…}, remove={id,…}}` | stored; not relayed in M2 |
| `PlayerInventory` | C→S full snapshot `{items={{id=recordId, n=count}, …}}` on change (2 s diff, cap 512 entries) | stored for rejoin restore; not relayed |
| `PlayerItemAcquired` | C→S `{id=recordId, n=count}` on every count INCREASE (0.25 s scan) | credits the item against drop conservation; SPENT by a drop that uses it, and cleared wholesale by the next `PlayerInventory`. Not stored, not relayed |
| `PlayerDeath` | C→S `{}` | server runs respawn/death-penalty plugins |
| `PlayerResurrect` | S→C `{cellKey=string, x=,y=,z=, restoreHp=bool}` | client teleports self, restores dynamic stats, clears death |

Rejoin restore (M2): `SessionWelcome.playerRecord` is non-null once the server has stored a
snapshot: `{appearance={…}, equipment={…}, inventory={…}, stats={dynamic=…, attributes=…,
skills=…, level=…}, spells={…}, position={cellKey=, x=,y=,z=}}`. The client applies it
instead of running chargen and teleports to `position`. The server flushes the player doc
on: cell change, level-up, equipment change (10 s debounce), logout, SIGTERM. Appearance
relays are the puppet-record source of truth — clients rebuild a puppet's NPC record when
an appearance arrives for an already-spawned puppet.

### Phase 4A — the peer reports avatar bars

| name | dir | body |
|---|---|---|
| `AvatarStatsBatch` | PEER→S (0.25 s, diffed per avatar) | `{entries={{id=int, hp={c=,b=}, mp={c=,b=}, ft={c=,b=}}, …}}` — dropped and ignored from any non-system sender |
| `MP_SelfStats` | S→C (owner only, per accepted entry) | `{hp={c=,b=}, mp={c=,b=}, ft={c=,b=}}` — the owner applies CURRENT values to self |

One-writer rule, same shape as the movement gate: while an accepted peer report for a
player is fresh (≤1 s), that player's own `PlayerStatsDynamic` is consumed and ignored.
A peer entry is only accepted for a player actively driving the input tier (fresh
`PlayerInput` ≤1 s) — an input-less client (old build, protocol bot, mid-outage browser)
keeps asserting its own bars, per-player degraded mode with no switchover signal. Observer
relay rides the ordinary `PlayerStatsDynamic` fan-out, so other clients need no new type.
Death in a peer report flushes the doc immediately, exactly like the client edge.

## Event-tier additions (M3) — world objects & containers

Object addressing is a tagged union in every body: `{ref=<RefNum userdata>}` for
content-file objects (portable — login enforces identical load order) or `{net=<number>}`
for runtime-spawned objects (server-issued). Clients keep local↔net maps; client-local
generated RefNums NEVER travel.

| name | dir | body |
|---|---|---|
| `ObjectSpawnRequest` | C→S | `{tempId=number, recordId=string, cellKey=string, x=,y=,z=, rotZ=number, count=number}` — count ≥1 (engine objects not yet placed report count 0; clients clamp) |
| `ObjectSpawnAck` | S→C (requester) | `{tempId=number, netId=number}` |
| `ObjectPlace` | S→C broadcast (cell-scoped visible) | `{netId=number, recordId=string, cellKey=, x=,y=,z=, rotZ=, count=, byId=u16}` |
| `ObjectDelete` | C→S; relayed cell-scoped | `{ref|net, cellKey=string}` — tombstoned in the cell doc |
| `ObjectMove` | C→S; relayed cell-scoped | `{ref|net, cellKey=, x=,y=,z=, rotZ=}` |
| `ObjectLock` | C→S; relayed cell-scoped | `{ref|net, cellKey=, lockLevel=number|nil}` (nil = unlocked) |
| `DoorState` | C→S; relayed cell-scoped | `{ref, cellKey=, open=bool}` |
| `ContainerOpen` | C→S | `{ref|net, cellKey=, contents={{id=,n=},…}|nil}` — first-opener's contents become canonical (leveled-loot roll); thereafter server state is truth |
| `ContainerState` | S→C | `{ref|net, items={{id=,n=},…}, stateSeq=number}` |
| `ContainerOpRequest` | C→S | `{ref|net, cellKey=, opId=number, op="take"\|"put", itemId=string, n=number}` |
| `ContainerOpResult` | S→C (requester) | `{opId=, ok=bool, reason=string?, stateSeq=}` |
| `ContainerUpdate` | S→C broadcast (cell-scoped) | `{ref|net, delta={itemId=, dn=number}, stateSeq=}` |
| `WorldCellState` | S→C (on PlayerCellChange + ResyncRequest) | `{cellKey=, placed={…ObjectPlace-shaped…}, deleted={refKeys}, moved={…}, locks={…}, doors={…}, containers={refKey={items,stateSeq}}}` |
| `ResyncRequest` | C→S | `{cellKey=string}` |

**Drop conservation (`ObjectSpawnRequest`).** `fromInventory=true` marks a request as a DROP
rather than a placement — scripts and tools legitimately place objects nobody carries, so
without the flag conservation cannot be enforced at all. When `[economy] refuseUnownedDrops`
is on, a drop of more than the sender is known to hold is refused (no ack, no placement);
otherwise it is counted (`omwmp_unowned_drops_total`) and fed to moderation.

"Known to hold" is the last `PlayerInventory` snapshot **plus** anything credited by
`PlayerItemAcquired` since, **minus** whatever those credits have already been spent on. Both
halves of that bookkeeping matter: a snapshot is only sent when the inventory CHANGES, and
acquire-then-drop leaves it unchanged — so without spending the credit at the point of use it
is never superseded, and one pickup funds an unlimited supply of drops.

That sum is the point. Judged on the snapshot alone the server's picture is up to 2 s stale, and
a player who picks something up and drops it immediately — ordinary play — is indistinguishable
from one dropping an item they never had. Enforcement was built on the stale picture once and
had to be backed out. Clients MUST report acquisitions for
enforcement to be safe to enable; a client that does not will have legitimate drops refused.

Semantics: the server persists per-cell delta docs (`world/cells/<cellKey>.json`) and is
the serialization point — ops are applied in server-arrival order and rebroadcast with
`stateSeq`/order intact. Containers are transactional at the server (conservation-checked;
losing racer gets `ok=false, reason="gone"`); clients may apply optimistically and MUST
reconcile to `ContainerState`/`ContainerUpdate` on reject. `refKey` string form for doc
maps: `"c:<index>:<contentFile>"` for content refs, `"n:<netId>"` for spawned.

## Actor authority & sync (M4)

The server assigns each cell a single **authority holder** — the client that simulates that
cell's NPCs/creatures. Others render them as puppets driven off the wire. NPCs/creatures are
content-file objects, addressed by RefNum userdata (`ref`), exactly like M3 content objects.

**Authority protocol** — server state `Map<cellKey, {holderId, epoch:u32, lastSnapshot}>`:

| name | dir | body |
|---|---|---|
| `ActorAuthorityGrant` | S→C | `{cellKey=string, epoch=u32, snapshot={actors={ {ref, x,y,z,rotZ, hp={c,b},mp,ft, dead=bool, ai=…}, … }}}` — apply the snapshot, THEN begin simulating |
| `ActorAuthorityRevoke` | S→C | `{cellKey=string, epoch=u32}` — stop simulating; re-attach puppets to those actors |
| `ActorAuthorityInfo` | S→C | `{cellKey=string, holderId=u16, epoch=u32}` — sent to a non-holder entering a claimed cell, and re-sent to every remaining non-holder whenever the epoch changes (handoff), so all occupants always know the live epoch |

- Claim: first client to `PlayerCellChange` into a cell with no holder gets `Grant` (epoch++).
  Contested entry: server is the single serialization point, first processed wins; the loser
  gets `ActorAuthorityInfo`. Clients MUST NOT self-start actor simulation without a Grant.
- Handoff on holder leave/disconnect: longest-present remaining occupant gets `Grant` +
  `lastSnapshot` (epoch++); empty cell → snapshot folds into the cell doc `actorOverrides`
  and is handed to the next claimant.

**Actor state** — every `Actor*` message carries `(cellKey, epoch)`; the server drops any
whose epoch ≠ the current cell epoch (kills the handoff race). Only the holder may send.

| name | dir | body / layout |
|---|---|---|
| `ActorMoveBatch` | holder→S→C (binary `0x0200`) | `[u32 epoch][u8 count]` + count × (`8-byte ref` + 20-byte pose, same pose layout as PlayerMove); server infers cell from the holder, validates epoch, relays cell-scoped |
| `ActorStatsDynamic` | holder→S→C | `{cellKey, epoch, ref, hp={c,b}, mp={c,b}, ft={c,b}}` |
| `ActorEquip` | holder→S→C | `{cellKey, epoch, ref, slots={[n]=recordId,…}}` |
| `ActorAI` | holder→S→C | `{cellKey, epoch, ref, pkg="idle"\|"wander"\|"travel"\|"follow"\|"combat", targetRef=…?}` (hint for puppet anim/facing; non-holders don't run AI) |
| `ActorDeath` | holder→S→C | `{cellKey, epoch, ref, killerPlayerId=u16?, deathNo=number}` — server dedups by (ref, deathNo), persists to `actorOverrides`, may bump kill counts |
| `ActorSnapshot` | holder→S (5 s + on death/combat-start) | `{cellKey, epoch, actors={…}}` — server stores as `lastSnapshot` for handoff/dormancy |
| `WorldKillCount` | S→C broadcast | `{refId=string, count=number}` — shared kill tally (quest-critical `GetDeadCount`); server-accumulated from `ActorDeath.killerPlayerId` attribution |

Client contract: non-holders attach `puppet.lua` to the real cell actors (`addScript` +
`enableAI(false)`) and drive them from `ActorMoveBatch`/stats/death — the SAME puppet path
as remote players, keyed by ref instead of playerId. On `Grant`, detach those puppets,
apply the snapshot, re-enable AI, and simulate. On `Revoke`/handoff, reverse it. Death is
authoritative from the holder; non-holders converge via the 5 s snapshot + stats stream.

## Combat & magic (M5)

Authority model (TES3MP-equivalent): **the attacker's client detects the hit; the victim's
client applies the damage.** For NPCs/creatures the victim's "client" is that cell's
authority holder (M4). Raw pre-mitigation damage travels; armor, difficulty, resistances
and sounds are applied exactly once, on the victim, by the engine's own untouched Lua
combat pipeline (`files/data-mw/scripts/omw/combat/local.lua`).

| name | dir | body |
|---|---|---|
| `CombatHit` | attacker→S→victim-owner | `{target={playerId=u16} \| {ref=RefNum, cellKey=, epoch=?}, damage={health=n, fatigue=n?, magicka=n?}, strength=n, sourceType=string, weaponId=string?, ammoId=string?, hitPos={x,y,z}?, successful=bool}` |
| `CombatCast` | caster→S→cell-scoped | `{spellId=string, target={playerId}\|{ref}\|nil, casterId=u16, kind="spell"\|"enchant"\|"potion"}` — visual/animation mirroring only |
| `CombatSpellHit` | caster→S→victim-owner | `{target={playerId}\|{ref,cellKey,epoch}, spellId=string, effects={{id=string, magnitude=n, duration=n}, …}, casterId=u16}` |
| `CombatProjectile` | attacker→S→cell-scoped | `{kind="arrow"\|"bolt"\|"thrown"\|"magic", recordId=string?, spellId=string?, from={x,y,z}, dir={x,y,z}, speed=n, casterId=u16}` — cosmetic mirror; the attacker owns the real projectile |

Rules:
- The server validates shape + plausibility only (finite, `damage.health` within a config
  cap, target exists) and routes: player targets → that player's session; actor targets →
  the cell's current authority holder. It never computes damage — it has no game data.
- Actor targets: `epoch` is **optional** here, unlike the holder-authored `Actor*` family.
  The attacker is usually a NON-holder, so presence is proven by proximity (the attacker's
  own cell must be visible to `target.cellKey`) and the hit is routed to whoever holds the
  cell at arrival time. When `epoch` IS supplied it must be current, so a mid-handoff hit
  cannot land on the wrong simulator. Clients may take the live epoch from
  `ActorAuthorityInfo`/`ActorAuthorityGrant`, or omit it entirely.
- **PvP gate**: when `[rules] pvp = false`, `CombatHit`/`CombatSpellHit` whose target is a
  *player* are dropped server-side (the `pvp` plugin owns this decision so operators can
  replace it). Actor targets are unaffected.
- Clients MUST cancel local damage application for remote-authoritative victims (register an
  `I.Combat` handler that forwards then `return false`) and re-emit the stock `Hit` event
  locally when they receive `CombatHit` for themselves, so the victim's own armor/difficulty
  apply. Death still flows through M2 `PlayerDeath` / M4 `ActorDeath` — combat messages never
  carry death directly.

## Quest layer (M6)

The milestone that makes retail co-op actually co-op: shared journal, vanilla script state,
factions, crime. Sharing is operator-configurable per family (`[sharing]`).

| name | dir | body |
|---|---|---|
| `JournalEntry` | C→S; relayed to all when `[sharing] journal` | `{questId=string, index=number, actorRefId=string?}` — server arbitrates **monotonic max per questId** (a lagging client can never regress a shared quest); non-monotonic updates are stored but not relayed unless `questId` is in the operator's `regressAllowlist` |
| `JournalSync` | S→C at join | `{quests={[questId]=index, …}}` — full shared journal state (shared mode) or the player's own stored journal (individual mode) |
| `GlobalVarUpdate` | C→S; relayed to all when `[sharing] questVars` | `{name=string, value=number, seq=number?}` — MWScript globals; **last-write-wins with a per-variable sequence**; the time globals (`GameHour/Day/Month/Year/DaysPassed`) are EXCLUDED here and owned by M7 |
| `MemberVarUpdate` | C→S; relayed cell-scoped | `{ref=RefNum, name=string, value=number}` — per-object MWScript locals, piggybacked on object interaction |
| `FactionUpdate` | C→S; relayed when `[sharing] factions` | `{factionId=string, rank=number, reputation=number?, expelled=bool?}` |
| `CrimeUpdate` | C→S; relayed when `[sharing] crime` | `{bounty=number, kind=string?}` — shared vs personal bounty is a server policy flag |
| `DialogueLock` | C→S | `{ref=RefNum, cellKey=, want=bool}` → `DialogueLockResult {ref, granted=bool, holderId=u16?}` — one player may converse with an NPC at a time; released on close, cell change, or disconnect |

Kill counts ride M4's `WorldKillCount`. Applying a received journal/faction/var update MUST
NOT re-broadcast it (echo guard) — clients seed their diff caches from applied state.

## World state (M7)

| name | dir | body |
|---|---|---|
| `WorldTime` | S→C (60 s + on change + at join) | `{gameHour=number, day=number, month=number, year=number, timeScale=number}` — the server owns the clock; clients slew rather than snap |
| `WorldTimeRequest` | C→S | `{advanceHours=number, reason="rest"\|"wait"\|"script"}` — the server applies and rebroadcasts, so resting advances time for everyone |
| `WorldRegionChange` | C→S | `{region=string}` — the client declares which region it is in (cell→region mapping lives in the content files, so the server cannot derive it); drives region occupancy and weather-authority handoff |
| `WorldWeather` | C→S from the region authority; S→C broadcast | `{region=string, current=number, next=number?, transition=number?}` — non-holders are dropped; also replayed per known region at join |
| `WorldWeatherAuthority` | S→C | `{region=string, holderId=u16}` — same holder pattern as cells, keyed by region; `holderId` equal to your own id means YOU simulate the weather there, `holderId=0` means the region has no authority (you just lost it). Handoff goes to the longest-present occupant; an emptied region folds its last weather and resumes it for the next claimant |
| `RecordCreate` | C→S | `{tempId=number, kind="spell"\|"potion"\|"enchantment"\|"armor"\|"weapon"\|"clothing"\|"book"\|"misc", data=table}` → `RecordCreateAck {tempId, recordNetId=string}` |
| `RecordsSync` | S→C at join, and to peers on every `RecordCreate` | `{records={{recordNetId, kind, data}, …}}` — replay all custom records so cross-client ids resolve (fixes the M3 dynamic-record placeholder problem for player-made items). At join it is the COMPLETE set; after a creation it carries just the one new record, so peers can resolve the id before the item is used, not only at their next join |
| `WorldCellReset` | S→C (all players) | `{cellKey=string}` — cell doc wiped on the operator's schedule (`[cellReset]`, persisted across restarts); clients drop local deltas and reload |
| `WorldMapExplored` | C→S; relayed when `[sharing] map` | `{cellKeys={string,…}}` — relayed as `{cellKeys, byId}`, sender excluded |
| `GuiMessageBox` / `GuiInputDialog` / `GuiListBox` | S→C | `{guiId=number, text=string, buttons={…}\|label=string\|items={…}}` → `GuiReply {guiId, data}` (C→S) — server-pushed UI for plugins. `guiId` is server-issued and monotonic; a reply for another player's `guiId` is dropped. A dialog is settled by the reply, by `[gui] timeoutSec`, or by the player disconnecting — never left pending |

## Ops (M8)

**Ranks** live on the account (`accounts/<name>.json`, seeded from `[admin] owners`):
`0` player, `1` moderator, `2` admin, `3` owner.

Moderation (A4) rides the same two entry points and the same single `Admin.exec` gate:
`/report <player> <reason>` is rank 0 (it writes `reports/<ts>-<reporter>.json` with the
target's current cell and the last `[moderation] contextLines` chat lines), while
`/reports [n]` and `/chatlog <player> [minutes]` are rank 1. Chat is persisted to
`logs/chat-YYYY-MM-DD.jsonl` — see PRIVACY.md.

| name | dir | body |
|---|---|---|
| `AdminCommand` | C→S, rank-gated | `{cmd=string, args={string\|number,…}}` — same commands as the chat slash path, same gate |
| `AdminResult` | S→C | `{text=string}` — ALWAYS answered, refusals included (`"/ban requires rank 2 …"`), may be multi-line |
| `ConsoleCommand` | S→C, owner-gated | `{script=string}` executed client-side. Remote code execution on the player's own machine: rank 3 only, removable with `[admin] allowConsole=false`, and every use is logged with actor, target and full payload |
| `AdminTeleport` | S→C | `{cellKey=string, x=, y=, z=}` — the `/tp` and `/tpto` effect; the client moves the player and then reports the move normally (`PlayerCellChange`) |
| `AdminGive` | S→C | `{recordId=string, count=number}` — the `/give` effect; the client adds the item and reports inventory as usual |

Commands and their minimum rank: `list` `motd` (read) 0 · `kick` `tp` `tpto` 1 ·
`motd <text>` `ban` `unban` `ipban` `give` 2 · `setrank` `console` 3. A player who
outranks the actor cannot be kicked/banned/ip-banned. Account bans are enforced at
register/login/resume (`BANNED`); IP bans are enforced at socket accept, before any
parsing or hashing.

**Session resume** (§Session tier): when an IN-WORLD session drops, its `sessionToken` is
parked in memory for `[login] resumeWindowSec`. `{"t":"SessionResume","token":"<hex>"}` is
sent in `HELLO_OK` — i.e. AFTER `SessionHello`, so engine and content policy are enforced
exactly as for a login and resume can never bypass them. Tokens are single-use (a resumed
session gets a fresh one), memory-only (a restart invalidates every ticket), and revoked on
ban. Success answers `SessionWelcome` (new token, `playerRecord` restored) and the client
then sends `SessionReady` as usual; failure is `AUTH_FAILED` and the client falls back to a
normal login. Supersede semantics are unchanged: resuming an account that is currently
connected elsewhere kicks that connection with `SUPERSEDED`.

After `SessionReady` a resumed session receives **everything a fresh join receives** —
`PlayerJoinWorld`/`PlayerList`, the M2 appearance/equipment/stats sync, `JournalSync`,
`WorldTime`, per-region `WorldWeather`, `RecordsSync` — **plus** the rejoin-in-place set:
its previous cell is restored server-side, a `PlayerCellChange` for it is broadcast so
peers re-place the player, `WorldCellState` for that cell is re-sent, and cell authority is
re-claimed (`ActorAuthorityGrant`/`Info`). The client therefore needs no special resume
handling beyond sending the token: the post-Ready stream is a superset of the normal one.

## Single sign-on (Phase B)

SSO runs **alongside** account+password, never instead of it (`[auth] allowPasswordLogin`,
default `true`). The browser half is OAuth 2.0 **Authorization Code + PKCE (S256)**;
implicit is not implemented and will not be (RFC 9700 §2.1.2). The relay is a
**Backend-For-Frontend**: it performs the code→token exchange itself, holding the client
secret, so the provider's access/refresh/ID tokens NEVER reach the browser and never enter
this protocol. Accounts are keyed on `(iss, sub)` — never on email, which is mutable and
re-assignable; no email scope is requested.

HTTP routes (all `GET`):

- `/auth/providers` → `{providers:[…], allowPasswordLogin, allowRegistration}` (public,
  CORS, so a client can render login buttons).
- `/auth/:provider/start[?invite=…]` → `302` to the provider. PKCE verifier, `state` and
  `nonce` are minted server-side; `state` is mirrored into an `httpOnly; SameSite=Lax;
  Path=/auth` cookie (`omwmp_oauth`) and the callback requires both.
- `/auth/:provider/callback` → server-side code exchange, ID-token verification (RS256 only,
  against the provider JWKS, checking `iss`/`aud`/`exp`/`nbf`/`nonce`), then `302` back to
  `[auth] returnUrl` with the result in the **URL fragment**:
  `#mpticket=…` (success) · `#mperror=<code>` · `#mplink=<provider>`.
  A fragment is never logged, cached or sent in a `Referer`; a `return` parameter from the
  caller is ignored, so this is not an open redirector.
- `/auth/link/:provider?session=<sessionToken>` → same round trip, but binds the identity to
  the account holding that live game session. Refused with `#mperror=link_conflict` when the
  identity already belongs to a different account. One account, several providers.

`mpticket` is a **one-time, ≤60 s, 256-bit** login ticket. The client sends it as
`{"t":"SessionLoginTicket","ticket":"…"}` in `HELLO_OK`, exactly where a `SessionLoginRequest`
would go; the server claims it (single use), resolves the account and answers `SessionWelcome`
as usual. Bans are re-checked **against the resolved account** at redemption, so a ticket
minted before a ban is still refused with `BANNED`. Identities live in
`<dataDir>/identities/<sha256(iss\nsub)>.json` and are erased with the account.

`GET /status` (public, `access-control-allow-origin: *`) is the lobby payload:
`{name, motd, players[{id,name,cellKey,level?}], playerCount, maxPlayers, contentPolicy,
enginePolicy, requiresPassword, allowsRegistration, pvp, uptime, version}` — no IPs, no
account data. `GET /healthz` → `ok`.

## Social layer (Phase C)

Design and rationale in `docs/PHASE-C-SOCIAL.md`.

Identity is the **account key** (`acct`) throughout, never the player id: ids are
per-session, so an id-keyed friendship would expire on every reconnect. The live
`playerId` rides alongside and only while the friend is online.

Client → server (event tier). `name` is a typed display name; `acct` is an account key
returned by a previous `FriendList`:

- `FriendRequest{name}` · `FriendAccept{acct}` · `FriendRemove{acct}`
- `BlockAdd{name}` · `BlockRemove{acct}`
- `InviteSend{acct}` · `InviteAccept{acct}` — travel-to invite
- `PresenceMode{mode}` — one of `public` `friends` `private`

Server → client:

- `FriendList{friends:[{acct, name, online, playerId?, cellKey?}]}` — full snapshot, sent on
  join and after any mutation (the client rebuilds its window from it; there is no
  incremental form)
- `PresenceUpdate{acct, online, playerId?}`
- `FriendRequestReceived{fromAcct, fromName}` · `InviteReceived{fromAcct, fromName}`
- `InviteAccepted{cellKey, x, y, z}` — the host's live position, resolved server-side.
  The client travels to THIS rather than to a coordinate it chose: the server is the only
  party that knows where the host actually is.
- `SocialResult{op, ok, detail}` — sent for every client→server op above. A refused action
  must never be silent; a friend request that does nothing is indistinguishable from a
  broken server.

Rules the implementation must honour, each because getting it wrong is silent rather than
loud:

- Identity is the **account id**, never the display name. Names are mutable and reusable, so
  a name-keyed friendship silently re-points at whoever holds the name next.
- **Blocks outrank friendship and invites, in both directions**, and cannot be defeated by
  the blocked party re-requesting.
- `cellKey` in `FriendList` **leaks location** and is therefore friends-only — never
  returned to a stranger, and never to someone the player has blocked.
- Presence must flip on an abrupt **drop**, not only a clean logout; the reconnect path is
  where presence goes stale.
- Invites expire and are capped per sender, or the channel is a spam vector.
- Friendship is stored **once per pair** (lower account id first). Two rows per friendship
  lets a half-applied mutation leave A friends with B but not the reverse.
- **Presence mode is a server-enforced privacy control**, not a client preference. Every
  path that could disclose a location or deliver an invite goes through one check, so a new
  surface cannot accidentally leak what a player asked to hide. `private` hides you from
  **friends too** and refuses invites outright — a mode that only hid you from strangers
  would be indistinguishable from the default. It is the one social field that persists.

Storage is `node:sqlite` in the existing data dir. This is only correct because the world
is single-process; if the map is ever region-sharded across processes, the social data has
to move out to a shared service first.

## Client-side integration contract (M0)

- Join URL: `index.html?...&mp=<ws(s)-url>&name=<display-name>`; boot JS sets
  `ENV.OPENMW_MP_URL` / `OPENMW_MP_NAME` and appends `content=mp.omwscripts`.
- Test/automation surface (for `wasm-build/mp-harness.mjs`): `window.__omwMP` mirrors
  `{state, playerId, lastChat, players}` and accepts `window.__omwMP.sendChat(text)`;
  `&mpauto=1&mpuser=<account>` auto-registers/logs in with a fixed harness password.
