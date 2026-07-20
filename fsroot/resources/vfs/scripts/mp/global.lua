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

local roster = {} -- array of {id=u16, name=string}, server order

local function mirrorRoster()
    mp.testSet('players', json.encode(roster))
end

local function playerScript()
    return world.players[1]
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
        local grantId = recordId
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

local function restoreTick()
    if not pendingRestore then return end
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
    if record.position then teleportPlayerTo(record.position) end
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
        elseif state == 'Offline' and wasJoined then
            notice('Multiplayer: connection lost — reload the page to retry')
        end
        if state ~= 'Joined' then
            roster = {}
            mirrorRoster()
            despawnAllPuppets()
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

    -- M1: one decoded 0x0101 batch -> route each entry to its puppet (spawning on first
    -- sighting — the server only sends poses of players visible to us).
    MP_MoveBatch = function(batch)
        local now = core.getRealTime()
        for _, e in ipairs(batch) do
            if e.id ~= net.playerId then
                lastPose[e.id] = { x = e.x, y = e.y, z = e.z }
                if not puppets[e.id] then spawnPuppet(e.id, e) end
                local p = puppets[e.id]
                if p and p.obj:isValid() then
                    e.t = now
                    p.obj:sendEvent('MP_Pose', e)
                end
            end
        end
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

    -- M1 snap service: puppet.lua steering diverged (blocked, warp) -> hard teleport.
    mpSnapRequest = function(data)
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
}

return {
    engineHandlers = {
        onInit = start,
        onLoad = start,
        onUpdate = function()
            net.tick()
            flushNotices()
            restoreTick()
            puppetTick()
        end,
    },
    eventHandlers = eventHandlers,
}
