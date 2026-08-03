-- Multiplayer GLOBAL orchestrator (omw-mp/1, M0+M1) — see server/PROTOCOL.md.
-- Connects on game start when the boot JS enabled MP (?mp= -> ENV OPENMW_MP_URL), drives the
-- session via scripts/mp/net.lua, maintains the player roster and forwards chat to the
-- player script. M1: owns remote-player puppet lifecycle (spawn/despawn/teleport) and routes
-- MP_MoveBatch entries to the per-puppet scripts. Mirrors {state, playerId, players, puppets}
-- into window.__omwMP for the harness.
local core = require('openmw.core')
local mp = require('openmw.mp')
local types = require('openmw.types')
local I = require('openmw.interfaces')
local util = require('openmw.util')
local world = require('openmw.world')

local json = require('scripts.mp.json')
local net = require('scripts.mp.net')

-- Where-am-I switcher state. `worldUrls.own` = this character's own world (Solo/Party — the
-- same instance, mode-flipped in place); `worldUrls.public` = the one shared world, learned
-- from the directory. `pendingFlip` defers a Solo<->Party flip until we are back in our own
-- world (you cannot flip the public world).
local worldUrls = {}
local pendingFlip = nil
local pendingPublic = false

-- Chargen gate: multiplayer surfaces (chat, social, leaving your solo world) unlock only once
-- character creation is DONE (race/class/sign chosen — mwscript CharGenState == -1). Mirrored
-- to JS so the HTML overlays hide themselves until then; mpWhere refuses too. Never un-done:
-- once true it stays true for the session (an existing character starts at -1 immediately).
local chargenDone = false
local chargenReported = false
-- Build the URL to dial for a world entry.
--
-- PREFER wsPath: production publishes NO world ports (the edge reaches only the gateway on
-- 443, deploy/openmw-mp.caddy), so a world is reachable solely by asking the gateway to
-- splice us through — `/w/<worldId>` on the origin we are already connected to. Falling back
-- to host:port keeps a direct local connection working, where the ports ARE published.
local function worldUrlOf(w)
    if type(w) ~= 'table' then return nil end
    if type(w.wsPath) == 'string' and w.wsPath ~= '' then
        -- Same scheme and authority as the current connection: wss stays wss, so a page on
        -- https never tries to open an insecure socket.
        local cur = net.currentTarget() or ''
        local scheme, authority = cur:match('^(wss?)://([^/]+)')
        if scheme and authority then return scheme .. '://' .. authority .. w.wsPath end
    end
    if w.host and w.port then
        return 'ws://' .. tostring(w.host) .. ':' .. string.format('%d', w.port) .. '/ws'
    end
    return nil
end

local function chargenTick()
    if chargenDone and chargenReported then return end
    if not chargenDone then
        local ok, v = pcall(function() return world.mwscript.getGlobalVariables()['chargenstate'] end)
        if ok and v == -1 then
            chargenDone = true
            mp.testSet('chargenDone', '1')
        end
    end
    -- Tell the server creation FINISHED for this slot: until this lands the character is
    -- provisional, and abandoning creation resets it instead of saving a half-made one.
    -- Re-sent each session (idempotent) so pre-flag characters self-migrate.
    if chargenDone and not chargenReported and net.state == 'Joined' then
        mp.sendEvent('ChargenComplete', {})
        chargenReported = true
    end
end
local voice = require('scripts.mp.voice')
local threat = require('scripts.mp.threat')
local objects = require('scripts.mp.objects')
local actors = require('scripts.mp.actors')
local combat = require('scripts.mp.combat')
local quests = require('scripts.mp.quests')
local worldmp = require('scripts.mp.world')
local admin = require('scripts.mp.admin')

local roster = {} -- array of {id=u16, name=string}, server order
-- Monotonic across every "this was done TO you" event (world closed, party travelled). The UI
-- compares THIS, not the payload: the payloads repeat verbatim, so value comparison could not
-- tell a second occurrence from a stale mirror.
local noticeSeq = 0
-- Said once per session, not once per join: a world switch and every reconnect re-enter the
-- Joined state, and repeating the banner buried the actual conversation.
local announcedConnect = false
-- Last party roster we told the player about, so membership changes can be diffed.
local partySeen = {}
-- What the world we are connected to says it is. SERVER-OWNED: the switcher used to render
-- from a localStorage note of what was last clicked, so it could sit on "Public" while the
-- connection was to your own world and no amount of clicking fixed it.
local worldMode = 'solo'

local function mirrorRoster()
    mp.testSet('players', json.encode(roster))
    -- WHO WE ARE, by id. The UI used to filter itself out of the Players list by comparing
    -- the roster name against the character name it was booted with — and those are two
    -- different strings now that the roster carries USERNAMES, so players saw themselves
    -- with add-friend/party/mute/block buttons. The connection id is the only identity both
    -- sides agree on.
    mp.testSet('selfId', tostring(net.playerId or ''))
    -- WHICH WORLD WE ARE ACTUALLY IN. The switcher used to render from a localStorage value
    -- of what the player last CLICKED, which survives reloads and reconnects — so after a
    -- redial to your own world the panel still read "Public" and the whole UI lied about
    -- where you were. The dialled target is the truth; publish it.
    mp.testSet('whereNow', worldMode == 'public' and 'public'
        or worldMode == 'party' and 'party' or 'solo')
    -- The social hub lists everyone currently playing, and the roster lives here. Forwarded
    -- rather than duplicated so there is one source of truth for who is online.
    local player = world.players[1]
    if player then player:sendEvent('MP_Roster', { players = roster }) end
end

local function playerScript()
    return world.players[1]
end

-- G2 render LOD. Everyone stays VISIBLE; distance buys a cheaper simulation, not a
-- despawn. Tiers reuse the server's network-LOD radii (delivered in SessionWelcome) so a
-- puppet whose poses arrive at 1 Hz is never simultaneously asked to walk smoothly between
-- them — matching the two is what makes the degradation look deliberate instead of broken.
-- Radii are squared once per batch, never per puppet.
local TIER_NEAR, TIER_MID, TIER_FAR = 0, 1, 2
-- Counts are keyed by NAME, not by the numeric tier: a Lua table keyed {[0]=n} serialises
-- as an empty object (json sees no index 1 and calls it an empty array), so the numeric
-- version mirrored "{}" no matter how many avatars were degraded — and a test asserting
-- "nobody was degraded" then passed against no data at all.
local TIER_NAME = { [0] = 'near', [1] = 'mid', [2] = 'far' }
local tierSeen = {} -- tier name -> count, reset each batch (mirrored for the capacity tests)
local d2Buf, nearBuf, entryBuf = {}, {}, {} -- scratch, reused across batches (runs 15x/second)

-- The near RADIUS alone does not bound cost, and the case where it fails is the one that
-- matters: in a tight crowd — a market square, a guild hall, everyone piling onto one
-- quest giver — every avatar is inside the near radius, so every avatar stays fully
-- simulated and frame time scales with the crowd exactly as it did before any of this.
-- The cap fixes the worst case regardless of how players cluster: at most `maxNear`
-- avatars are ever fully simulated, and the nearest ones win. Returns the effective
-- squared near cutoff for this batch.
local function nearCutoff(nearR2, maxNear, count)
    if maxNear <= 0 then return nearR2 end -- cap disabled
    local n = 0
    for i = 1, count do
        local d2 = d2Buf[i]
        if d2 >= 0 and d2 <= nearR2 then
            n = n + 1
            nearBuf[n] = d2
        end
    end
    if n <= maxNear then return nearR2 end -- under the cap: radius governs
    for i = n + 1, #nearBuf do nearBuf[i] = nil end -- drop last batch's tail before sorting
    table.sort(nearBuf)
    return nearBuf[maxNear] -- the K-th nearest becomes the cutoff
end

-- teleport() throws when the object is mid-teleport or was removed between the isValid()
-- check and the call, and an engine handler that throws aborts — taking the rest of the
-- handler with it and polluting the error log, which then masks real failures.
--
-- Deliberately different from the removeScript case: THAT pcall hid a permanent API mistake
-- (the binding does not exist on a local self) and should never have been swallowed. This
-- guards a genuinely TRANSIENT engine state, and the position self-corrects — the next pose
-- batch sees the divergence and requests a snap. Returns whether the move happened.
local function tryTeleport(obj, cellArg, pos)
    if not obj or not obj:isValid() or not cellArg then return false end
    local ok = pcall(function() obj:teleport(cellArg, pos) end)
    return ok
end

local function toPlayer(eventName, data)
    local player = playerScript()
    if player then player:sendEvent(eventName, data) end
end

-- Golden-vector dump for the server's LSER codec tests (&mpvectors=1 -> ENV OPENMW_MP_VECTORS).
-- Prints `MPVECTOR:<name>:<base64>` lines to the console log; capture headlessly and feed to
-- the server test suite.
local function dumpVectors()
    local util = require('openmw.util')
    local vectors = {
        { 'bool_true', true },
        { 'bool_false', false },
        { 'num_zero', 0 },
        { 'num_negzero', -0.0 },
        { 'num_neghalf', -0.5 },
        { 'num_int', 42 },
        { 'num_bigint', 2^52 },
        { 'num_huge', 1e300 },
        { 'str_empty', '' },
        { 'str_short', 'hello' },
        { 'str_31', string.rep('a', 31) },
        { 'str_32', string.rep('b', 32) },
        { 'str_255', string.rep('c', 255) },
        { 'str_unicode', 'héllo wörld — ✓ 日本語' },
        { 'table_empty', {} },
        { 'table_flat', { a = 1, b = 'two', c = true } },
        { 'table_nested', { outer = { inner = { deep = 'value', n = 3 } } } },
        { 'table_array', { 10, 20, 30 } },
        { 'table_mixed', { 1, 2, key = 'val' } },
    }
    local ok, vec3 = pcall(function() return util.vector3(1.5, -2.5, 3.25) end)
    if ok then vectors[#vectors + 1] = { 'vec3', vec3 } end
    for _, entry in ipairs(vectors) do
        local okSer, b64 = pcall(mp.debugSerialize, entry[2])
        if okSer then
            print('MPVECTOR:' .. entry[1] .. ':' .. b64)
        else
            print('MPVECTOR-SKIP:' .. entry[1] .. ':' .. tostring(b64))
        end
    end
end

-- Player-visible session notices. State changes can fire before the player object exists
-- (connection races game start), so buffer and flush from onUpdate once world.players[1]
-- is there. Chat lines also pop as screen messages (player.lua pushMessage), so these are
-- visible without the chat window open — that's the whole point for real players.
local pendingNotices = {}

local function notice(text)
    pendingNotices[#pendingNotices + 1] = { channel = 'server', text = text }
end

local function flushNotices()
    if #pendingNotices == 0 then return end
    local player = playerScript()
    if not player then return end
    for _, n in ipairs(pendingNotices) do
        player:sendEvent('MP_UiChatMessage', n)
    end
    pendingNotices = {}
end

-- Human-readable reasons for the codes a real player can actually hit.
local FAIL_TEXT = {
    AUTH_FAILED = 'wrong password for this account name',
    BAD_CONTENT = 'your game data does not match the server',
    BAD_ENGINE = 'your game build does not match the server',
    BAD_PROTO = 'protocol mismatch — update the game or the server',
    SERVER_FULL = 'the server is full',
    BANNED = 'you are banned from this server',
    KICKED = 'you were kicked',
    RATE = 'disconnected for flooding',
    SUPERSEDED = 'this account logged in from somewhere else',
    SHUTDOWN = 'the server shut down',
    UNREACHABLE = 'could not reach the server',
}

local wasJoined = false
-- Admin replies the WINDOW is waiting for (see menuFn). Chat-issued /slash commands leave
-- this at zero and keep their screen notices.
local adminUiPending = 0

-- --- M1: remote-player puppets ---------------------------------------------------------
-- Server rule mirrored client-side: a remote player is visible when in the same cell, or an
-- adjacent exterior grid cell. The server only relays poses/cell-changes of visible players
-- (and force-includes a pose when someone enters the bubble), so the authoritative spawn
-- trigger is simply "first MP_MoveBatch entry for a rostered id"; PlayerCellChange handles
-- teleports and despawns.
-- Same sanctuary objects.lua and the server apply: the opening is driven by Morrowind's own
-- scripts on the actors in these cells, so nothing of ours belongs in them. Kept in step with
-- isChargenCell in scripts/mp/objects.lua and server/src/core/movement.ts.
local function isChargenCell(cellKey)
    local k = string.lower(tostring(cellKey or ''))
    return (k:find('census', 1, true) ~= nil) or (k:find('prison ship', 1, true) ~= nil)
end

local PUPPET_TEMPLATE_ID = 'villager_00' -- demo NPC record (race "Imperial"), neutral kit

local puppets = {} -- id -> {obj=GameObject, name=string}
local remoteCell = {} -- id -> last cellKey (from PlayerCellChange relays)
local lastPose = {} -- id -> last known {x=, y=, z=}
local remoteIdentity = {} -- id -> {appearance=, equipment=, dynamic=} (M2; kept across spawns)
local puppetRecordIds = {} -- identity fingerprint -> generated NPC record id (immutable)
local ownCellKeyCache = nil
local lastPuppetMirror = 0

local function toCellKey(cell)
    if not cell then return nil end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

local function parseExteriorKey(key)
    local gx, gy = string.match(key or '', '^(-?%d+),(-?%d+)$')
    if gx then return tonumber(gx), tonumber(gy) end
    return nil
end

local function visibleFrom(ownKey, key)
    if not ownKey or not key then return false end
    if ownKey == key then return true end
    local ax, ay = parseExteriorKey(ownKey)
    local bx, by = parseExteriorKey(key)
    return ax ~= nil and bx ~= nil and math.abs(ax - bx) <= 1 and math.abs(ay - by) <= 1
end

local function rosterName(id)
    for _, p in ipairs(roster) do
        if p.id == id then return p.name end
    end
    return nil
end

-- Teleport destination worldspace: exterior keys resolve by position in the default
-- worldspace (''); interiors are by definition the local player's own cell.
local function destCellArg()
    local player = playerScript()
    if not player or not player.cell then return nil end
    return player.cell.isExterior and '' or player.cell.name
end

-- Phase C: worldspace for an invite teleport. Distinct from destCellArg(), which answers
-- for the LOCAL player's current cell — an invite is precisely the case where the
-- destination may be somewhere the invitee is not, including a different interior, so the
-- destination has to be derived from the target key rather than from where we stand.
-- Exterior keys ("x,y") resolve by position in the default worldspace; interiors are named.
local function inviteCellArg(cellKey)
    return cellKey:match('^%-?%d+,%-?%d+$') and '' or cellKey
end

-- M2: the puppet record is built from the relayed PlayerAppearance when one is known —
-- the puppet then IS the remote player's look, not a generic villager. Records are
-- immutable, so each distinct identity gets its own generated record (cached).
local function puppetRecordId(id, name)
    local app = remoteIdentity[id] and remoteIdentity[id].appearance
    local key = name .. '|'
        .. (app and table.concat({ tostring(app.race), tostring(app.head), tostring(app.hair),
            tostring(app.isMale), tostring(app.class) }, '|') or 'default')
    if puppetRecordIds[key] then return puppetRecordIds[key] end
    -- Retail Morrowind has no villager_* records: fall back to the first NPC record in the
    -- content chain (any humanoid works — the puppet only needs a rigged body).
    local template = types.NPC.records[PUPPET_TEMPLATE_ID] or types.NPC.records[1]
    if not template then
        print('[mp] no NPC record available for the puppet template')
        return nil
    end
    local draft = { template = template, name = name }
    if app then
        draft.race = app.race
        draft.class = app.class
        draft.isMale = app.isMale
        if app.head and app.head ~= '' then draft.head = app.head end
        if app.hair and app.hair ~= '' then draft.hair = app.hair end
    end
    local ok, record = pcall(function() return world.createRecord(types.NPC.createRecordDraft(draft)) end)
    if not ok then
        -- Bad/foreign record ids in the appearance (content mismatch): fall back to template look.
        print('[mp] puppet record build failed (' .. tostring(record) .. '), using template look')
        record = world.createRecord(types.NPC.createRecordDraft({ template = template, name = name }))
    end
    puppetRecordIds[key] = record.id
    return record.id
end

-- Items another client references may not exist here (dynamic records are per-client;
-- content mismatches in retail): equip a local placeholder so the SLOT state still syncs.
local placeholderItemRecordId = nil
local function placeholderItemId()
    if placeholderItemRecordId then return placeholderItemRecordId end
    local ok, rec = pcall(function()
        return world.createRecord(types.Armor.createRecordDraft({
            name = 'Unknown Item',
            model = 'meshes/marker_error.osgt',
            icon = '',
            type = types.Armor.TYPE.Helmet,
            weight = 1,
            value = 1,
            health = 100,
            baseArmor = 0,
            enchantCapacity = 0,
        }))
    end)
    if ok then placeholderItemRecordId = rec.id end
    return placeholderItemRecordId
end

-- Grant any equipment items the puppet does not hold yet, then hand the slot map to the
-- puppet script (which retries setEquipment until the grants land in its inventory).
local function pushEquipmentToPuppet(id)
    local p = puppets[id]
    local eq = remoteIdentity[id] and remoteIdentity[id].equipment
    if not p or not p.obj:isValid() or not eq then return end
    local inventory = types.Actor.inventory(p.obj)
    local effective = {}
    for slot, recordId in pairs(eq.slots or {}) do
        -- §M7: a peer's custom item arrives as the server's recordNetId; resolve it to the
        -- record THIS client built from RecordsSync (never trust a foreign local id).
        local grantId = worldmp.toLocal(recordId)
        local ok, count = pcall(function() return inventory:countOf(grantId) end)
        if not ok or count == 0 then
            local okc, item = pcall(function() return world.createObject(grantId) end)
            if okc then
                item:moveInto(inventory)
            else
                grantId = placeholderItemId() -- unknown record here: visible stand-in
                if grantId then
                    local okp, cnt = pcall(function() return inventory:countOf(grantId) end)
                    if not okp or cnt == 0 then
                        world.createObject(grantId):moveInto(inventory)
                    end
                end
            end
        end
        if grantId then effective[slot] = grantId end
    end
    p.obj:sendEvent('MP_Equip', { slots = effective })
end

local function pushStatsToPuppet(id)
    local p = puppets[id]
    local dyn = remoteIdentity[id] and remoteIdentity[id].dynamic
    if p and p.obj:isValid() and dyn then
        p.obj:sendEvent('MP_Stats', dyn)
    end
end

local function spawnPuppet(id, pose)
    if puppets[id] then return end
    local cellArg = destCellArg()
    if not cellArg then return end
    -- %d, not tostring(): ids arrive through the JSON decoder as Lua floats, so tostring(2.0)
    -- is "2.0" and the fallback name rendered in the crosshair tooltip as "player 2.0".
    local name = rosterName(id) or string.format('player %d', math.floor(tonumber(id) or 0))
    local recordId = puppetRecordId(id, name)
    if not recordId then return end
    local obj = world.createObject(recordId)
    obj:teleport(cellArg, util.vector3(pose.x, pose.y, pose.z))
    obj:addScript('scripts/mp/puppet.lua', { playerId = id })
    puppets[id] = { obj = obj, name = name }
    print('[mp] puppet spawned for ' .. name .. ' (#' .. tostring(id) .. ')')
    -- Identity that arrived before the spawn applies now, so the first visible frame
    -- already has the right look/equipment/health.
    pushEquipmentToPuppet(id)
    pushStatsToPuppet(id)
end

local function despawnPuppet(id)
    local p = puppets[id]
    if not p then return end
    puppets[id] = nil
    -- Guarded, and deliberately AFTER the bookkeeping above: remove() throws when the
    -- object is already gone or otherwise not removable ("Can't remove 0 of 0 items"), and
    -- an engine handler that throws ABORTS — which took the rest of MP_PlayerLeaveWorld
    -- with it, leaving the roster mirror stale and remoteCell/lastPose still holding a
    -- player who had left. Same transient-engine-state reasoning as tryTeleport.
    if p.obj:isValid() then pcall(function() p.obj:remove() end) end
    print('[mp] puppet despawned for ' .. p.name .. ' (#' .. tostring(id) .. ')')
end

-- Appearance changed for a live puppet: records are immutable, so swap the object —
-- spawn a fresh one from the new record at the old pose, then remove the old.
local function rebuildPuppet(id)
    local p = puppets[id]
    if not p or not p.obj:isValid() then return end
    local pos = p.obj.position
    despawnPuppet(id)
    spawnPuppet(id, { x = pos.x, y = pos.y, z = pos.z })
end

local function despawnAllPuppets()
    for id in pairs(puppets) do
        despawnPuppet(id)
    end
    remoteCell = {}
    lastPose = {}
    remoteIdentity = {}
end

-- Own cell changed: re-evaluate which remote players are still in the visibility bubble.
local function refreshVisibility()
    local ownKey = ownCellKeyCache
    for id, key in pairs(remoteCell) do
        if visibleFrom(ownKey, key) then
            if not puppets[id] and lastPose[id] then spawnPuppet(id, lastPose[id]) end
        else
            despawnPuppet(id)
        end
    end
end

local function mirrorPuppets()
    local m = {}
    for id, p in pairs(puppets) do
        if p.obj:isValid() then
            local pos = p.obj.position
            local eq = {}
            local ok, slots = pcall(types.Actor.getEquipment, p.obj)
            if ok then
                for _, item in pairs(slots) do eq[#eq + 1] = item.recordId end
                table.sort(eq)
            end
            local rec = types.NPC.records[p.obj.recordId]
            m[tostring(id)] = { x = pos.x, y = pos.y, z = pos.z,
                name = rec and rec.name or p.name, eq = eq }
        end
    end
    mp.testSet('puppets', json.encode(m))
end

-- --- M2: rejoin restore orchestration ----------------------------------------------------
-- SessionWelcome.playerRecord (captured by net.lua) is applied once the player object
-- exists: grant the stored inventory (createObject+moveInto — only global can), teleport to
-- the stored position, then hand the record to player.lua (chargen/stats/spells/equipment).
local pendingRestore = nil
local testItemRecordId = nil -- dynamic record for the equiptest harness hook

-- M3 test-hook state
local chestRecordId = nil
local chestObj = nil
local lastChestOpId = nil
local lastDoorMirror = 0

local function nearestDoor()
    local player = playerScript()
    if not (player and player.cell) then return nil end
    local best, bestDist = nil, math.huge
    local function scan(cell)
        if not cell then return end
        local ok, doors = pcall(function() return cell:getAll(types.Door) end)
        if not ok then return end
        for _, door in ipairs(doors) do
            if not types.Door.isTeleport(door) then
                local d = (door.position - player.position):length()
                if d < bestDist then
                    best, bestDist = door, d
                end
            end
        end
    end
    if player.cell.isExterior then
        -- The village spans several grid cells; scan the player's 3x3 neighborhood.
        for dx = -1, 1 do
            for dy = -1, 1 do
                pcall(function() scan(world.getExteriorCell(player.cell.gridX + dx, player.cell.gridY + dy)) end)
            end
        end
    else
        scan(player.cell)
    end
    return best
end

local function mirrorDoor(now)
    if now - lastDoorMirror < 0.5 then return end
    lastDoorMirror = now
    local door = nearestDoor()
    if door then
        mp.testSet('doorOpen', tostring(not types.Door.isClosed(door)))
        mp.testSet('doorLocked', tostring(types.Lockable.isLocked(door)))
    end
end

local function teleportPlayerTo(position)
    local player = playerScript()
    if not player or not position then return end
    local gx, gy = parseExteriorKey(position.cellKey)
    local cellArg = gx and '' or position.cellKey
    local ok, err = pcall(function()
        player:teleport(cellArg, util.vector3(position.x, position.y, position.z))
    end)
    if not ok then print('[mp] restore teleport failed: ' .. tostring(err)) end
end

-- Restoring the position ONCE loses a race. On a page reload the engine is still placing the
-- player itself (a ?start= deep-link, or the save/chargen spawn), and that placement can land
-- AFTER our teleport and silently overwrite it — observed intermittently as a resumed player
-- snapping back to the start point instead of where they logged out. So re-assert the target
-- for a short window and stop as soon as it sticks, rather than trusting a single apply.
local restoreTarget = nil -- {cellKey=, x=, y=, z=, deadline=}
local RESTORE_HOLD_SECONDS = 8
local RESTORE_EPSILON = 25 -- units; well inside the ~300u error this exists to catch

local function dist3(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

-- Deliberately dumb: re-assert the target EVERY tick it is off, for a short window.
--
-- A cleverer version (only correct on a detected single-tick "jump", so a player who walks
-- away is never dragged back) tested WORSE — the engine's post-reload placement does not
-- always arrive as one clean jump, and teleports are deferred to the next
-- synchronizedUpdate, so any one-shot correction is easily lost. The window is what keeps
-- this safe instead: 8s is long enough to outlast a slow world load on a busy machine, and
-- short enough that a player is very unlikely to have walked 25+ units of their own accord
-- before it lapses. Correctness of "you are where you logged out" beats elegance here.
local function restorePositionTick(now)
    if not restoreTarget then return end
    local player = playerScript()
    if not player then return end
    if now > restoreTarget.deadline then
        if dist3(player.position, restoreTarget) > RESTORE_EPSILON then
            print('[mp] restore position never took hold')
        end
        restoreTarget = nil
        return
    end
    if dist3(player.position, restoreTarget) > RESTORE_EPSILON then teleportPlayerTo(restoreTarget) end
end

local function restoreTick()
    if not pendingRestore then return end
    mp.testSet('restoreFired', '1')
    local player = playerScript()
    if not player then return end
    local record = pendingRestore
    pendingRestore = nil
    local inventory = types.Actor.inventory(player)
    local granted = 0
    -- Server doc shape: inventory is a flat [{id,n},...] array (persist/playerstore.ts).
    --
    -- RECONCILE, NEVER RE-GRANT. This used to create the whole stored inventory outright, on
    -- the assumption that a restore lands in an empty character. It does not on a WORLD
    -- SWITCH: the engine keeps the same player actor, with everything already in it, so every
    -- Solo->Public->Solo trip added another full copy of the doc — 261 gold became 783 in two
    -- switches. Grant only the shortfall, using the same countOf idiom as the puppet grant
    -- path above.
    --
    -- Deliberately does NOT remove a surplus. The doc is written behind a debounce, so a
    -- player holding MORE than it records is the ordinary case of having picked something up
    -- since the last flush — treating that as a dupe to be confiscated would destroy real
    -- items to fix a cosmetic count. This stops the growth; it does not heal an inventory
    -- already inflated by the old behaviour.
    for _, entry in ipairs(record.inventory or {}) do
        local want = entry.n or 1
        local okc, have = pcall(function() return inventory:countOf(entry.id) end)
        local short = want - ((okc and have) or 0)
        if short > 0 then
            local ok, item = pcall(function() return world.createObject(entry.id, short) end)
            if ok then
                item:moveInto(inventory)
                granted = granted + 1
            end
        end
    end
    mp.testSet('restorePos', record.position and json.encode(record.position) or 'none')
    if record.position then
        teleportPlayerTo(record.position)
        restoreTarget = {
            cellKey = record.position.cellKey,
            x = record.position.x, y = record.position.y, z = record.position.z,
            deadline = core.getRealTime() + RESTORE_HOLD_SECONDS,
        }
    end
    player:sendEvent('MP_ApplyRecord', record)
    print('[mp] rejoin restore: ' .. granted .. ' item stack(s) granted, record forwarded')
end

local function puppetTick()
    local now = core.getRealTime()
    local player = playerScript()
    if player then
        local key = toCellKey(player.cell)
        if key ~= ownCellKeyCache then
            ownCellKeyCache = key
            refreshVisibility()
            if net.state == 'Joined' then
                quests.onCellChanged()
                worldmp.onCellEntered(key)
            end
        end
    end
    if now - lastPuppetMirror >= 0.5 then
        lastPuppetMirror = now
        mirrorPuppets()
    end
end

local function start()
    if not mp.isEnabled() then return end
    if mp.vectorsEnabled() then dumpVectors() end
    -- M3 world-object hub wiring (see scripts/mp/objects.lua).
    objects.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        placeholderItemFn = placeholderItemId,
    })
    -- M4 shared-NPC authority hub (see scripts/mp/actors.lua). isMpPuppetFn tells the actor
    -- sampler which active actors are remote-PLAYER puppets (driven by player move frames) so
    -- it never double-drives or broadcasts them as cell NPCs.
    actors.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        isMpPuppetFn = function(obj)
            for _, p in pairs(puppets) do
                if p.obj:isValid() and p.obj.id == obj.id then return true end
            end
            return false
        end,
    })
    -- M5 combat hub (see scripts/mp/combat.lua).
    combat.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        puppetObjOf = function(id)
            local p = puppets[id]
            return p and p.obj:isValid() and p.obj or nil
        end,
        epochOf = actors.epochOf,
        isHolderOf = actors.isHolderOf,
        cellKeyOfObj = actors.cellKeyOfObj,
        -- PvP is a server rule (SessionWelcome.flags.pvp); default OFF until told otherwise.
        isPvpEnabled = function() return net.flags and net.flags.pvp == true end,
    })
    -- M6 quest layer (see scripts/mp/quests.lua): journal, MWScript globals/locals,
    -- factions, crime, dialogue locks. Global context because every writable end of it is
    -- global-gated in 0.52 (setCrimeLevel, world.mwscript).
    quests.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        noticeFn = notice,
        rosterNameFn = rosterName,
        isMpPuppetFn = function(obj)
            for _, p in pairs(puppets) do
                if p.obj:isValid() and p.obj.id == obj.id then return true end
            end
            return false
        end,
    })
    -- M7 world state (see scripts/mp/world.lua): clock, region/weather authority, custom
    -- records, cell resets, map sharing, server-pushed GUI.
    worldmp.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        noticeFn = notice,
        toPlayerFn = toPlayer,
        onCellResetFn = function(cellKey)
            -- Drop our local view of that cell and ask for the (now empty) server truth.
            objects.forgetCell(cellKey)
            if cellKey == ownCellKeyCache then
                mp.sendEvent('ResyncRequest', { cellKey = cellKey })
            end
        end,
    })
    -- M8 ops (see scripts/mp/admin.lua): the client end of /tp, /give and /console.
    admin.init({
        playerFn = playerScript,
        noticeFn = notice,
        teleportFn = teleportPlayerTo,
        toLocalRecordFn = worldmp.toLocal,
        -- Claims a reply only when the WINDOW issued the request. Replies are 1:1 and
        -- ordered per connection, so a simple outstanding count correlates them without a
        -- request id — and a /slash command typed in chat still notices normally.
        menuFn = function(text)
            if adminUiPending <= 0 then return false end
            adminUiPending = adminUiPending - 1
            toPlayer('MP_AdminMenuResult', { text = text })
            return true
        end,
    })
    net.onStateChanged = function(state)
        print('[mp] session state: ' .. state)
        if state == 'Joined' then
            -- ONCE PER SESSION, not once per join. A world switch and every reconnect come
            -- back through here, so this repeated the same three lines each time and pushed
            -- the actual conversation off the top of the log.
            if not announcedConnect then
                announcedConnect = true
                notice('Connected to ' .. tostring(net.serverName or 'the server')
                    .. ' as ' .. tostring(mp.getName() or '?'))
            end
            wasJoined = true
            -- The world we FIRST land in at login is our own (the launcher puts us there). Cache
            -- its URL so the where-am-I switcher can return here from Public.
            if not worldUrls.own then worldUrls.own = net.currentTarget() end
            -- A flip that had to wait for us to arrive back in our own world (e.g. "Party"
            -- pressed while in Public) fires now that we are joined.
            if pendingFlip and net.currentTarget() == worldUrls.own then
                mp.sendEvent('SetWorldMode', { mode = pendingFlip })
                pendingFlip = nil
            end
            if net.playerRecord then
                pendingRestore = net.playerRecord -- applied by restoreTick once the player exists
                net.playerRecord = nil
            end
        elseif state == 'Failed' then
            local why = FAIL_TEXT[net.lastError] or net.lastError or 'connection failed'
            local detail = net.lastErrorDetail
            mp.testSet('netfail', why .. (detail and detail ~= '' and (' (' .. detail .. ')') or ''))
        end
        -- CONNECTION STATE IS A MODAL, NOT CHAT. A drop repeats every backoff tick, so
        -- narrating it in the chat log buried the actual conversation under a wall of
        -- identical lines while the player stood in a world that was no longer live. The
        -- UI mirrors this and puts one overlay up, held until we rejoin or give up.
        mp.testSet('netstate', state)
        if state ~= 'Joined' then
            -- The NEXT world has its own peer, which has to come up before it holds anything.
            -- Leaving this at '1' from the world we just left meant a switch never waited:
            -- the loading screen saw a stale "ready", cleared, and dropped the player into an
            -- unsimulated world to rubber-band exactly as they did on a first join. The new
            -- world's own SimReady answers this on arrival.
            mp.testSet('simReady', '0')
            roster = {}
            mirrorRoster()
            despawnAllPuppets()
            objects.reset()
            actors.reset()
            quests.reset()
            worldmp.reset()
            admin.reset()
        end
    end
    if net.state == 'Offline' or net.state == 'Failed' then
        net.start()
    end
end

-- Character slots + onboarding: net-level results push to the player script so the hub
-- re-renders without polling (same global -> player direction as every MP_* relay).
net.onCharacters = function(msg)
    toPlayer('MP_Characters', {
        characters = net.characters or {},
        active = net.characterId or '',
        ok = msg and msg.ok or nil,
        error = msg and msg.error or nil,
    })
end
net.onProfileResult = function(msg)
    toPlayer('MP_ProfileResult', { ok = msg.ok == true, error = msg.error or '' })
end

local eventHandlers = {
    MP_TransportOpen = function() net.onOpen() end,
    MP_TransportClose = function() net.onClose() end,
    MP_SessionJson = function(str) net.onJson(str) end,

    -- --- Phase C: social relays -----------------------------------------------------
    -- Straight pass-through to the player script, which owns the window. The one exception
    -- is InviteAccepted, which is an ACTION (a teleport) and therefore has to happen in the
    -- global context where teleport is available.
    MP_FriendList = function(data)
        mp.testSet('friends', json.encode(data.friends or {}))
        toPlayer('MP_FriendList', data)
    end,
    -- F3 world browser. Inbound server events land in the GLOBAL context and reach the
    -- window only if forwarded here — the social family's straight pass-through pattern.
    MP_WorldList = function(data)
        toPlayer('MP_WorldList', data)
        -- The switcher's "Public" leg asked for the directory so it could find the one shared
        -- world and dial it. Remember its URL for next time and switch now.
        if pendingPublic then
            pendingPublic = false
            for _, w in ipairs(data.worlds or {}) do
                if w.mode == 'public' and w.up then
                    local u = worldUrlOf(w)
                    if u then
                        worldUrls.public = u
                        if net.currentTarget() ~= u then net.switchTo(u) end
                        break
                    end
                end
            end
        end
    end,
    MP_WorldCreate = function(data) toPlayer('MP_WorldCreate', data) end,
    MP_FriendRequestReceived = function(data) toPlayer('MP_FriendRequestReceived', data) end,
    MP_InviteReceived = function(data) toPlayer('MP_InviteReceived', data) end,
    MP_PresenceUpdate = function(data) toPlayer('MP_PresenceUpdate', data) end,
    MP_PartyUpdate = function(data)
        toPlayer('MP_PartyUpdate', data)
        -- WHO IS IN YOUR PARTY, narrated by diffing against the last view. The server sends
        -- the whole party on every change, so without a diff this would either say nothing or
        -- repeat the full roster each time.
        local now = {}
        for _, m in ipairs((data and data.members) or {}) do
            if m.name then now[tostring(m.name)] = true end
        end
        local count = 0
        for name in pairs(now) do
            count = count + 1
            if not partySeen[name] and name ~= tostring(mp.getName() or '') then
                notice(name .. ' joined your party.')
            end
        end
        for name in pairs(partySeen) do
            if not now[name] and name ~= tostring(mp.getName() or '') then
                notice(name .. ' left your party.')
            end
        end
        if count == 0 and next(partySeen) ~= nil then notice('Your party has disbanded.') end
        partySeen = now
    end,
    -- Phase 4: how many party members are standing with us. The cell's authority holder
    -- applies it to the actors it simulates; a solo player gets 1x and nothing changes.
    MP_PartyScaling = function(data)
        threat.setScaling(data and data.members and data.members > 1 and {
            hp = data.hp or 1, damage = data.damage or 1,
            extraSpawns = data.extraSpawns or 0, members = data.members,
        } or nil)
        mp.testSet('partyScaling', json.encode(data or {}))
    end,
    MP_PartyInviteReceived = function(data) toPlayer('MP_PartyInviteReceived', data) end,
    MP_SocialResult = function(data) toPlayer('MP_SocialResult', data) end,
    -- Party voice: signalling only (never audio). Handed straight to the JS mesh.
    MP_VoiceSignal = function(data)
        voice.onSignal(tostring(data.fromAcct or ''), tostring(data.kind or ''), tostring(data.payload or ''))
        toPlayer('MP_VoiceSignal', data)
    end,

    -- Party travel: the leader moved the group. Like InviteAccepted this is an ACTION, so
    -- it lives in the global context: build the destination URL and redial. The player
    -- script is told first so the hub can show where the party went — and if we are
    -- already dialled into that world (the leader's own client, or a repeat event), the
    -- switch is skipped rather than bouncing the session.
    -- The owner of the world we are standing in went Solo, so it is no longer open to us.
    -- Dial our OWN world, which this client already knows; the server drops anyone still
    -- here shortly after, so doing nothing would just become a disconnect.
    -- WHERE TO SIMULATE. Sent only to the sim peer: one anchor per populated region, so a
    -- single engine keeps several parts of the world active instead of one ~450MB process per
    -- region. A normal client never receives this, and without anchors the engine behaves
    -- exactly as it always has (the player is the only anchor).
    MP_SimAnchors = function(data)
        if not mp.setSimAnchors then return end
        local out = {}
        for _, a in ipairs((data and data.anchors) or {}) do
            if a.x and a.y then out[#out + 1] = { x = math.floor(a.x), y = math.floor(a.y) } end
        end
        -- Interiors come as NAMES: they have no grid coordinate, so they cannot ride in the
        -- anchor list. Held exactly like an exterior anchor — the peer keeps the room loaded
        -- and ticks its actors without standing in it.
        local rooms = {}
        for _, name in ipairs((data and data.interiors) or {}) do
            if type(name) == 'string' and name ~= '' then rooms[#rooms + 1] = name end
        end
        mp.setSimAnchors(out, rooms)
    end,
    -- The credential for the next world, minted by the one we are still connected to. The
    -- pending switch is waiting on exactly this.
    MP_TravelTicket = function(data)
        net.travelTicket(tostring(data and data.ticket or ''))
    end,
    -- The world telling us what it IS. Authoritative, sent at join and on every flip.
    -- Does the simulation peer hold authority yet? Mirrored to JS, where the loading screen
    -- waits on it. Nothing in Lua acts on this: the engine is perfectly happy simulating
    -- locally in the meantime — the problem is purely that letting the PLAYER move during
    -- that window means the peer arrives, takes the cell and corrects them, which is the
    -- rubber-banding. Holding the screen is what makes the correction unobservable.
    MP_SimReady = function(data)
        mp.testSet('simReady', (data and data.ready) and '1' or '0')
    end,

    MP_WorldMode = function(data)
        local m = tostring(data and data.mode or '')
        local was = worldMode
        worldMode = (m == 'public' or m == 'party') and m or 'solo'
        mirrorRoster()
        -- Which world you are in is invisible otherwise — the scenery is identical — and it
        -- decides who can see you. Announced on CHANGE only; the server also sends this at
        -- join, which is not a transition worth narrating.
        if was ~= nil and was ~= worldMode then
            local where = worldMode == 'public' and 'the public world'
                or worldMode == 'party' and 'your world, open to your party'
                or 'your own world (solo)'
            notice('You are now in ' .. where .. '.')
        end
    end,
    MP_WorldClosed = function(data)
        toPlayer('MP_WorldClosed', data)
        -- Mirrored so the HTML overlay can say WHY the world just changed under the player.
        mp.testSet('worldClosedBy', tostring(data.by or ''))
        mp.testSet('worldClosed', tostring(data.reason or 'closed'))
        -- A SEQUENCE, not the value. The reason is a constant ('owner_went_solo'), so the UI
        -- deduping on the value alone silently swallowed the second and every later kick in a
        -- session: the player was redialed with nothing on screen explaining why.
        noticeSeq = noticeSeq + 1
        mp.testSet('noticeSeq', tostring(noticeSeq))
        if worldUrls.own and net.currentTarget() ~= worldUrls.own then
            net.switchTo(worldUrls.own)
        end
    end,

    MP_PartyTravel = function(data)
        local url = worldUrlOf(data)
        if not url then return end
        toPlayer('MP_PartyTravel', data)
        mp.testSet('partyTravelBy', tostring(data.leaderName or ''))
        mp.testSet('partyTravelTo', tostring(data.worldId or ''))
        -- Same reason: the public world's id is a constant, so a second trip to it looked
        -- identical to the first and was never announced.
        noticeSeq = noticeSeq + 1
        mp.testSet('noticeSeq', tostring(noticeSeq))
        if url == net.currentTarget() then return end
        net.switchTo(url)
    end,

    -- The server answers InviteAccept with the host's live position. Travelling is done
    -- here rather than trusting a client-side coordinate: the server is the only thing that
    -- knows where the host actually is.
    MP_InviteAccepted = function(data)
        local player = playerScript()
        if not player or not data.cellKey then return end
        local ok, err = pcall(function()
            player:teleport(inviteCellArg(tostring(data.cellKey)), util.vector3(data.x or 0, data.y or 0, data.z or 0))
        end)
        if not ok then print('[mp] invite teleport failed: ' .. tostring(err)) end
        mp.testSet('invitedTo', tostring(data.cellKey))
    end,

    -- "Join a friend": the server resolved where they are (their party world, or the one
    -- public world) and told us where to dial. Like MP_PartyTravel this is an ACTION, so the
    -- redial happens here; the hub is told first so it can show status or a failure.
    MP_JoinFriend = function(data)
        toPlayer('MP_JoinFriend', data)
        if not data or data.ok ~= true then return end
        local url = worldUrlOf(data)
        if not url then return end
        mp.testSet('joinFriendTo', tostring(data.worldId or ''))
        if url == net.currentTarget() then return end
        net.switchTo(url)
    end,

    MP_ChatMessage = function(data)
        mp.testSet('lastChat', json.encode(data))
        toPlayer('MP_UiChatMessage', data)
    end,

    MP_PlayerJoinWorld = function(data)
        for _, p in ipairs(roster) do
            if p.id == data.id then return end
        end
        roster[#roster + 1] = { id = data.id, name = data.name }
        mirrorRoster()
        -- Not your own arrival: you know you just joined, and on a world switch the server
        -- re-announces every occupant including you.
        if data.id ~= net.playerId then
            toPlayer('MP_UiChatMessage',
                { channel = 'server', text = tostring(data.name) .. ' joined the world.' })
        end
    end,

    MP_PlayerLeaveWorld = function(data)
        for i, p in ipairs(roster) do
            if p.id == data.id then
                toPlayer('MP_UiChatMessage',
                    { channel = 'server', text = tostring(p.name) .. ' left the world.' })
                table.remove(roster, i)
                break
            end
        end
        despawnPuppet(data.id)
        remoteCell[data.id] = nil
        lastPose[data.id] = nil
        mirrorRoster()
    end,

    -- Interest management: this player left OUR view (distance cull or cell exit) — they are
    -- still in the world, just no longer streamed to us. Without this the server simply stops
    -- sending their poses and we would keep a ghost puppet frozen at the boundary forever.
    -- Despawn NOW rather than on a stale timeout (seconds of a motionless body is exactly the
    -- artefact this exists to prevent), drop the interp state so a re-entry starts clean, and
    -- KEEP the roster entry — only PlayerLeaveWorld means they actually left. Re-entry needs
    -- no signal: the server force-sends their pose and the first-sighting path respawns them.
    MP_PlayerLeaveView = function(data)
        if data.id == nil then return end
        despawnPuppet(data.id) -- idempotent; safe for an id we never spawned
        remoteCell[data.id] = nil
        lastPose[data.id] = nil
    end,

    -- M1: one decoded 0x0101 batch -> route each entry to its puppet (spawning on first
    -- sighting — the server only sends poses of players visible to us).
    MP_MoveBatch = function(batch)
        local now = core.getRealTime()
        -- G2: the render tier is decided HERE, once per batch, and stamped onto each pose.
        -- The alternative — every puppet asking `nearby` for the player each frame — pays
        -- the lookup per puppet per frame, which is the cost this is trying to remove.
        local me = playerScript()
        local origin = me and me.position or nil
        local f = net.flags
        local tiered = origin ~= nil and f ~= nil and f.renderLod == 'tiered'
        local nearR2 = tiered and (f.lodNearRadius or 0) ^ 2 or 0
        local midR2 = tiered and (f.lodMidRadius or 0) ^ 2 or 0

        -- Pass 1: distances. The nearest-K cap needs to rank the whole batch before it can
        -- tier any single entry, which is why this is two passes and not one.
        --
        -- Entries are collected with ipairs and counted, NOT indexed via `#batch`. The `#`
        -- operator is only defined on a proper sequence, and using it here silently
        -- processed nothing: puppets then spawned ONLY via PlayerCellChange, so two players
        -- who spawn in the same cell and stand still never saw each other. It was asymmetric
        -- and easy to misread as a flake — the player who joins first sends its cell change
        -- before the second is in-world, so only the SECOND player's puppet went missing.
        local count = 0
        for _, e in ipairs(batch) do
            count = count + 1
            entryBuf[count] = e
            if tiered then
                local dx, dy, dz = e.x - origin.x, e.y - origin.y, e.z - origin.z
                d2Buf[count] = dx * dx + dy * dy + dz * dz
            else
                d2Buf[count] = -1 -- not comparable: always near, never degraded
            end
        end
        local maxNear = tiered and (f.lodNearMaxAvatars or 0) or 0
        local cutoff = nearCutoff(nearR2, maxNear, count)

        -- Pass 2: tier and route. `nearLeft` enforces the cap EXACTLY. The cutoff alone
        -- does not: it is the K-th smallest distance and the test is `d2 <= cutoff`, so
        -- every avatar tied at exactly that distance stays near and the cap is exceeded.
        -- Ties are not exotic here — players stacked in a doorway, a formation, or bots on
        -- a ring layout sit at identical distances — and the symptom would be an
        -- intermittently-breached cap that reads as a flaky test rather than an off-by-ties
        -- bug. The cutoff stays as a cheap pre-filter; this counter is the actual bound.
        --
        -- `maxNear` is a LOCAL computed above. It was previously written here as a bare name
        -- that existed only as a parameter of nearCutoff, so at this scope it was a nil
        -- global and `nil > 0` threw on EVERY batch — the handler died before routing a
        -- single pose, and puppets could then only appear via PlayerCellChange.
        local nearLeft = maxNear > 0 and maxNear or math.huge
        for i = 1, count do
            local e = entryBuf[i]
            if e.id ~= net.playerId then
                lastPose[e.id] = { x = e.x, y = e.y, z = e.z }
                -- NEVER into the chargen cells. spawnPuppet places a puppet in the LOCAL
                -- player's own cell (destCellArg), and this path has no cell test of its own —
                -- MP_PlayerCellChange checks visibility, a move batch does not. That is how a
                -- stranger materialises in your Imperial Prison Ship mid-character-creation,
                -- standing among the actors whose scripts drive the opening.
                if not puppets[e.id] and not isChargenCell(ownCellKeyCache) then
                    spawnPuppet(e.id, e)
                end
                local p = puppets[e.id]
                if p and p.obj:isValid() then
                    local d2 = d2Buf[i]
                    local tier
                    if d2 < 0 then
                        tier = TIER_NEAR -- not comparable: never degraded
                    elseif d2 <= cutoff and nearLeft > 0 then
                        tier = TIER_NEAR
                        nearLeft = nearLeft - 1
                    elseif d2 <= midR2 then
                        tier = TIER_MID
                    else
                        tier = TIER_FAR
                    end
                    e.t = now
                    e.tier = tier
                    local tn = TIER_NAME[tier] or 'near'
                    tierSeen[tn] = (tierSeen[tn] or 0) + 1
                    p.obj:sendEvent('MP_Pose', e)
                end
            end
        end
        -- Mirrored so a capacity run can prove puppets really ARE being degraded. Without
        -- it, a "tiered" run that silently classified every avatar as near would report a
        -- free performance win that is actually just the old behaviour.
        mp.testSet('puppetTiers', json.encode(tierSeen))
        -- Cleared in place: `tierSeen = {}` allocated a fresh table 15x/second, and this
        -- module already goes out of its way to avoid per-tick garbage.
        tierSeen.near, tierSeen.mid, tierSeen.far = nil, nil, nil
    end,

    -- M1: relayed with the mover's id added; despawn/teleport their puppet. Our OWN
    -- relay comes back too — ignore it (PROTOCOL.md).
    MP_PlayerCellChange = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteCell[data.id] = data.cellKey
        lastPose[data.id] = { x = data.x, y = data.y, z = data.z }
        if visibleFrom(ownCellKeyCache, data.cellKey) then
            local p = puppets[data.id]
            if p and p.obj:isValid() then
                tryTeleport(p.obj, destCellArg(), util.vector3(data.x, data.y, data.z))
            else
                spawnPuppet(data.id, data)
            end
        else
            despawnPuppet(data.id)
        end
    end,

    -- --- M2: identity relays -> puppet appliers ------------------------------------------
    MP_PlayerAppearance = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteIdentity[data.id] = remoteIdentity[data.id] or {}
        remoteIdentity[data.id].appearance = data
        rebuildPuppet(data.id) -- no-op when not spawned; spawn applies the stored look
    end,

    MP_PlayerEquipment = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteIdentity[data.id] = remoteIdentity[data.id] or {}
        remoteIdentity[data.id].equipment = { slots = data.slots or {} }
        pushEquipmentToPuppet(data.id)
    end,

    MP_PlayerStatsDynamic = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteIdentity[data.id] = remoteIdentity[data.id] or {}
        remoteIdentity[data.id].dynamic = { hp = data.hp, mp = data.mp, ft = data.ft }
        pushStatsToPuppet(data.id)
    end,

    -- M2 respawn service: teleport self, then let player.lua revive/refill.
    MP_PlayerResurrect = function(data)
        teleportPlayerTo(data)
        toPlayer('MP_DoResurrect', { restoreHp = data.restoreHp == true })
    end,

    -- Test hook (equip:<id>:<slot>): grant an item into the LOCAL player's inventory.
    mpGrantItem = function(data)
        local player = playerScript()
        if not player or type(data.id) ~= 'string' then return end
        local ok, item = pcall(function() return world.createObject(data.id) end)
        if ok then
            item:moveInto(types.Actor.inventory(player))
        else
            print('[mp] mpGrantItem failed: ' .. tostring(item))
        end
    end,

    -- Test hook (equiptest): the clean demo content ships NO item records at all, so the
    -- equipment scenarios create a dynamic helmet record at runtime and grant it.
    mpTestItem = function()
        local player = playerScript()
        if not player then return end
        if not testItemRecordId then
            local ok, rec = pcall(function()
                return world.createRecord(types.Armor.createRecordDraft({
                    name = 'MP Test Helmet',
                    model = 'meshes/marker_error.osgt',
                    icon = '',
                    type = types.Armor.TYPE.Helmet,
                    weight = 1,
                    value = 1,
                    health = 100,
                    baseArmor = 5,
                    enchantCapacity = 0,
                }))
            end)
            if not ok then
                print('[mp] mpTestItem record creation failed: ' .. tostring(rec))
                return
            end
            testItemRecordId = rec.id
        end
        world.createObject(testItemRecordId):moveInto(types.Actor.inventory(player))
        toPlayer('MP_TestItem', { id = testItemRecordId })
    end,

    -- --- M3 test hooks (headless scenarios can't drive the mouse/UI) -------------------
    -- Drop the first inventory item matching recordId into the world in front of the
    -- player — via the NATIVE path (inventory->world teleport fires onItemActive, which is
    -- the same signal a UI drop produces), so the whole spawn pipeline is exercised.
    mpDropItem = function(data)
        local player = playerScript()
        if not player then return end
        for _, item in ipairs(types.Actor.inventory(player):getAll()) do
            if item.recordId == data.id then
                local pos = player.position + util.vector3(0, 100, 0)
                local cellArg = player.cell.isExterior and '' or player.cell.name
                item:teleport(cellArg, pos)
                return
            end
        end
        print('[mp] mpDropItem: no ' .. tostring(data.id) .. ' in inventory')
    end,

    -- Pick up a net-tracked object through the REAL activation pipeline (activateBy ->
    -- native pickup + our onActivate hook relays the ObjectDelete).
    mpTakeNet = function(data)
        local player = playerScript()
        local obj = data.netId and objects.objOfNet(data.netId)
        if player and obj and obj:isValid() then
            obj:activateBy(player)
        end
    end,

    -- Spawn a shared chest: dynamic container record locally + ObjectSpawnRequest so the
    -- server nets it (peers get a placeholder object; the CONTAINER STATE still syncs —
    -- that is what M3 asserts; a real shared chest needs shared content records).
    mpSpawnChest = function()
        local player = playerScript()
        if not player then return end
        if not chestRecordId then
            local ok, rec = pcall(function()
                return world.createRecord(types.Container.createRecordDraft({
                    name = 'MP Test Chest',
                    model = 'meshes/marker_error.osgt',
                    weight = 500, -- capacity
                    isOrganic = false,
                    isRespawning = false,
                }))
            end)
            if not ok then
                print('[mp] chest record failed: ' .. tostring(rec))
                return
            end
            chestRecordId = rec.id
        end
        local obj = world.createObject(chestRecordId)
        local cellArg = player.cell.isExterior and '' or player.cell.name
        local pos = player.position + util.vector3(100, 100, 0)
        obj:teleport(cellArg, pos)
        objects.markNetSpawned(obj) -- containers are not items, but keep bookkeeping tidy
        -- teleport lands next frame; obj.position is not valid yet -> pass the target pos
        objects.requestSpawn(obj, pos, ownCellKeyCache)
        chestObj = obj
    end,

    -- Put an inventory item into the spawned chest (native transfer + the same
    -- ContainerOpRequest the container watch would send).
    mpChestPut = function(data)
        local player = playerScript()
        if not (player and chestObj and chestObj:isValid()) then return end
        for _, item in ipairs(types.Actor.inventory(player):getAll()) do
            if item.recordId == data.id then
                -- Native transfer only: the container watch (armed by chest:open) diffs the
                -- inventory change into the ContainerOpRequest — the same path a UI put takes.
                item:moveInto(types.Container.content(chestObj))
                return
            end
        end
    end,

    -- Open the chest formally (ContainerOpen with a contents snapshot; the first opener's
    -- snapshot becomes canonical server-side).
    mpChestOpen = function(data)
        if chestObj and chestObj:isValid() then
            objects.onActivate(chestObj, playerScript())
        elseif data and data.netId then
            -- Peer without a real chest (placeholder object): announce with nil contents.
            mp.sendEvent('ContainerOpen', { net = data.netId, cellKey = ownCellKeyCache })
        end
    end,

    -- Race the take: request through the transactional server path; the ok/fail lands in
    -- the chestOp mirror via MP_ContainerOpResult below.
    mpChestTake = function(data)
        local netId = data.netId or (chestObj and objects.netIdOf(chestObj))
        if netId then
            local opId = objects.sendContainerOpByNet(netId, 'take', data.id, 1, ownCellKeyCache)
            lastChestOpId = opId
        end
    end,

    -- M5 test hook: land a synthetic melee hit on a target. This posts the STOCK `Hit`
    -- event, so it travels the identical path a real weapon swing takes: for a puppet the
    -- interception handler forwards it and cancels locally; for an actor we hold, the
    -- builtin pipeline applies it. Headless CDP cannot swing a weapon, but everything
    -- downstream of the swing is exercised verbatim.
    mpTestHit = function(data)
        local victim = nil
        if data.playerId then
            local p = puppets[data.playerId]
            victim = p and p.obj:isValid() and p.obj or nil
        elseif data.record then
            for _, obj in ipairs(world.activeActors) do
                if obj:isValid() and obj.recordId == data.record then victim = obj break end
            end
        end
        if not victim then
            print('[mp] mpTestHit: no victim for ' .. json.encode(data))
            return
        end
        victim:sendEvent('Hit', {
            damage = { health = data.damage or 10 },
            strength = 1,
            successful = true,
            sourceType = 'Melee',
            attacker = playerScript(),
        })
    end,

    -- M4 test hook: kill a specific cell NPC (holder side drives the death edge).
    mpKillNpc = function(data)
        if type(data.id) == 'string' and not actors.killActorByRecord(data.id) then
            print('[mp] mpKillNpc: no actor with record ' .. data.id .. ' in cell')
        end
    end,

    -- Toggle/lock/unlock the nearest content-file door (the real ref path).
    mpDoorToggle = function()
        local door = nearestDoor()
        if door then objects.onActivate(door, playerScript()) ; pcall(function() types.Door.activateDoor(door) end) end
    end,
    mpDoorLock = function(data)
        local door = nearestDoor()
        if door then
            pcall(function() types.Lockable.lock(door, data.level or 50) end)
            mp.sendEvent('ObjectLock', { ref = door, cellKey = ownCellKeyCache, lockLevel = data.level or 50 })
        end
    end,
    mpDoorUnlock = function()
        local door = nearestDoor()
        if door then
            pcall(function() types.Lockable.unlock(door) end)
            mp.sendEvent('ObjectLock', { ref = door, cellKey = ownCellKeyCache })
        end
    end,

    -- M1/M4 snap service: puppet.lua steering diverged (blocked, warp) -> hard teleport.
    -- actorKey => an M4 NPC puppet (routed to the actors hub); id => a remote-player puppet.
    mpSnapRequest = function(data)
        if data.actorKey then
            actors.snapActor(data.actorKey, data)
            return
        end
        local p = data.id and puppets[data.id]
        if p and tryTeleport(p.obj, destCellArg(), util.vector3(data.x, data.y, data.z)) then
            print('[mp] puppet snap #' .. tostring(data.id) .. ' (' .. tostring(data.why) .. ')')
        end
    end,

    MP_PlayerList = function(data)
        roster = {}
        for _, p in ipairs(data.players or {}) do
            roster[#roster + 1] = { id = p.id, name = p.name }
        end
        mirrorRoster()
    end,

    -- player.lua -> here -> server (Event tier, PROTOCOL.md `ChatSend`).
    -- Phase C uplink. One handler for the whole family: the player script names the op, so
    -- adding a social message does not mean touching the global script again. `op` is
    -- checked against a whitelist rather than forwarded blindly — a local script must not
    -- be able to name an arbitrary server event.
    mpSocial = function(data)
        local OPS = {
            FriendRequest = true, FriendAccept = true, FriendRemove = true,
            BlockAdd = true, BlockRemove = true, InviteSend = true, InviteAccept = true,
            PartyInvite = true, PartyAccept = true, PartyLeave = true, PartyTravel = true,
            PresenceMode = true, MuteAdd = true, MuteRemove = true, VoiceSignal = true,
            ReportPlayer = true, PartySetting = true,
            -- Social UX: availability (Online/Offline), cross-world join, and the owner's
            -- in-place Solo<->Party world flip.
            SetAvailability = true, JoinFriend = true, SetWorldMode = true,
            -- F3 world browser. The server takes the ACCOUNT from the authenticated
            -- session, never from here, so a client cannot list or create sessions under
            -- someone else's identity.
            WorldList = true, WorldCreate = true,
        }
        local op = tostring(data.op or '')
        if not OPS[op] then return end
        mp.sendEvent(op, {
            name = data.name, acct = data.acct, mode = data.mode, id = data.id,
            target = data.target, kind = data.kind, payload = data.payload,
            reason = data.reason, voice = data.voice, value = data.value,
            state = data.state,
        })
    end,

    -- Character slots (player UI -> here). The slot list lives on net (from Welcome /
    -- CharacterResult); the hub asks for it, switches to another slot (redial with the
    -- selection), or creates one (session-tier message, answered by CharacterResult).
    mpChars = function()
        toPlayer('MP_Characters', { characters = net.characters or {}, active = net.characterId or '' })
    end,
    mpCharSwitch = function(data)
        local id = tostring(data.id or '')
        if id == '' or id == net.characterId then return end
        net.setCharacter(id)
        net.switchTo(net.currentTarget())
    end,
    mpCharCreate = function(data)
        local name = tostring(data.name or '')
        if name == '' then return end
        net.sendSession({ t = 'CharacterCreate', name = name })
    end,
    -- Onboarding profile submit (email + unique public handle).
    -- Voice control from the social window (enable/disable, PTT) and the JS mesh's
    -- outbound signalling, which arrives via player.lua's harness command channel.
    mpVoice = function(data)
        local op = tostring(data.op or '')
        if op == 'enable' then voice.enable()
        elseif op == 'disable' then voice.disable()
        elseif op == 'talk' then voice.setTalking(data.on == true)
        elseif op == 'party' then voice.syncParty(data.members)
        end
    end,
    -- Phase 4 spawn replay: place the owed actor next to the player. Created locally
    -- rather than through the object-sync path on purpose — it exists FOR THIS CHARACTER
    -- (that is the whole point of replaying a one-shot), so broadcasting it would put a
    -- second Staada in front of everyone who already killed theirs.
    mpQuestSpawn = function(data)
        local player = playerScript()
        if not player or not data.recordId then return end
        local ok, err = pcall(function()
            local obj = world.createObject(data.recordId)
            obj:teleport(player.cell, player.position + util.vector3(150, 150, 0))
        end)
        if ok then
            print('[mp] quest spawn replayed: ' .. tostring(data.recordId))
            notice('Something stirs nearby.')
        else
            print('[mp] quest spawn failed: ' .. tostring(err))
        end
    end,
    mpProfileSetup = function(data)
        net.sendSession({
            t = 'ProfileSetup',
            email = tostring(data.email or ''),
            username = tostring(data.username or ''),
            marketingOptIn = data.marketingOptIn == true,
        })
    end,

    -- F3: switch worlds. A reconnect, not a page reload — mp.connect takes any URL, so the
    -- engine and loaded assets stay put and only the session moves. Accounts are shared
    -- across worlds, so the login that got us here works there too.
    mpNetDrop = function()
        mp.disconnect()
    end,

    mpSocialJoinById = function(data)
        toPlayer('MP_SocialJoinById', { id = tostring(data.id or '') })
    end,

    mpSocialTab = function(data)
        -- toPlayer, not a world.players loop: the same helper every other player-bound
        -- bridge here uses, and the one that actually resolves the player script.
        toPlayer('MP_SocialTab', { tab = tostring(data.tab or '') })
    end,

    mpJoinWorld = function(data)
        local url = tostring(data.url or '')
        if url == '' then return end
        print('[mp] switching to ' .. tostring(data.name) .. ' at ' .. url)
        net.switchTo(url)
    end,

    -- The where-am-I switcher (from the Social hub). Solo/Party flip our OWN world in place
    -- (deferred until we are back in it if we are currently in Public); Public dials the one
    -- shared world; Offline peels us home + hides us; Online restores us to where we last were.
    mpWhere = function(data)
        -- Nothing to do in multiplayer until the character exists: no leaving the solo world
        -- (or flipping it joinable) mid-chargen. The server's own chargen gate backs this up.
        if not chargenDone then
            notice('Finish creating your character first.')
            return
        end
        local mode = tostring(data.mode or '')
        -- THE LATEST CLICK WINS. pendingFlip queues a mode change to apply once we are back in
        -- our own world, and nothing used to clear it when the player chose something else in
        -- the meantime. A queued 'private' from an earlier Solo click then fired on the next
        -- join and overrode the Party the player had just asked for — the server logged
        -- mode_flip party immediately followed by mode_flip private, and the switcher snapped
        -- back to Solo with no explanation.
        pendingFlip = nil
        local inOwn = worldUrls.own ~= nil and net.currentTarget() == worldUrls.own
        if mode == 'solo' then
            if inOwn or not worldUrls.own then mp.sendEvent('SetWorldMode', { mode = 'private' })
            else pendingFlip = 'private'; net.switchTo(worldUrls.own) end
        elseif mode == 'party' then
            if inOwn or not worldUrls.own then mp.sendEvent('SetWorldMode', { mode = 'party' })
            else pendingFlip = 'party'; net.switchTo(worldUrls.own) end
        elseif mode == 'public' then
            if worldUrls.public and net.currentTarget() ~= worldUrls.public then net.switchTo(worldUrls.public)
            elseif not worldUrls.public then pendingPublic = true; mp.sendEvent('WorldList', {}) end
        elseif mode == 'offline' then
            if not inOwn and worldUrls.own then worldUrls.lastOut = net.currentTarget() end
            mp.sendEvent('SetAvailability', { state = 'offline' })
            if inOwn or not worldUrls.own then mp.sendEvent('SetWorldMode', { mode = 'private' })
            else pendingFlip = 'private'; net.switchTo(worldUrls.own) end
        elseif mode == 'online' then
            mp.sendEvent('SetAvailability', { state = 'online' })
            if worldUrls.lastOut and net.currentTarget() ~= worldUrls.lastOut then
                net.switchTo(worldUrls.lastOut); worldUrls.lastOut = nil
            end
        end
    end,

    -- Script removal lives here because removeScript is bound on GObject only. Both senders
    -- have already done whatever had to happen first (puppet.lua re-enables AI before
    -- asking), and the event hop is exactly what guarantees that ordering.
    mpPuppetDetached = function(data)
        if data.obj and data.obj:isValid() then
            data.obj:removeScript('scripts/mp/puppet.lua')
        end
    end,

    mpRemoveTestKill = function(data)
        if data.obj and data.obj:isValid() then
            data.obj:removeScript('scripts/mp/testkill.lua')
        end
    end,

    mpChatSend = function(data)
        if type(data.text) == 'string' and data.text ~= '' then
            -- Forward the channel selector's choice + whisper target, not just the text — the
            -- server reads {channel, to} (say/party/global/whisper). Dropping them here would
            -- silently flatten every message to 'say'.
            mp.sendEvent('ChatSend', {
                text = data.text,
                channel = tostring(data.channel or 'say'),
                to = tostring(data.to or ''),
            })
        end
    end,

    -- --- M7/M8 bridges + test hooks -------------------------------------------------------
    -- M2 PlayerEquipment is authored in the PLAYER script, but only the global script owns
    -- the custom-record registry (world.createRecord is global-only), so the snapshot is
    -- routed through here and every slot id is mapped to its SERVER record id first. A raw
    -- local dynamic id on the wire is the exact M3 bug §M7 exists to close.
    mpEquipmentOut = function(data)
        local slots = {}
        for slot, recordId in pairs(data.slots or {}) do
            slots[slot] = worldmp.toNet(recordId)
        end
        mp.sendEvent('PlayerEquipment', { slots = slots })
    end,
    mpGuiReply = function(data)
        worldmp.sendGuiReply(data.guiId, data.data)
    end,
    mpTestRest = function(data) worldmp.testRest(data.hours) end,
    mpTestRecord = function(data) worldmp.testCreateRecord(data.name, data.noRegister) end,
    mpTestSpell = function(data) worldmp.testCreateSpell(data.name) end,
    mpTestEnchanted = function(data) worldmp.testCreateEnchanted(data.name) end,
    mpTestWeather = function(data) worldmp.testWeather(data.index) end,
    mpTestAdmin = function(data) admin.send(data.cmd, data.args) end,
    -- E3: the admin window's uplink. Same registry, same rank gate, same audit trail as
    -- the /slash path — a second route to these actions would be a second place for the
    -- permission check to be wrong.
    mpAdminCommand = function(data)
        if type(data.cmd) == 'string' and data.cmd ~= '' then
            adminUiPending = adminUiPending + 1
            admin.send(data.cmd, data.args or {})
        end
    end,
    -- Test-only window openers. The harness cannot drive SDL keys (PLAYTEST.md 9), so
    -- without these no automated check of the UI is possible at all.
    mpOpenUi = function(data)
        if data.which == 'admin' then toPlayer('MP_AdminUiOpen', {})
        elseif data.which == 'social' then toPlayer('MP_SocialUiOpen', {}) end
    end,

    -- --- M6: quest-layer bridges + test hooks -------------------------------------------
    -- onQuestUpdate is a PLAYER-context engine handler; player.lua forwards it here so the
    -- journal cache/echo guard lives in exactly one place.
    mpQuestUpdate = function(data)
        quests.onQuestUpdate(data.questId, data.stage)
    end,
    -- Dialogue window closed on the player side -> release the lock.
    mpDialogueClosed = function()
        quests.releaseLock('windowclosed')
    end,
    mpTestQuest = function(data) quests.testSetQuestStage(data.id, data.stage) end,
    mpTestGlobal = function(data) quests.testSetGlobal(data.name, data.value) end,
    mpTestBounty = function(data) quests.testSetBounty(data.n) end,
    mpTestFaction = function(data) quests.testJoinFaction(data.id, data.rank) end,
    mpTestDialogue = function(data) quests.testActivateNpc(data.id) end,
    mpTestMemberVar = function(data) quests.testSetMemberVar(data.id, data.name, data.value) end,
}

-- M3: object-sync appliers (MP_ObjectPlace/Delete/Move/Lock, MP_DoorState,
-- MP_Container*, MP_WorldCellState, MP_ObjectSpawnAck) live in objects.lua.
for name, fn in pairs(objects.handlers) do
    eventHandlers[name] = fn
end
-- M4: actor-authority appliers (MP_ActorAuthority*, MP_ActorMoveBatch/StatsDynamic/Death,
-- MP_WorldKillCount) live in actors.lua.
for name, fn in pairs(actors.handlers) do
    eventHandlers[name] = fn
end
-- M7: world-state appliers (MP_WorldTime, MP_WorldWeather*, MP_Record*, MP_WorldCellReset,
-- MP_WorldMapExplored, MP_Gui*) live in world.lua; M8 ops appliers in admin.lua.
for name, fn in pairs(worldmp.handlers) do
    eventHandlers[name] = fn
end
for name, fn in pairs(admin.handlers) do
    eventHandlers[name] = fn
end
-- M6: quest-layer appliers (MP_JournalEntry/JournalSync, MP_GlobalVarUpdate,
-- MP_MemberVarUpdate, MP_FactionUpdate, MP_CrimeUpdate, MP_DialogueLockResult) live in
-- quests.lua.
for name, fn in pairs(quests.handlers) do
    eventHandlers[name] = fn
end
-- M5: combat appliers (MP_CombatHit/SpellHit/Cast/Projectile) live in combat.lua.
for name, fn in pairs(combat.handlers) do
    eventHandlers[name] = fn
end
-- puppet.lua -> here: a hit landed on a puppet; forward it to the victim's owner.
eventHandlers.mpCombatHit = combat.onPuppetHit
-- Wrap the op-result applier to expose the outcome to the harness (s31 race assert).
local baseOpResult = eventHandlers.MP_ContainerOpResult
eventHandlers.MP_ContainerOpResult = function(data)
    if data.opId == lastChestOpId then
        mp.testSet('chestOp', json.encode({ ok = data.ok == true, reason = data.reason }))
    end
    baseOpResult(data)
end

-- Web loading screen: a cell load BLOCKS the emscripten main loop, so the browser cannot
-- composite during it — OpenMW's own loading screen draws frames that never reach the screen
-- and the tab looks frozen. The only thing that works is having the overlay already ON SCREEN
-- before the block, so signal on door activation, which fires BEFORE the teleport.
-- ponytail: teleport doors only — that is the freeze players actually hit (boat -> dock,
-- entering a building). Widen to every cell boundary if the exteriors turn out to stall too.
local cellLoadSeq = 0
local function signalCellLoad()
    cellLoadSeq = cellLoadSeq + 1
    mp.testSet('cellLoad', tostring(cellLoadSeq))
end
I.Activation.addHandlerForType(types.Door, function(door, actor)
    if actor ~= world.players[1] then return end
    local ok, isTeleport = pcall(function() return types.Door.isTeleport(door) end)
    if ok and isTeleport then signalCellLoad() end
end)

return {
    engineHandlers = {
        onInit = start,
        onLoad = start,
        onActivate = function(object, actor)
            if net.state == 'Joined' then
                local ok, err = pcall(objects.onActivate, object, actor)
                if not ok then print('[mp] onActivate hook error: ' .. tostring(err)) end
                -- M6: watch the object's MWScript locals across the interaction window.
                local okq, errq = pcall(quests.onActivate, object, actor)
                if not okq then print('[mp] quests.onActivate hook error: ' .. tostring(errq)) end
            end
        end,
        onItemActive = function(item)
            if net.state == 'Joined' then
                local ok, err = pcall(objects.onItemActive, item)
                if not ok then print('[mp] onItemActive hook error: ' .. tostring(err)) end
            end
        end,
        onUpdate = function()
            net.tick()
            flushNotices()
            restoreTick()
            restorePositionTick(core.getRealTime())
            puppetTick()
            chargenTick()
            if net.state == 'Joined' then
                local now = core.getRealTime()
                objects.tick(now)
                actors.tick(now)
                quests.tick(now)
                worldmp.tick(now)
                mirrorDoor(now)
            end
        end,
    },
    eventHandlers = eventHandlers,
}
