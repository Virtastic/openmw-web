# omw-mp.2 wire protocol

Authoritative contract between the browser client (C++ `mwmp/` transport + `scripts/mp/` Lua)
and the `openmw-mp` server. This file is the source of truth; both sides cite it in code
comments. Scope grows per milestone — sections are tagged with the milestone that introduces
them. Current: **M8** (M0-M7 shipped). Wire version: `SessionHello.proto = 3`.

## Changelog

### proto 3 (2026-09-15) — the doc re-read against the code (backlog 398)

Corrections, each checked against the validator or handler named:

- Peer-pose freshness is **2 s** (`PEER_POSE_FRESH_MS`, players.ts), not 300 ms; the "driving
  the input tier" predicate behind bars, item states, PvP routing and peer-owned writes is
  **5 s** (`INPUT_DRIVING_MS`), not 1 s.
- `ActorAI` has no `pkg=` shape. The holder relays `{cellKey, epoch, ref|net, combat}` /
  `{…, travel}`; a NON-holder may send exactly four claims (follow/escort, travel, combat,
  position), each with its own gate (§M4).
- `JournalSync` carries `{quests, borrowed, journalLog}`; `CrimeUpdate` is raise-only under
  shared crime, echoed back on a refused drop, and relayed with `byId`/`shared`.
- `CombatHit`/`CombatSpellHit` reach the owner with `attackerId`; `CombatCast` with `fromId`.
- `ContainerOpen` first-open caps and the `op="gold"` purse op; `ContainerState.gold`.
- `DialogueLock` gates (reach, contention, one lock per player) and the 5 s "recently held"
  grace the M4 claims use.
- `SelfStats.kd/blk`, `PlayerStatsDynamic.speed`.
- `CombatProjectile` is **dead**: validated and relayed by the server, sent by no client, and
  the client handler is an explicit no-op. `ObjectMove` C→S is dead the same way (#203).
- Session tier: `CharacterCreate`/`CharacterResult`, `ProfileSetup`/`ProfileResult`,
  `SessionHello.system`, `characterId` on every auth message, `SessionWelcome.characters`
  / `characterId` / `profile`, `flags.simulated` / `flags.respawn`, disconnect codes
  `BACKLOG` and `IP_CAP`.
- Event tier, previously undocumented (now in their milestone sections): `PlayerMark`,
  `PlayerActiveSpells`, `AvatarActiveSpells`, `SelfActiveSpells`, `SelfSpells`,
  `SelfSkillUse`, `AvatarEffectsBatch`, `AvatarSkillUse`, `StateRefused`, `ChargenComplete`,
  `PlayerLeaving`, `ObjectEnabled`, `ObjectTakeRequest`, `ActorDisposition`, `ActorEffects`,
  `ActorCellChange`, `ActorRevive`, `ActorStripLoot`, `TopicsLearned`, `GlobalVarSync`,
  `PlayerCrime`, `PlayerArrest`, `WorldList`/`WorldCreate` (C→S), `JoinFriend`,
  `SetAvailability`, `SetWorldMode`, `WorldKick`, `ReportPlayer` without `voice` (#402).

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
signal exists or is needed (the peer-pose freshness window, **2 s** — `PEER_POSE_FRESH_MS`
— is the whole switch; 300 ms let a peer GC hitch alternate writers).

- **`0x0102` PlayerInput (C→S, ~30 Hz).** 12-byte payload: `0` u32 seq (client-monotonic,
  echoed back as `lastInputSeq`; the server's stale-drop and teleport gate key on THIS seq,
  not the envelope counter, which every binary frame shares) · `4` i8 move axis (−127..127 ≡ −1..1) · `5` i8 side axis ·
  `6` u16 yaw · `8` u8 pitch (same quantization as PlayerMove) · `9` u8 flags (bit0 run,
  bit1 sneak, bit2 jump-edge, bit3 use/attack, bit4 weapon stance, bit5 spell stance — the
  avatar only swings from a drawn stance) · `10` u16 reserved 0. Authenticated by
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
  result with no second channel; while the stream is fresh (2 s) a client's own `0x0100`
  claim is consumed but not applied. An entry is only applied for a player who sent
  `PlayerInput` within the last 2 s (an input-less client keeps its own authority), and
  after a `PlayerCellChange` entries are ignored until the avatar's pose arrives within
  512 units of the declared spot (positional teleport grace, warned after 30 s).
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
| `PlayerCellChange` | C→S, relayed S→C with `id` added | `{cellKey=string, x=number, y=number, z=number}` — `cellKey` = `"x,y"` for exteriors (comma, integers) or the lowercased interior cell name (≤128 chars; ≤4096 distinct cells per session). Updates server occupancy; receivers despawn/teleport that player's puppet. A SAME-cell change of more than 1024 units is refused (counted `cell_jump`) unless explained within 5 s by a cast, a door, a dialogue, or within 15 s by a resurrect/join (#361). The sim peer's changes are not relayed to others. |
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

`SessionHello` carries an optional **`simulatesActors: true`** and an optional **`system: true`**
(a headless sim peer, Phase H: exempt from the player list, `playerCount`/`maxPlayers`,
idle/AFK and the engine-hash check; only THE world peer's avatar reports are accepted). A
client that omits `simulatesActors` is
never granted cell actor authority — neither by election nor by claiming a dormant cell.
Authority is otherwise chosen on network fitness, and a protocol-only client (a load bot, a
headless tool) is a near-perfect RTT candidate that simulates nothing: it wins the cell and
every NPC in it freezes for everyone. A cell with no capable occupant stays **dormant**,
which is the same amount of simulation without the server believing the job is covered.

Client → server:

- `{"t":"SessionHello", "proto":3, "engineHash":"<12-hex or empty>", "lserVersion":0,
   "manifest":[{"name":"Morrowind.esm","size":123,"idx":0}, …], "resumeToken":"<opt>",
   "simulatesActors":<opt bool>, "system":<opt bool>}` — `proto ≠ 3` → `BAD_PROTO`.
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
   "inviteCode":"<opt>", "characterId":"<opt>"}` — `inviteCode` is required when
   `[login] inviteCode` is set.
- `{"t":"SessionLoginRequest", "account":"name", "password":"…", "serverPassword":"<opt>",
   "characterId":"<opt>"}`
- `{"t":"SessionResume", "token":"<hex>"}` — M8 rejoin-in-place; valid in `HELLO_OK`
  instead of a Register/Login (see §Ops).
- `{"t":"SessionLoginTicket", "ticket":"<base64url>", "serverPassword":"<opt>",
   "characterId":"<opt>"}` — Phase B SSO; valid in `HELLO_OK` instead of a Register/Login
   (see §Single sign-on).

  **Character slots.** `characterId` (1–64 chars) on any of the three auth messages selects
  which of the account's characters this session plays; absent = last played. There is no
  separate select op: switching slots is a reconnect.
- `{"t":"CharacterCreate", "name":"<≤64, account-name rules>"}` — valid in `AUTHED` (the
  select screen) and `IN_WORLD` (the hub). Answered by
  `{"t":"CharacterResult", "ok":bool, "characters":[…], "error":"badname"|"full"?}` with the
  refreshed slot list, so the select screen re-renders without a reconnect. The slot is
  PROVISIONAL until the client's `ChargenComplete` event; an abandoned creation is reaped.
- `{"t":"ProfileSetup", "email":"<≤254>", "username":"<≤64>", "marketingOptIn":<opt bool>}` —
  onboarding, valid in `AUTHED` and `IN_WORLD`. Answered by
  `{"t":"ProfileResult", "ok":bool, "error":"badformat-email"|"badformat-username"|
  "reserved-word"|"taken"|"cooldown"|"profile-required"|"internal"?}`. Under
  `[login] requireProfile` a `SessionReady` before email+username are set is refused with
  `ProfileResult{error:"profile-required"}` and the session stays alive. The public username
  becomes the display name (live in the roster).
- `{"t":"SessionReady"}` — after the client has applied `SessionWelcome` and is in-game.
- `{"t":"SessionPing", "clientTime":<ms>}` — allowed in any state.

Server → client:

- `{"t":"SessionHelloOk", "serverName":"…", "contentPolicy":"names|strict|off"}`
- `{"t":"SessionWelcome", "playerId":<u16>, "sessionToken":"<hex>", "motd":"…",
   "flags":{…}, "playerRecord":null, "serverSeq":<u32>,
   "characters":[{"id","name","lastPlayedAt"}, …], "characterId":"<id or empty>",
   "profile":{"required":bool, "username"?, "email"?}}`
  (`playerRecord:null` → fresh character; non-null restore is M2. `serverSeq` = binary
  seq already consumed on this connection: 0 at welcome, first server Event frame is seq 1.
  `characters` is the account's slot list (empty for system peers) and `characterId` the one
  this session plays; `profile` is the owner's OWN profile — the one place the email appears
  on the wire — and `required:true` means `ProfileSetup` must precede `SessionReady`.)

  `flags` are session rules the client applies locally:

  | field | meaning |
  | --- | --- |
  | `pvp` | player-vs-player hits are relayed (M5) |
  | `difficulty` | applied client-side, in the victim's own combat pipeline |
  | `renderLod` | `"tiered"` degrades distant avatars; `"full"` simulates every avatar |
  | `lodNearRadius` / `lodMidRadius` | render tier boundaries, in world units |
  | `lodNearMaxAvatars` | hard ceiling on fully-simulated avatars; `0` = radius only |
  | `simulated` | optional, `true` when a sim peer simulates this world: the client must not roll its own levelled-list creatures or script-spawned actors (they arrive as named net objects from the holder). Known at join, before the first cell's authority info |
  | `respawn` | optional `{cellKey, x, y, z}` (backlog 317): where the client puts a character whose stored cell no longer exists in this load order; the world's `[rules].respawn*` point |

  The render-LOD fields are sent rather than baked into the client because the client's
  scripts live inside `openmw.data` and changing a constant there costs a full relink.
  **A client that does not understand them must default to full fidelity** — the fallback
  for a missing tier is "near", never a silent degrade. They intentionally mirror the
  server's own network-LOD radii so an avatar receiving poses at 1 Hz is not also being
  asked to walk smoothly between them.
- `{"t":"SessionPong", "clientTime":<ms>, "serverTime":<ms>}`
- `{"t":"SessionDisconnect", "code":"<CODE>", "detail":"human-readable"}` then close.
  Codes: `BAD_PROTO BAD_ENGINE BAD_CONTENT AUTH_FAILED BANNED SUPERSEDED KICKED RATE
  BACKLOG IP_CAP SERVER_FULL SHUTDOWN`. `BACKLOG` = outbound buffer overflow past
  `maxBufferedBytesHard` (the client stopped reading — a background tab; transient, reconnect).
  `IP_CAP` = too many connections from one address, sent at socket accept (close 1008).

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
| `ChatSend` | C→S | `{text=string, channel="say"\|"party"\|"global"\|"whisper"?, to=string?}` — without `channel`, a leading `!` is `global` and a leading `@` is `party` (world chat); `to` names a whisper target. A `/`-prefixed line is chat like any other (there is no command path, §Ops). Own `chat` rate bucket; over it the sender is whispered once and the line dropped |
| `ChatMessage` | S→C | `{channel="say"\|"party"\|"global"\|"server"\|"whisper", from=string?, fromId=u16?, to=string?, text=string}` — `say` is proximity when `[chat] sayProximity`; `server` is never muted; a whisper is echoed to the sender with `to` |
| `PlayerJoinWorld` | S→C | `{id=u16, name=string}` |
| `PlayerLeaveWorld` | S→C | `{id=u16}` |
| `PlayerList` | S→C | `{players={{id=u16, name=string}, …}}` — humans only (system peers are omitted) |
| `PlayerLeaving` | C→S | `{}` — the client is about to dial elsewhere (JoinFriend / home). From the OWNER of a party world it closes the world at once (`WorldMode{mode="private"}` to all, guests sent home) instead of after the disconnect grace |
| `ChargenComplete` | C→S | `{}` — the engine reports `CharGenState == -1`; the provisional character slot is adopted and named from the chargen `PlayerAppearance.name`, and saves are enabled. Idempotent; re-sent on every login |
| `StateRefused` | S→C | `{kind=string}` — an M2 `Player*` declaration the server would not store (shape, cap, rate). The client forgets its diff cache for that kind and re-sends on its next tick, at most 3 times per unchanged value (backlog 336) |

## Event-tier additions (M2)

| name | dir | body |
|---|---|---|
| `PlayerAppearance` | C→S on join/chargen-done/change; relayed S→C to ALL in-world with `id` | `{race=string, head=string, hair=string, isMale=bool, class=string, name=string}` (record-id strings from the player's own NPC record; ids ≤64 chars, name ≤64) |
| `PlayerEquipment` | C→S on change (client diffs); relayed to ALL with `id` | `{slots={[slotNumber]=recordId, …}}` — full snapshot, slot numbers 0..20 per `types.Actor.EQUIPMENT_SLOT` |
| `PlayerStatsDynamic` | C→S on change (0.25 s poll, instant on death); relayed to VISIBLE with `id` | `{hp={c=number,b=number,d=number?}, mp={c=,b=,d=?}, ft={c=,b=}}` (current/base; any subset). Relayed as `{id, hp, mp, ft, speed=number?}` — `speed` is the owner's base Speed attribute from the doc, so puppets run at the right pace (backlog 134). While a peer bar report is fresh (5 s) a claim may only RAISE a bar (a potion, a rest) up to base; lower values are ignored; base changes ≤60 per 10 s, ≤2000; restores are budgeted at 4× max health per 10 s (#359). `d` is the LOCAL GAIN since the last claim (backlog 461): when present the server applies it on top of the bar its doc holds (gains only for hp/ft, net for mp, capped at base) instead of trusting `c`, which the client computes on a peer report that is a round trip stale after every raise; `c` remains the fallback for a client without `d` |
| `PlayerAttributes` / `PlayerSkills` | C→S on change (1 s diff) | the body IS the flat `{name=number}` map (≤64 entries, keys ≤32 chars, values 0..100) — no wrapper key, unlike the other bodies. A key may rise by at most 5 per 10 s window (#369); over it the whole map is refused (`StateRefused`) |
| `PlayerLevel` | C→S on change | `{level=int 1..255, reputation=int 0..255?}`; stored for persistence; not relayed. One level step per 10 s, a jump of ≥2 refused. Reputation is NpcStats-only in the engine, so it rides here (backlog 223) |
| `PlayerMark` | C→S on change (1 s diff, set marks only) | `{cell=string, x=,y=,z=}` — the Mark spell's location, stored on the doc for relog |
| `PlayerSpellbook` | C→S `{add={id,…}, remove={id,…}}` | stored (≤1024 spells); not relayed. A custom record minted by ANOTHER account is refused (#362) |
| `PlayerActiveSpells` | C→S (0.5 s diff) | `{add={{key=string(≤32), id=recordId, effects={index,…}(1..8)}, …}, remove={{key, id}, …}}` — the player's own active magic by instance key. Budgeted (32 ops / 5 s, magnitude per 10 s window; over budget = consumed, not forwarded). Relayed to every OTHER client as `AvatarActiveSpells {id, add, remove}` (the peer applies the whole effect to the avatar; clients keep what is visible on a puppet); a joiner gets each player's current set |
| `PlayerInventory` | C→S full snapshot `{items={{id=recordId, n=count, condition?, charge?, soul?}, …}}` on change (2 s diff, cap 4096 entries; count ≤10000, gold ≤1e8) | stored for rejoin restore; not relayed. While a peer item-state report is fresh (5 s) the per-item STATES are ignored, counts still land (Phase 4D) |
| `PlayerItemAcquired` | C→S `{id=recordId, n=count}` on every count INCREASE (0.25 s scan) | credits the item against drop conservation; SPENT by a drop that uses it, and cleared wholesale by the next `PlayerInventory`. Not stored, not relayed |
| `PlayerDeath` | C→S `{}` | server runs respawn/death-penalty plugins. While the peer rules this player's bars and the doc says hp > 0, the death is refused as unconfirmed (a respawn is a free heal + teleport) |
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
| `SelfStats` | S→C (owner only, per accepted entry) | `{hp={c=,b=}, mp={c=,b=}, ft={c=,b=}, kd=bool, blk=string?}` — the owner applies CURRENT values to self. `kd` = knocked down on the peer (the owner holds still, backlog 73); `blk` = `"Light|Medium|Heavy Armor Hit"`, the shield sound of a block made on the peer (backlog 312). Wire names are BARE: the engine prefixes `MP_` on arrival |
| `AvatarSkillUse` | PEER→S | `{id=int, skill="block"\|"lightarmor"\|"mediumarmor"\|"heavyarmor"\|"unarmored", useType=0..3}` — an armour/block skill use on the avatar (backlog 307); ≤10/s per owner. Forwarded to the owner as `SelfSkillUse {skill, useType}` for its own `I.SkillProgression` |
| `AvatarEffectsBatch` | PEER→S | `{entries={{id=int, spellsAdd={{id, effects}, …}?, effectsAdd={{key, id, effects}, …}?, effectsRemove={{key, id}, …}?}, …}}` — what the world did to the avatar (a disease from a bite, a hostile Paralyze). Spells are persisted to the doc and sent to the owner as `SelfSpells {add}`; effects as `SelfActiveSpells {add, remove}`. ≤32 entries/ops |

One-writer rule, same shape as the movement gate: while an accepted peer report for a
player is fresh (≤5 s, `INPUT_DRIVING_MS`), that player's own `PlayerStatsDynamic` may only
RAISE a bar (see the M2 row). A peer entry is only accepted for a player actively driving
the input tier (fresh `PlayerInput` ≤5 s) — an input-less client (old build, protocol bot,
mid-outage browser) keeps asserting its own bars, per-player degraded mode with no
switchover signal — EXCEPT a death (hp ≤ 0), which is always taken: the avatar is the body
in the world. For 6 s after a resurrect, dead-avatar reports are ignored (the new body's
bars have not arrived yet). Observer relay rides the ordinary `PlayerStatsDynamic` fan-out
(with `speed`), so other clients need no new type. Death in a peer report flushes the doc
immediately, exactly like the client edge. Every `Avatar*Batch` is accepted from THE world
peer only; any other sender is dropped.

### Phase 4D — inventory keeps the avatar current, both ways

| name | dir | body |
|---|---|---|
| `AvatarState` | S→PEER at join and after every accepted `PlayerInventory` / `PlayerAttributes` / `PlayerSkills` / `PlayerLevel` / `PlayerSpellbook` | `{id=int, stats={dynamic, attributes, skills, level}?, spells={…}?, inventory={…}?, itemStates={…}?, factions={…}?, bounty=number?}` — the character doc the peer builds the avatar from (a dead doc is sent at 10 % health so the body stands). The peer's `applyAvatarDoc` reconciles shortfall, **surplus** and item states without duplicating what the body already holds; progression has to reach the peer or it fights with a character who never improved |
| `AvatarItemStatesBatch` | PEER→S (2 s, diffed, 10 s refresh) | `{entries={{id=int, itemStates={[recordId]={{condition=,charge=,soul=}, …}, …}}, …}}` — the doc's own positional shape; dropped from any non-system sender |
| `SelfItemStates` | S→C (owner only, per accepted entry) | `{itemStates={…}}` — applied positionally per record id to the owner's own items |

Why: the peer swings the weapon now (4C), so the peer is where wear, charge spend and soul
capture happen — and the avatar must be *holding* what the owner holds (a weapon picked up
mid-session) for that swing to compute the right damage. **Counts stay client/M3-owned**
(world transfers are already arbitrated by `ContainerOpRequest`/`Result` with drop
conservation); only item **state** moves under the one-writer rule: while a peer report is
fresh (≤`INPUT_DRIVING_MS`), the client's own `itemStates` inside `PlayerInventory` are
ignored, its counts still land. An input-less player keeps their own states. No engine hook:
the plan's containerstore veto is not needed for this — `OnItemTransferred` (notify) plus
the two reconciliations above cover it.

## Event-tier additions (M3) — world objects & containers

Object addressing is a tagged union in every body: `{ref=<RefNum userdata>}` for
content-file objects (portable — login enforces identical load order) or `{net=<number>}`
for runtime-spawned objects (server-issued). Clients keep local↔net maps; client-local
generated RefNums NEVER travel.

| name | dir | body |
|---|---|---|
| `ObjectSpawnRequest` | C→S | `{tempId=number, recordId=string, cellKey=string, x=,y=,z=, rotZ=number, count=number, fromInventory=bool?, state={condition?, charge?, soul?}?, actor=bool?}` — count ≥1 (engine objects not yet placed report count 0; clients clamp). `actor=true` from the SIM PEER names a runtime-spawned NPC/creature (placed with `actor=true`, addressed by `net` in the actor stream); `actor=true` from a HUMAN is a PlaceAtPC its engine declined (backlog 214): not placed, but forwarded to the cell's holder as `QuestSpawn{…, forId}` — refused `reach` when the cell is not visible to the asker or count > 10, `rate` past 10/min per player. `tempId` is 0 for those |
| `ObjectSpawnAck` | S→C (requester) | `{tempId=number, netId=number}` |
| `ObjectSpawnRefused` | S→C (requester) | `{tempId=number, ok=false, reason="unowned"\|"contained"\|"cell_full"\|"reach"\|"rate"}` — always sent, so an optimistic drop can be put back |
| `ObjectPlace` | S→C broadcast (cell-scoped visible) | `{netId=number, recordId=string, cellKey=, x=,y=,z=, rotZ=, count=, byId=u16, actor=true?, state={…}?}` |
| `ObjectDelete` | C→S; relayed cell-scoped with `byId` | `{ref|net, cellKey=string}` — tombstoned in the cell doc (2000 tombstones per cell) |
| `ObjectTakeRequest` | C→S | `{ref|net, cellKey=, opId=number}` — picking up a loose item is a REQUEST: the client holds its native take until `ObjectTakeResult {opId, ok, reason="unreachable"\|"gone"\|"cell_full"?}`; on ok the relayed `ObjectDelete` (with `byId`) removes it from every other view. Two players activating the same item: one `ok`, one `gone` |
| `ObjectLock` | C→S; relayed cell-scoped with `byId` | `{ref|net, cellKey=, lockLevel=number|nil}` (nil = unlocked) |
| `ObjectEnabled` | C→S; relayed cell-scoped with `byId` | `{ref|net, cellKey=, enabled=bool}` — a script's Enable/Disable. The ONE object op with no reach gate (scripts toggle far cells: backlog 213/218): a far exterior must be inside the world's bounds, a session may name ≤64 distinct far cells, interiors need no prior visit (#384). A human write within 5 s of the peer's write to the same object is dropped (peer-owned) |
| `DoorState` | C→S; relayed cell-scoped with `byId` | `{ref, cellKey=, open=bool}` — content refs only; a door used also explains the next same-cell teleport (#361) |
| `ContainerOpen` | C→S | `{ref|net, cellKey=, contents={{id=,n=},…}|nil, gold=number?}` — first-opener's contents become canonical (leveled-loot roll) and `gold` seeds a merchant purse (restocked with the origin stock every 24 game hours); thereafter server state is truth. A HUMAN first-open is capped: >50 000 gold (in contents or purse) or any non-gold stack >100 is implausible — gold dropped, stacks clamped to 100, noted for moderation |
| `ContainerState` | S→C (opener) | `{ref|net, items={{id=,n=},…}, stateSeq=number, gold=number?}` |
| `ContainerOpRequest` | C→S | `{ref|net, cellKey=, opId=number, op="take"\|"put", itemId=string, n=number}` or `{…, op="gold", goldDelta=int (|Δ| ≤ 1e6)}` — the merchant purse op (a barter's gold side; the purse never goes below 0). `op="gold"` alone may name the cell the player JUST left (a strider fare is paid one frame after the cell change) |
| `ContainerOpResult` | S→C (requester) | `{opId=, ok=bool, reason="nostate"\|"gone"\|…?, stateSeq=}` — `nostate` = the container was never opened here |
| `ContainerUpdate` | S→C broadcast (cell-scoped) | `{ref|net, delta={itemId=, dn=number}, stateSeq=}` |
| `WorldCellState` | S→C (on PlayerCellChange for the cell and its 8 exterior neighbours, + ResyncRequest) | `{cellKey=, placed={…ObjectPlace-shaped…}, deleted={refKeys}, moved={…}, locks={…}, doors={…}, containers={refKey={items,stateSeq}}, disabled={refKeys}, enabled={refKeys}, deaths={refKeys}, memberVars={refKey={name=value}}}` — `deaths` are the actors still dead (corpses expire); trimmed to the LSER node budget, actors' placed entries kept first |
| `ResyncRequest` | C→S | `{cellKey=string}` — reach-gated like an edit (#370) |

`ObjectMove` (`{ref|net, cellKey=, x=,y=,z=, rotZ=}`, relayed with `byId`) is still accepted
and relayed by the server, but **no client sends it** (#203: scripted movers are per-engine);
it is not part of the contract until a holder-authoritative sender exists. Every object op
except `ObjectEnabled` is REACH-gated: the sender's cell must be visible to `cellKey` (the sim
peer is exempt), a spawned/moved object must be within reach of the sender's last pose, and
an actor the holder streams is not an object (#364: a take/delete/move of one is refused and
noted).

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
| `ActorAuthorityGrant` | S→C | `{cellKey=string, epoch=u32, snapshot={actors={ {ref|net, x,y,z,rotZ, hp={c,b},mp,ft, dead=bool, disp=number?}, … }}}` — apply the snapshot (the holder's last `ActorSnapshot`; `disp` = persuaded base disposition), THEN begin simulating |
| `ActorAuthorityRevoke` | S→C | `{cellKey=string, epoch=u32}` — stop simulating; re-attach puppets to those actors |
| `ActorAuthorityInfo` | S→C | `{cellKey=string, holderId=u16, epoch=u32}` — sent to a non-holder entering a claimed cell, and re-sent to every remaining non-holder whenever the epoch changes (handoff), so all occupants always know the live epoch |

- Claim: first client to `PlayerCellChange` into a cell with no holder gets `Grant` (epoch++).
  Contested entry: server is the single serialization point, first processed wins; the loser
  gets `ActorAuthorityInfo`. Clients MUST NOT self-start actor simulation without a Grant.
- Handoff on holder leave/disconnect: longest-present remaining occupant gets `Grant` +
  `lastSnapshot` (epoch++); empty cell → snapshot folds into the cell doc `actorOverrides`
  and is handed to the next claimant.

**Actor state** — every `Actor*` message carries `(cellKey, epoch)` and addresses the actor as
`{ref=RefNum}` or `{net=netId}` (a runtime actor the holder named through
`ObjectSpawnRequest{actor=true}`); the server drops any whose epoch ≠ the current cell epoch
(kills the handoff race). Only the holder may send — with the four non-holder CLAIMS below.

| name | dir | body / layout |
|---|---|---|
| `ActorMoveBatch` | holder→S→C (binary `0x0200`) | `[u32 epoch][u8 count]` + count × (`8-byte ref` + 20-byte pose, same pose layout as PlayerMove); server infers cell from the holder, validates epoch, relays cell-scoped |
| `ActorStatsDynamic` | holder→S→C | `{cellKey, epoch, ref, hp={c,b}, mp={c,b}, ft={c,b}}` |
| `ActorEquip` | holder→S→C | `{cellKey, epoch, ref, slots={[n]=recordId,…}}` |
| `ActorAI` | holder→S→C | `{cellKey, epoch, ref|net, combat=u16|false}` — who the actor now fights (a player id) or that it stopped; puppets mirror the state so vanilla's own checks (no rest with an enemy on you) read true. `{…, travel={x,y,z}}` — the holder's own scripted travel. There is no `pkg=` package hint |
| `ActorEffects` | holder→S→C | `{cellKey, epoch, ref|net, add={{id, effects}, …}, remove={{id}, …}}` — the magic that SHOWS on an NPC (invisibility, chameleon, paralyze, levitate…), diffed by instance (#296); puppets add/remove the same active effects |
| `ActorDisposition` | holder→S→C, and dialogue-holder→S→C | `{cellKey, epoch, ref|net, disposition=0..100, ai={fight=,flee=,alarm=}?}` — base disposition is SHARED state (one value on the NPC), so a bribe or a threat reaches every screen. `ai` (#229) is the Fight/Flee/Alarm a result script wrote; every value is clamped 0..100 on both paths (#401) |
| `ActorCellChange` | holder→S→C (BOTH cells) | `{cellKey, epoch, ref|net, toCellKey=string, x,y,z}` — the actor walked through a door; relayed to the cell it left and the cell it entered, and a follow claim moves with it |
| `ActorDeath` | holder→S→C | `{cellKey, epoch, ref|net, killerPlayerId=u16?, deathNo=number, killedRecordId=string?}` — server dedups by (ref, deathNo), persists the death (corpses expire in game time), bumps the kill tally for EVERY death naming a record (vanilla `GetDeadCount` counts all causes); a corpse follows nobody. Under `[economy] noDrop` a unique NPC's corpse is stripped for everyone: `ActorStripLoot {ref|net, cellKey, reason="unique"}` S→C cell-wide |
| `ActorRevive` | holder→S→C | `{cellKey, epoch, ref|net}` — `ActorDeath`'s inverse (#293): the doc forgets the death, then it relays |
| `ActorSnapshot` | holder→S (5 s + on death/combat-start) | `{cellKey, epoch, actors={{ref|net, x,y,z,rotZ, hp,mp,ft, dead, disp?}, …}}` — server stores as `lastSnapshot` for handoff/dormancy |
| `WorldKillCount` | S→C broadcast | `{refId=string, count=number}` — shared kill tally (quest-critical `GetDeadCount`); replayed in full at join |

**The four non-holder claims** (all `ActorAI`, all from a HUMAN standing in or beside the cell,
each `epoch` present but unchecked). Dialogue runs on the talking player's client — never the
holder on a peer-simulated world — so the facts a conversation produces are admitted from the
player the server let talk to that NPC: the live `DialogueLock` holder, or whoever held it in
the last 5 s.

| claim | body | gate | delivery |
|---|---|---|---|
| follow / escort | `{cellKey, epoch, ref|net, follow=<own id>|nil, escort={x,y,z,duration}?}` | `follow` must be the sender's own id (nil = dismissed, only by the followed player); a NEW claim needs the conversation; ≤8 followers per player | stored on the cell doc (`follows`, survives peer and world restarts, rebinds to the character's next session), relayed cell-wide; replayed to whoever next holds the cell as `ActorAI{…, epoch=0, follow, escort?}` |
| travel | `{…, travel={x,y,z}}` (AITravel dialogue result) | the conversation | relayed cell-wide |
| combat | `{…, combat=<own id>}` (a taunt, resisting arrest) | the conversation; about the sender only | relayed cell-wide; the holder starts the real fight |
| position | `{…, position={cell=string?, x,y,z}}` (PositionCell from a player-gated script, backlog 216) | NOT dialogue-gated; ≤5/min per player, coordinates in-world | sent to the HOLDER only, who teleports the real actor; with no holder the client's own move stands |

Client contract: non-holders attach `puppet.lua` to the real cell actors (`addScript` +
`enableAI(false)`) and drive them from `ActorMoveBatch`/stats/death — the SAME puppet path
as remote players, keyed by ref instead of playerId. On `Grant`, detach those puppets,
apply the snapshot, re-enable AI, and simulate. On `Revoke`/handoff, reverse it. Death is
authoritative from the holder; non-holders converge via the 5 s snapshot + stats stream.

## Combat & magic (M5)

Authority model (TES3MP-equivalent): **the attacker's client detects the hit; the victim's
OWNER applies the damage.** For NPCs/creatures the owner is that cell's authority holder
(M4) — under the one-peer model, always the sim peer. For a PLAYER victim who is driving
the input tier, the owner is ALSO the peer (Phase 4B): the hit is applied to their avatar
and the damage travels back as `AvatarStatsBatch`, because the victim's own stat assertions
are ignored while peer bar reports are fresh (Phase 4A one-writer rule). An input-less
victim keeps the classic victim-client delivery. Raw pre-mitigation damage travels; armor,
difficulty, resistances and sounds are applied exactly once, on the victim's owner, by the
engine's own untouched Lua combat pipeline (`files/data-mw/scripts/omw/combat/local.lua`).
**Phase 4C — melee is COMPUTED on the peer.** The owner's `use` bit rides the input tier
(0x0102 flags bit 3); the peer routes it to the avatar (`avatar.lua` maps it onto
`controls.use`), the peer's engine swings, and the hit is resolved natively against the actors
it holds — armor, difficulty, hit chance and all, with no client assertion in the loop. While
a peer simulates the target's cell, a client's REAL swing is cancel-only (puppet.lua still
returns false to stop local ghost damage; combat.lua no longer forwards it), so a blow lands
exactly once. The `CombatHit` relay survives for exactly two callers: **degraded mode** (no
holder for the cell: forward as before — victim-applies for players, held/dropped for actors)
and the **test hooks** (`hitn`/`hitp` mark the synthetic Hit `mpTest`, which is the only
swing combat.lua forwards). **Relay reality (#362):** a HUMAN `CombatHit` arriving while a
simulator holds the target's cell is refused server-side (`combat_hit_refused`, silent to the
attacker) — that covers `mpTest` too, until the `[limits] harness` seam of #390 lands. In
degraded mode (no holder) there is no melee relay either: the client never forwards a real
swing, an actor-target hit is parked up to 6 s for a grant and then `CombatRefused`, and only
a player-target hit reaches its victim. Magic still forwards (`CombatSpellHit`) — the avatar
does not cast. The authoritative pose stream's flags bit 3 reports "avatar attacking" back to
the owner and to observers.

| name | dir | body |
|---|---|---|
| `CombatHit` | attacker→S→victim-owner | `{target={playerId=u16} \| {ref|net, cellKey=, epoch=?}, damage={health=n, fatigue=n?, magicka=n?} (≥1 channel, each ≤ `[limits] maxHitDamage`), strength=n, sourceType=string, weaponId=string?, ammoId=string?, hitPos={x,y,z}?, successful=bool}` — delivered with **`attackerId=u16`** added. 8/s per attacker, burst 20 |
| `CombatCast` | caster→S→cell-scoped | `{spellId=string, target={playerId}\|{ref|net,cellKey}\|nil, casterId=u16, kind="spell"\|"enchant"\|"potion"}` — visual/animation mirroring only; relayed with **`fromId=u16`** added. A cast also explains the caster's next same-cell teleport (Recall, Intervention: #361) |
| `CombatSpellHit` | caster→S→victim-owner | `{target={playerId}\|{ref|net,cellKey,epoch?}, spellId=string (net id: a spell, an enchantment, or the ITEM a scroll/cast-when-used source names), effects={{id=string, magnitude=n, duration=n, beneficial?=bool, index?=n}, …} (≤64), casterId=u16, beneficial?=bool, indexes?={n,…} (which of the record's effects hit, 0-based, < 64; absent = all), ignoreReflect?=bool (the hit is itself a reflection)}` — delivered with **`attackerId`** and the resolved `beneficial` added. Routed only when the caster's doc knows the source (spellbook or inventory; the sim peer is exempt). |

`CombatProjectile` is **dead**: the server still validates and relays it cell-scoped with
`fromId`, no client sends it, and `MP_CombatProjectile` is a deliberate no-op on the client
(the attacker owns the real projectile; there is nothing to mirror). Do not build on it.

Rules:
- The server validates shape + plausibility only (finite, `damage.health` within a config
  cap, target exists, attacker's cell visible to the target's) and routes: player targets →
  that player's session — or the WORLD PEER when the victim is driving the input tier (fresh
  `PlayerInput` ≤5 s), since the avatar is where the body is; actor targets → the cell's
  current authority holder. It never computes damage — it has no game data. Refusals the
  attacker is told about (`CombatRefused {reason}`): `cell has no authority holder`,
  `authority holder gone`, `stale epoch`; shape/rate/PvP refusals are logged and dropped.
- Actor targets: `epoch` is **optional** here, unlike the holder-authored `Actor*` family.
  The attacker is usually a NON-holder, so presence is proven by proximity (the attacker's
  own cell must be visible to `target.cellKey`) and the hit is routed to whoever holds the
  cell at arrival time. When `epoch` IS supplied it must be current, so a mid-handoff hit
  cannot land on the wrong simulator. Clients may take the live epoch from
  `ActorAuthorityInfo`/`ActorAuthorityGrant`, or omit it entirely.
- **PvP gate**: when `[rules] pvp = false`, `CombatHit`/`CombatSpellHit` whose target is a
  *player* are dropped server-side (the `pvp` plugin owns this decision so operators can
  replace it). Actor targets are unaffected. A `CombatSpellHit` crosses the gate only when
  `beneficial` is true AND no effect entry says `beneficial=false` (a heal on a friend is help;
  a record that heals and burns is an attack — the client keeps the heal and drops the burn).
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
| `JournalEntry` | C→S; relayed to all when `[sharing] journal` | `{questId=string, index=number, actorRefId=string?}` — server arbitrates **monotonic max per questId** (a lagging client can never regress a shared quest); a regression is dropped unless the writer is the world owner or the sim peer, or `questId` is in the operator's `regressAllowlist`; a stage the dated log already holds is a replay (no write, no relay). Written to the CAMPAIGN doc (`journalTarget`: the world owner's character; a guest keeps nothing from a visit) |
| `JournalSync` | S→C at join | `{quests={[questId]=index, …}, borrowed=bool, journalLog={{q=questId, i=index, d=daysPassed, m=month, dm=day}, …}}` — the shared journal (shared mode, seeded as max(shared, owner's own) at boot) or the player's own (individual mode). `borrowed=true` tells a GUEST this is a campaign that is not their character's: set your own journal aside for the visit and put it back on the way home (sent on every join, so a missed transition self-repairs). `journalLog` is the dated list in the order earned, newest `MAX_JOURNAL_LOG` = 5000 entries (#321) |
| `GlobalVarUpdate` | C→S; relayed to all when `[sharing] questVars` | `{name=string, value=number, seq=number?}` — MWScript globals; **last-write-wins with a per-variable sequence**; the time globals (`GameHour/Day/Month/Year/DaysPassed`) are EXCLUDED here and owned by M7. Character globals (player-state flags, werewolf…) are stored on the writer's own doc and relayed live without a seq (backlog 224); a human write within 5 s of the peer's write to the same name is dropped (Phase 4E) |
| `GlobalVarSync` | S→C at join | `{globals={[name]=number, …}}` — the campaign's stored world globals plus this character's own character globals; the client applies them before its scripts run |
| `MemberVarUpdate` | C→S; relayed cell-scoped (the cell's HOLDER hears it wherever it stands) | `{ref|net, name=string, value=number}` — per-object MWScript locals, piggybacked on object interaction and on the dialogue lock (watched for the whole conversation, last diff on release); stored on the cell doc (2000 per cell) and replayed in `WorldCellState.memberVars`. Same 5 s peer-owned rule as globals |
| `FactionUpdate` | C→S; relayed when `[sharing] factions` | `{factionId=string, rank=-1..20, reputation=number?, expelled=bool?}` — never from the peer |
| `TopicsLearned` | C→S; relayed when `[sharing] journal` | `{topics={string,…}}` (1..64 ids) — dialogue topics follow the journal's sharing rule; relayed as `{topics, byId}` |
| `CrimeUpdate` | C→S; relayed when `[sharing] crime`; S→C | `{bounty=number ≥0, kind=string?}`. Shared: the bounty is the PARTY's one record — a claim LOWER than it is refused unless the sender talked to an NPC (paid a fine, was arrested) within 10 s, and the server echoes `CrimeUpdate {bounty=<party's>, shared=true}` back to that sender; accepted values are relayed to everyone as `{bounty, kind?, byId=u16, shared=true}`. Individual: stored on the sender's doc and sent to the WORLD PEER only as `{bounty, byId, kind?}` (the avatar's guards need to know) |
| `PlayerCrime` | PEER→S→owner | `{id=u16, bounty=number (|n| ≤ 100 000), kind=string?, faction=string?}` — the avatar committed a crime on the peer (assault, murder); the owner's client receives `{bounty, kind?, faction?}`, applies the increment and its own `CrimeUpdate` then carries the total; `faction` = the victim's faction to expel itself from (backlog 144). World peer only |
| `PlayerArrest` | PEER→S→owner | `{id=u16, guard=<RefNum>}` — a guard reached the wanted avatar on the peer; the owner's client receives `{guard}` and opens the arrest dialogue with its copy of that guard. World peer only |
| `DialogueLock` | C→S | `{ref|net, cellKey=, want=bool}` → `DialogueLockResult {ref, granted=bool, holderId=u16?}` — one player may converse with an NPC at a time. Gates: `want=true` is refused with `holderId` while another IN-WORLD player holds it, refused (`lock from afar`) when `cellKey` is not visible to the sender, and taking a lock releases the sender's others (one conversation at a time); `want=false` always answers `granted=false`. Released on close, cell change, or disconnect. Either edge stamps the sender as "talked" for 5 s (#361/#366), and a released lock keeps its holder for 5 s for the M4 claims |
| `GlobalScriptsUpdate` | C→S | `{started=[scriptId…]?, stopped=[scriptId…]?}` (≤256 each, lowercased) — the running GLOBAL scripts (Sleepers, VampireCheck, MoveMehra…) diffed every few seconds; stored as `scripts` on the campaign doc (`journalTarget`) so a relog keeps them running. `GlobalScriptsSync {running=[…]}` S→C at join: the client starts any it lacks |

Kill counts ride M4's `WorldKillCount`. Applying a received journal/faction/var update MUST
NOT re-broadcast it (echo guard) — clients seed their diff caches from applied state.

### Phase 4E — the peer's MWScript writes win, and clients receive them

Under the one-peer model the peer runs every cell script authoritatively, but each client's
engine runs its LOCAL COPY of the same scripts on the same puppeted actors, so a global or
member variable gets written twice and character globals were last-writer-wins. Rule: a
client `GlobalVarUpdate` / `MemberVarUpdate` for a name the **peer wrote within
`INPUT_DRIVING_MS`** is dropped (`quest.global_peer_owned` / `quest.member_peer_owned`);
names the peer never writes — dialogue-result scripts run only on the client that talked —
are untouched, so dialogue-driven quest state is exactly as before. And **character-global**
writes are relayed live to every client in the world whoever wrote them (the peer's from
Phase 4E; a human's since backlog 224 — one campaign per instance, and the other human's
journal had already advanced with it), so local script copies stop holding a stale value
until the next login's `GlobalVarSync`. Persistence is unchanged: `journalTarget` already
routes a system sender to the world owner's doc (standalone stacks and an offline owner
persist nothing for the peer, as they did for guests — live relay still happens).

## World state (M7)

| name | dir | body |
|---|---|---|
| `WorldTime` | S→C (60 s + on change + at join) | `{gameHour=number, day=number, month=number, year=number, timeScale=number}` — the server owns the clock; clients slew rather than snap |
| `WorldTimeRequest` | C→S | `{advanceHours=number (0 < h ≤ 720), reason="rest"\|"wait"\|"script"}` — the server applies and rebroadcasts, so resting advances time for everyone; refused per `[rules] timeSkip` with `WorldTimeRefused {reason}` |
| `WorldRegionChange` | C→S | `{region=string}` — the client declares which region it is in (cell→region mapping lives in the content files, so the server cannot derive it); drives region occupancy and weather-authority handoff |
| `WorldWeather` | C→S from the region authority; S→C broadcast | `{region=string, current=number, next=number?, transition=0..1?}` — non-holders are dropped; also replayed per known region at join |
| `WorldWeatherAuthority` | S→C | `{region=string, holderId=u16}` — same holder pattern as cells, keyed by region; `holderId` equal to your own id means YOU simulate the weather there, `holderId=0` means the region has no authority (you just lost it). Handoff goes to the longest-present occupant; an emptied region folds its last weather and resumes it for the next claimant |
| `RecordCreate` | C→S | `{tempId=number, kind="spell"\|"potion"\|"enchantment"\|"armor"\|"weapon"\|"clothing"\|"book"\|"misc", data=table (≤128 fields)}` → `RecordCreateAck {tempId, recordNetId=string}`. `data` is held to caps (≤8 effects, magnitude ≤100, duration ≤1440, a spell's `cost` ≥ its computed floor, weapon/armor/charge/speed/reach ceilings); a record beyond them is dropped and counted. 50 000 custom records per world |
| `RecordsSync` | S→C at join, and to peers on every `RecordCreate` | `{records={{recordNetId, kind, data}, …}}` — replay all custom records so cross-client ids resolve (fixes the M3 dynamic-record placeholder problem for player-made items). At join it is the COMPLETE set; after a creation it carries just the one new record, so peers can resolve the id before the item is used, not only at their next join |
| `WorldCellReset` | S→C (all players) | `{cellKey=string}` — cell doc wiped on the operator's schedule (`[cellReset]`, persisted across restarts); clients drop local deltas and reload |
| `WorldMapExplored` | C→S; relayed when `[sharing] map` | `{cellKeys={string,…}}` (≤8192) — exterior keys are stored on the sender's doc (and the owner's when shared; newest 8192, #388) and relayed as `{cellKeys, byId}`, sender excluded |

## Ops (M8)

**Ranks** live on the account (`accounts/<name>.json`, seeded from `[admin] owners`):
`0` player, `1` moderator, `2` admin, `3` owner.

**Operator commands have ONE entry point: the admin dashboard** (`POST /admin/api/command`,
server.ts `runCommand` → `Admin.exec`). There is no typed `/slash` path and no
`AdminCommand` event: a chat line beginning with `/` is chat like any other, and a client
has no way to ask the server for an operator command. Players **report** from the social
panel (`ReportPlayer`, Phase C below), which writes `reports/<ts>-<reporter>.json` with the
target's current cell and the last `[moderation] contextLines` chat lines; `reports` and
`chatlog` are rank-1 dashboard commands. Chat is persisted to `logs/chat-YYYY-MM-DD.jsonl`
— see PRIVACY.md.

| name | dir | body |
|---|---|---|
| `ConsoleCommand` | S→C, owner-gated | `{script=string}` executed client-side. Remote code execution on the player's own machine: rank 3 only, removable with `[admin] allowConsole=false`, and every use is logged with actor, target and full payload |
| `AdminTeleport` | S→C | `{cellKey=string, x=, y=, z=}` — the `tp` and `tpto` effect; the client moves the player and then reports the move normally (`PlayerCellChange`) |
| `AdminGive` | S→C | `{recordId=string, count=number}` — the `give` effect; the client adds the item and reports inventory as usual |

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

- `FriendRequest{name}` · `FriendAccept{name|acct}` · `FriendRemove{acct}` — accept takes the
  sender's NAME from the panel (the account key is not on the wire) and resolves it against
  the shared account index, so a request from someone in their own world can be accepted.
- `BlockAdd{name}` · `BlockRemove{acct}`
- `InviteSend{acct}` · `InviteAccept{acct}` — travel-to invite. Invites are stored shared
  so they reach a player in another world; accepting one from someone who is NOT in this
  world therefore answers with `JoinFriend` (the world switch) instead of `InviteAccepted`,
  since no coordinate in this world would mean anything.
- `PresenceMode{mode}` — one of `public` `friends` `private`
- `SetAvailability{state}` — `online` | `offline`: the where-am-I switcher's "appear
  offline"; friends get a `PresenceUpdate`.
- `MuteAdd{name}` · `MuteRemove{acct}`
- `ReportPlayer{name, reason}` — files a moderation report with the target's current cell and
  the last `[moderation] contextLines` chat lines (`reason` ≤500 chars; one report per
  reporter→target pair per cooldown). An OFFLINE name is accepted and recorded as typed (the
  griefer who logs off the moment they are done is the ordinary case). This is the only way
  to report; there is no typed command. (A `voice` flag used to ride here; nothing ever set
  it — dropped, #402.)
- `WorldList{}` → S→C `WorldList` · `WorldCreate{id, mode}` → S→C `WorldCreate` — the
  gateway's world browser (bodies in §Server-to-client replies).
- `JoinFriend{acct}` — dial into a friend's party world: refused with
  `JoinFriend{ok=false, error="self"|"in_chargen"|"not_friends"|"blocked"|"not_online"|"no_gateway"|"not_open"}`,
  else `JoinFriend{ok=true, worldId, mode, host, port, wsPath?, friendName}` and the client
  reconnects there (sending `PlayerLeaving` first).
- `SetWorldMode{mode}` — the OWNER flips this world `private` (solo) / `party`; answered by
  `SocialResult{op="SetWorldMode", ok, detail=mode|"not_owner"|"bad_mode"|"not_flippable"}`.
  Flipping to solo sends every guest `WorldClosed` and home.
- `WorldKick{name}` — the owner sends one guest home; `SocialResult{op="WorldKick", ok,
  detail="ok"|"not_owner"|"no_such_player"|"self"}`.

Server → client:

- `FriendList{friends:[{acct, name, online, playerId?, cellKey?}], blocked:[{acct, name}],
  muted:[{acct, name}], requests:[{acct, name}], invites:[{acct, name}]}` — full snapshot, sent
  on join, after any mutation, and on the presence heartbeat (the client rebuilds its panel from
  it; there is no incremental form). `blocked` and `muted` are the player's own lists, so the
  panel can offer the way back.

  `requests` and `invites` are what is WAITING for this player, and the snapshot is what
  actually delivers them. `FriendRequestReceived` and `InviteReceived` only reach a target who
  is in the sender's world, and two people each in their own game is the ordinary case — so
  without these fields a friend request or an invite sent across worlds was stored and never
  mentioned until the recipient next reconnected. Blocked senders are filtered out of both.
- `PresenceUpdate{acct, online, playerId?}`
- `FriendRequestReceived{fromAcct, fromName}` · `InviteReceived{fromAcct, fromName}` — both
  are pushed only when the sender is in the RECIPIENT'S world. The `FriendList` snapshot
  carries pending requests and invites for everyone else, and the presence heartbeat
  resends it, so a request or invite from a friend in their own game arrives while the
  recipient is online rather than on their next reconnect.
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

## Server-to-client replies and pushes

These are sent by the server and were, until now, documented only in the source. They are
listed here so the wire surface has one complete index: a coverage audit built from this file
silently skipped every one of them.

| name | dir | body |
|---|---|---|
| `CombatRefused` | S→C | `{reason=string}` — an M5 attack the server would not apply (rate, shape, PvP veto). Told rather than dropped, so a swing that does nothing is explainable |
| `WorldTimeRefused` | S→C | `{reason=string}` — the `[rules] timeSkip` refusal. A Rest that silently does nothing gets pressed again and reported as a bug |
| `ObjectSpawnRefused` | S→C | `{tempId=number, ok=bool, reason=string}` — M3 drop conservation and placement refusals |
| `ObjectTakeResult` | S→C | `{opId=number, ok=bool, reason=string?}` — the paired answer to `ObjectTakeRequest`; always sent, so a client never waits |
| `CellSnapshotReplace` | S→C | `{cellKey=string, placed={…}, deleted={…}}` — the restored cell truth pushed straight after a `WorldCellReset`, so a reset is transparent rather than a kick |
| `QuestSpawn` | S→C on cell entry, or on a client's actor spawn request | `{recordId=string, questId=string?, cellKey=string, forId=u16?, x=, y=, z=, count=?}` — the operator's quest-repair rules replacing an object the character still needs; or (backlog 214) a client's `ObjectSpawnRequest{actor=true, …}` (a `PlaceAtPC` its engine declined to build) forwarded to the cell's holder with its spot, 10/min per player, refused with `ObjectSpawnRefused{reason='rate'}` past that |
| `WorldList` | S→C, answering the C→S `WorldList` | `{error=string, myPort=number, worlds={{id, mode, name, host, port, wsPath?, playerCount, maxPlayers, up}, …}}` — mapped field by field: the gateway's record carries `ownerAccount` and it must never reach a client |
| `WorldCreate` | S→C, answering the C→S `WorldCreate` | `{ok=bool, error=string, world={id, mode, name, host, port, wsPath?}?}` |
| `WorldMode` | S→C at join and on change | `{mode=string, owner=string, isOwner=bool, ownerId=u16}` — this world's mode, for the where-am-I switcher; `ownerId` (0 when absent) is what the sim peer rolls levelled lists against |
| `WorldClosed` | S→C | `{reason=string, by=string}` — the owner took the world solo; guests are told before they are disconnected |
| `SimReady` | S→C | `{ready=bool}` — whether a world peer is simulating yet |
| `SimAnchors` | S→PEER | `{anchors={{x,y,z}, …}, interiors={cellKey, …}, place={cellKey, x,y,z}?}` — the cells the peer is to simulate (exterior anchor points + interior names) and where its dummy stands |
| `AvatarRestore` | S→PEER | `{id=int, hp?, mp?, ft?}` — restore an avatar's bars from the stored doc |
| `AvatarResurrect` | S→PEER | `{id=int, …}` — the peer-side half of a respawn |
| `AvatarActiveSpells` / `SelfActiveSpells` / `SelfSpells` / `SelfSkillUse` / `SelfItemStates` / `SelfStats` | S→C | see §M2 and §Phase 4A/4D — the owner-only (`Self*`) and observer (`Avatar*`) halves of the peer's reports |
| `ActorStripLoot` | S→C cell-wide | `{ref|net, cellKey, reason="unique"}` — see §M4 `ActorDeath` |
| `PlayerCrime` / `PlayerArrest` | S→C (owner) | see §M6 — the peer's crime and arrest reports, forwarded to the wanted player |
| `StateRefused` | S→C | `{kind=string}` — see §M0 |

## Client-side integration contract (M0)

- Join URL: `index.html?...&mp=<ws(s)-url>&name=<display-name>`; boot JS sets
  `ENV.OPENMW_MP_URL` / `OPENMW_MP_NAME` and appends `content=mp.omwscripts`.
- The page bridge (the HTML overlays and `wasm-build/mp-harness.mjs` both use it):
  `window.omw.state` is what Lua mirrors with `mp.set(key, value)` (`state`, `playerId`,
  `players`, `chatLog`, `friends`, …); `window.omw.send(text)` queues a command string
  for Lua, which drains the whole queue each frame (`mp.pollCommands`) and acks each entry
  (`mp.emit('ack', {id, ok, detail})`), so the returned promise resolves once the command
  has actually run; `window.omw.on(name, fn)` hears any event Lua emits;
  `&mpauto=1&mpuser=<account>` auto-registers/logs in with a fixed harness password.
