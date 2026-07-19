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
| `0x0100` | PlayerMove (C→S) | M1 (reserved) |
| `0x0101` | PlayerMoveBatch (S→C) | M1 (reserved) |
| `0x0200` | ActorMoveBatch | M4 (reserved) |

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

## Client-side integration contract (M0)

- Join URL: `index.html?...&mp=<ws(s)-url>&name=<display-name>`; boot JS sets
  `ENV.OPENMW_MP_URL` / `OPENMW_MP_NAME` and appends `content=mp.omwscripts`.
- Test/automation surface (for `wasm-build/mp-harness.mjs`): `window.__omwMP` mirrors
  `{state, playerId, lastChat, players}` and accepts `window.__omwMP.sendChat(text)`;
  `&mpauto=1&mpuser=<account>` auto-registers/logs in with a fixed harness password.
