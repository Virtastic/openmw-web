# omw-mp.1 wire protocol

Authoritative contract between the browser client (C++ `mwmp/` transport + `scripts/mp/` Lua)
and the `openmw-mp` server. This file is the source of truth; both sides cite it in code
comments. Scope grows per milestone — sections are tagged with the milestone that introduces
them. Current: **M0**.

## Transport (M0)

- WebSocket, path `/ws`, subprotocol `omw-mp.1` (server rejects other subprotocols).
  The dot is deliberate: `/` is not a legal RFC 6455 subprotocol token character — WHATWG
  WebSocket clients throw on it before any I/O. The protocol NAME in prose stays "omw-mp/1".
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
since the last tick. Visibility = same cell, or adjacent exterior grid cells. When a player
first becomes visible (join, cell entry), the server sends their current pose in the next
batch unconditionally. Client transport decodes this in C++ and delivers ONE global Lua
event `MP_MoveBatch` whose body is an LSER array of
`{id=number, x=..., y=..., z=..., yaw=..., pitch=..., flags=..., animVel=...}`.

## Event-tier additions (M1)

| name | dir | body |
|---|---|---|
| `PlayerCellChange` | C→S, relayed S→C with `id` added | `{cellKey=string, x=number, y=number, z=number}` — `cellKey` = `"x,y"` for exteriors (comma, integers) or the lowercased interior cell name. Updates server occupancy; receivers despawn/teleport that player's puppet. |

M1 semantics: clients MUST send `PlayerCellChange` immediately after `SessionReady` (until
then they are visible to nobody and receive no batches); the relay goes to ALL in-world
players INCLUDING the sender (ignore your own id); the server synthesizes/refreshes the
stored pose at the cell-change coordinates so never-moving players still spawn for newly
visible peers; move `seq` is strictly increasing per connection; movement bytes count
against `bytesPerSec` but not `msgsPerSec` (own `moveMsgsPerSec` budget, default 40).

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

Client → server:

- `{"t":"SessionHello", "proto":1, "engineHash":"<12-hex or empty>", "lserVersion":0,
   "manifest":[{"name":"Morrowind.esm","size":123,"idx":0}, …], "resumeToken":"<opt>"}`
  Manifest = the client's content files in load order (`strict` mode adds `"sha256"`,
  M0 implements `names` mode: name+size+order). Reality check: OpenMW 0.52 Lua exposes
  content-file NAMES only (`core.contentFiles.list`, lowercased) — sizes are unreachable,
  so clients always send `size:0` and `names` mode effectively compares name+order.
- `{"t":"SessionRegister", "account":"name", "password":"…", "serverPassword":"<opt>",
   "inviteCode":"<opt>"}`
- `{"t":"SessionLoginRequest", "account":"name", "password":"…", "serverPassword":"<opt>"}`
- `{"t":"SessionReady"}` — after the client has applied `SessionWelcome` and is in-game.
- `{"t":"SessionPing", "clientTime":<ms>}`

Server → client:

- `{"t":"SessionHelloOk", "serverName":"…", "contentPolicy":"names|strict|off"}`
- `{"t":"SessionWelcome", "playerId":<u16>, "sessionToken":"<hex>", "motd":"…",
   "flags":{}, "playerRecord":null, "serverSeq":<u32>}`
  (`playerRecord:null` → fresh character; non-null restore lands in M2. `serverSeq` = binary
  seq already consumed on this connection: 0 at welcome, first server Event frame is seq 1.)
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
| `PlayerDeath` | C→S `{}` | server runs respawn/death-penalty plugins |
| `PlayerResurrect` | S→C `{cellKey=string, x=,y=,z=, restoreHp=bool}` | client teleports self, restores dynamic stats, clears death |

Rejoin restore (M2): `SessionWelcome.playerRecord` is non-null once the server has stored a
snapshot: `{appearance={…}, equipment={…}, inventory={…}, stats={dynamic=…, attributes=…,
skills=…, level=…}, spells={…}, position={cellKey=, x=,y=,z=}}`. The client applies it
instead of running chargen and teleports to `position`. The server flushes the player doc
on: cell change, level-up, equipment change (10 s debounce), logout, SIGTERM. Appearance
relays are the puppet-record source of truth — clients rebuild a puppet's NPC record when
an appearance arrives for an already-spawned puppet.

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

Semantics: the server persists per-cell delta docs (`world/cells/<cellKey>.json`) and is
the serialization point — ops are applied in server-arrival order and rebroadcast with
`stateSeq`/order intact. Containers are transactional at the server (conservation-checked;
losing racer gets `ok=false, reason="gone"`); clients may apply optimistically and MUST
reconcile to `ContainerState`/`ContainerUpdate` on reject. `refKey` string form for doc
maps: `"c:<index>:<contentFile>"` for content refs, `"n:<netId>"` for spawned.

## Client-side integration contract (M0)

- Join URL: `index.html?...&mp=<ws(s)-url>&name=<display-name>`; boot JS sets
  `ENV.OPENMW_MP_URL` / `OPENMW_MP_NAME` and appends `content=mp.omwscripts`.
- Test/automation surface (for `wasm-build/mp-harness.mjs`): `window.__omwMP` mirrors
  `{state, playerId, lastChat, players}` and accepts `window.__omwMP.sendChat(text)`;
  `&mpauto=1&mpuser=<account>` auto-registers/logs in with a fixed harness password.
