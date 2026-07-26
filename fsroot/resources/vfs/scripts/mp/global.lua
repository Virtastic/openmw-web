-- Multiplayer GLOBAL orchestrator (omw-mp/1, M0+M1) — see server/PROTOCOL.md.
-- Connects on game start when the boot JS enabled MP (?mp= -> ENV OPENMW_MP_URL), drives the
-- session via scripts/mp/net.lua, maintains the player roster and forwards chat to the
-- player script. M1: owns remote-player puppet lifecycle (spawn/despawn/teleport) and routes
-- MP_MoveBatch entries to the per-puppet scripts. Mirrors {state, playerId, players, puppets}
-- into window.__omwMP for the harness.
local core = require('openmw.core')
local mp = require('openmw.mp')
local types = require('openmw.types')
local util = require('openmw.util')
local world = require('openmw.world')

local json = require('scripts.mp.json')
local net = require('scripts.mp.net')
local objects = require('scripts.mp.objects')
local actors = require('scripts.mp.actors')
local combat = require('scripts.mp.combat')
local quests = require('scripts.mp.quests')
local worldmp = require('scripts.mp.world')
local admin = require('scripts.mp.admin')

local roster = {} -- array of {id=u16, name=string}, server order

local function mirrorRoster()
    mp.testSet('players', json.encode(roster))
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
local d2Buf, nearBuf = {}, {} -- scratch, reused across batches (this runs 15x/second)

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

-- --- M1: remote-player puppets ---------------------------------------------------------
-- Server rule mirrored client-side: a remote player is visible when in the same cell, or an
-- adjacent exterior grid cell. The server only relays poses/cell-changes of visible players
-- (and force-includes a pose when someone enters the bubble), so the authoritative spawn
-- trigger is simply "first MP_MoveBatch entry for a rostered id"; PlayerCellChange handles
-- teleports and despawns.
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
    local name = rosterName(id) or ('player ' .. tostring(id))
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
    if p.obj:isValid() then p.obj:remove() end
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
    for _, entry in ipairs(record.inventory or {}) do
        local ok, item = pcall(function() return world.createObject(entry.id, entry.n or 1) end)
        if ok then
            item:moveInto(inventory)
            granted = granted + 1
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
    })
    net.onStateChanged = function(state)
        print('[mp] session state: ' .. state)
        if state == 'Joined' then
            wasJoined = true
            notice('Connected to ' .. tostring(net.serverName or 'server')
                .. ' as ' .. tostring(mp.getName() or '?'))
            if net.playerRecord then
                pendingRestore = net.playerRecord -- applied by restoreTick once the player exists
                net.playerRecord = nil
            end
        elseif state == 'Failed' then
            local why = FAIL_TEXT[net.lastError] or net.lastError or 'connection failed'
            local detail = net.lastErrorDetail
            notice('Multiplayer: ' .. why .. (detail and detail ~= '' and (' (' .. detail .. ')') or '')
                .. ' — reload the page to retry')
        elseif state == 'Reconnecting' then
            -- We redial ourselves now (backoff + jitter in net.lua), and the parked resume
            -- ticket means a short outage rejoins in place. Tell the player to wait, not to
            -- reload — reloading would actually cost them more.
            notice(string.format('Multiplayer: connection lost — reconnecting in %.0fs…',
                net.nextRetrySeconds or 0))
        elseif state == 'Offline' and wasJoined then
            notice('Multiplayer: disconnected')
        end
        if state ~= 'Joined' then
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

local eventHandlers = {
    MP_TransportOpen = function() net.onOpen() end,
    MP_TransportClose = function() net.onClose() end,
    MP_SessionJson = function(str) net.onJson(str) end,

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
        toPlayer('MP_UiChatMessage', { channel = 'server', text = tostring(data.name) .. ' joined' })
    end,

    MP_PlayerLeaveWorld = function(data)
        for i, p in ipairs(roster) do
            if p.id == data.id then
                toPlayer('MP_UiChatMessage', { channel = 'server', text = tostring(p.name) .. ' left' })
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
        local count = #batch
        for i = 1, count do
            local e = batch[i]
            if tiered then
                local dx, dy, dz = e.x - origin.x, e.y - origin.y, e.z - origin.z
                d2Buf[i] = dx * dx + dy * dy + dz * dz
            else
                d2Buf[i] = -1 -- not comparable: always near, never degraded
            end
        end
        local cutoff = nearCutoff(nearR2, tiered and (f.lodNearMaxAvatars or 0) or 0, count)

        -- Pass 2: tier and route.
        for i = 1, count do
            local e = batch[i]
            if e.id ~= net.playerId then
                lastPose[e.id] = { x = e.x, y = e.y, z = e.z }
                if not puppets[e.id] then spawnPuppet(e.id, e) end
                local p = puppets[e.id]
                if p and p.obj:isValid() then
                    local d2 = d2Buf[i]
                    local tier
                    if d2 < 0 or d2 <= cutoff then tier = TIER_NEAR
                    elseif d2 <= midR2 then tier = TIER_MID
                    else tier = TIER_FAR end
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
        tierSeen = {}
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
                p.obj:teleport(destCellArg(), util.vector3(data.x, data.y, data.z))
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
        if p and p.obj:isValid() then
            local cellArg = destCellArg()
            if cellArg then
                p.obj:teleport(cellArg, util.vector3(data.x, data.y, data.z))
                print('[mp] puppet snap #' .. tostring(data.id) .. ' (' .. tostring(data.why) .. ')')
            end
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
    mpChatSend = function(data)
        if type(data.text) == 'string' and data.text ~= '' then
            mp.sendEvent('ChatSend', { text = data.text })
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
