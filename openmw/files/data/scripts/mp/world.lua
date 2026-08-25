-- M7 world-state hub (GLOBAL context; wired from scripts/mp/global.lua).
-- See server/PROTOCOL.md §M7: the server-owned clock, per-region weather authority,
-- server-issued custom records, operator cell resets, shared map exploration and the
-- server-pushed GUI.
--
-- GLOBAL context because every writer here is global-only in 0.52:
--   world.mwscript.getGlobalVariables()  -- the calendar globals (worldbindings.cpp:164)
--   world.setGameTimeScale               -- worldbindings.cpp:85
--   world.createRecord                   -- custom records
-- The GUI is the exception (openmw.ui is player-context), so this module only routes the
-- Gui* bodies to player.lua and posts the reply that comes back.
local core = require('openmw.core')
local types = require('openmw.types')
local util = require('openmw.util')
local world = require('openmw.world')
local mp = require('openmw.mp')

local json = require('scripts.mp.json')

local worldmp = {}

-- injected by global.lua: {playerFn, ownCellKeyFn, ownIdFn, noticeFn, toPlayerFn}
local deps = nil

local TICK = 0.25
local MIRROR_INTERVAL = 0.5
local WEATHER_POLL = 2.0
local MAP_FLUSH = 5.0
-- Slew, never snap (PROTOCOL.md §M7): each tick we close a FRACTION of the gap to the
-- server clock instead of assigning it. A rest by another player therefore rolls the sky
-- forward over a couple of seconds rather than teleporting it.
local SLEW_FRACTION = 0.2
local SLEW_MIN_HOURS = 0.02 -- below this the difference is engine jitter; leave it alone
-- Above this, SNAP instead of slewing. Slew exists to absorb drift between two clocks that
-- already agree; it is the wrong tool for ADOPTING a clock. Arriving in a world whose time is
-- half a day from your own, a 20%-per-tick slew crawls — so two players standing next to each
-- other saw one in daylight and one at night, for minutes. A jump that large is a new world,
-- not drift.
local SNAP_HOURS = 1.0
-- An unexplained local jump this large means the ENGINE advanced time (rest/wait/script).
local LOCAL_JUMP_HOURS = 0.05
local MAX_REQUEST_HOURS = 30 * 24 -- server cap (worldtime.ts MAX_ADVANCE_HOURS)
-- How long a record may wait for a record it REFERENCES to be acked (see registerRecord).
local DEP_WAIT_SECONDS = 15

local MONTH_DAYS = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }

-- --- state -------------------------------------------------------------------------------

local target = nil -- last WorldTime body from the server
-- False until this session has taken a world's clock as its own. Reset on every join, so
-- switching worlds adopts the destination's time instead of dragging the old one along.
local adoptedClock = false
local targetAbs = nil -- ...as absolute game hours
local lastLocalAbs = nil -- our own clock at the previous tick (jump detector baseline)
local lastTickAt = nil
local timeScale = nil
local timeRequests = 0 -- WorldTimeRequests WE originated (mechanism evidence)
local timeApplied = 0 -- WorldTime bodies applied

local ownRegion = nil
local regionHolder = {} -- region -> holderId (0 = nobody)
local lastWeatherSent = nil -- fingerprint of the last WorldWeather we broadcast
local lastWeatherAt = 0
local weatherApplied = nil -- last inbound {region, current} we applied

local netToLocal = {} -- recordNetId -> local record id
local localToNet = {} -- local record id -> recordNetId
local pendingRecords = {} -- tempId -> local record id
-- localId -> {dep=<local id it references>, until_=} : a record whose RecordCreate must
-- WAIT for another record's ack (see registerRecord).
local pendingDeps = {}
local recordTemp = 0
local recordsSynced = 0

local exploredPending = {} -- cellKey -> true (not yet sent)
local exploredSent = {} -- cellKey -> true
local exploredIn = {} -- cellKeys received from peers (see the note in the handler)
local lastMapFlush = 0

local lastMirror = 0
local nextTickAt = 0

-- --- helpers -----------------------------------------------------------------------------

local function playerObj()
    return deps.playerFn()
end

local function globalStore()
    return world.mwscript.getGlobalVariables()
end

local function absHours(t)
    -- Same calendar the server normalizes with (worldtime.ts MONTH_DAYS): both sides must
    -- agree or the slew would chase a phantom difference across a month boundary.
    local days = 0
    for m = 1, math.max(0, (t.month or 1) - 1) do
        days = days + (MONTH_DAYS[m] or 30)
    end
    days = days + ((t.day or 1) - 1)
    return (((t.year or 0) * 365) + days) * 24 + (t.gameHour or 0)
end

-- The calendar globals, spelled EXACTLY as the engine keys them: lowercase.
--
-- This is a silent-write trap, measured on a live client rather than assumed. The store's
-- read path resolves case-insensitively (ESM RefId search), so `store['GameHour']` reads
-- fine — but the write path goes through World::getGlobalVariableType(), which looks the
-- name up in MWWorld::Globals (keys: "gamehour", "day", ... — globals.hpp:46-52), and
-- setGlobalVariableValue() has NO else branch (mwscriptbindings.cpp:82-96): an unmatched
-- type means the assignment is dropped with no error, no exception, nothing to pcall.
-- Probed: `gamehour=16` moved the clock, `GameHour=15` did nothing at all; same for
-- `day` vs `Day`. Hence lowercase here, plus the read-back check in writeLocalTime.
local TIME_FIELDS = { 'gamehour', 'day', 'month', 'year' }
local timeFields = nil
local clockWarned = false

local function probeTimeFields()
    if timeFields then return timeFields end
    local store = globalStore()
    timeFields = {}
    local present = 0
    for _, name in ipairs(TIME_FIELDS) do
        local ok, value = pcall(function() return store[name] end)
        timeFields[name] = ok and value ~= nil
        if timeFields[name] then present = present + 1 end
    end
    if present < #TIME_FIELDS then
        local missing = {}
        for _, name in ipairs(TIME_FIELDS) do
            if not timeFields[name] then missing[#missing + 1] = name end
        end
        print('[mp] world clock: this content has no ' .. table.concat(missing, '/')
            .. ' global; those components stay local')
    end
    return timeFields
end

local function readLocalTime()
    local store = globalStore()
    local fields = probeTimeFields()
    local function get(name, default)
        if not fields[name] then return default end
        local ok, value = pcall(function() return store[name] end)
        if not ok or value == nil then return default end
        return value
    end
    return {
        gameHour = get('gamehour', 0),
        day = get('day', 1),
        month = get('month', 0) + 1, -- MWScript Month is 0-based; the wire is 1-based
        year = get('year', 0),
    }
end

local clockWritable = nil -- nil = not proven yet, true/false = read-back verdict

local function writeLocalTime(t)
    local store = globalStore()
    local fields = probeTimeFields()
    local values = { gamehour = t.gameHour, day = t.day, month = t.month - 1, year = t.year }
    local wrote = false
    for _, name in ipairs(TIME_FIELDS) do
        if fields[name] then
            local ok, err = pcall(function() store[name] = values[name] end)
            if ok then
                wrote = wrote or name == 'gamehour'
            elseif not clockWarned then
                clockWarned = true
                print('[mp] world clock: ' .. name .. ' not writable: ' .. tostring(err))
            end
        end
    end
    -- The engine can drop a global write silently (see the TIME_FIELDS note), so PROVE the
    -- first one landed by reading it back instead of trusting the absence of an error.
    if wrote and clockWritable == nil then
        local okr, value = pcall(function() return store['gamehour'] end)
        clockWritable = okr and type(value) == 'number'
            and math.abs(value - t.gameHour) < 0.5
        if not clockWritable then
            print('[mp] world clock: writes are being dropped by the engine (wrote '
                .. tostring(t.gameHour) .. ', read back ' .. tostring(value) .. ')')
        end
    end
    return wrote
end

-- The server clock, with any component this content cannot store folded to our own value —
-- otherwise the slew would chase a difference it can never close (and write every tick).
local function targetAbsOf(body)
    local fields = probeTimeFields()
    local localT = readLocalTime()
    return absHours({
        gameHour = body.gameHour,
        day = fields.day and body.day or localT.day,
        month = fields.month and body.month or localT.month,
        year = fields.year and body.year or localT.year,
    })
end

-- Absolute hours -> {gameHour, day, month, year}, MW calendar.
local function fromAbs(abs)
    local totalDays = math.floor(abs / 24)
    local gameHour = abs - totalDays * 24
    local year = math.floor(totalDays / 365)
    local dayOfYear = totalDays - year * 365
    local month = 1
    while month <= 12 and dayOfYear >= (MONTH_DAYS[month] or 30) do
        dayOfYear = dayOfYear - (MONTH_DAYS[month] or 30)
        month = month + 1
    end
    if month > 12 then month = 12 end
    return { gameHour = gameHour, day = dayOfYear + 1, month = month, year = year }
end

-- ================================================================== clock

local function tickClock(now)
    local localT = readLocalTime()
    if not localT then return end
    local localAbs = absHours(localT)

    -- Engine-side advance detector: the player rested/waited (or a script moved the clock).
    -- Anything beyond the free-run we expect since the last tick is a local jump, and §M7
    -- says one player resting advances time for EVERYONE — so it becomes a request.
    if lastLocalAbs and lastTickAt then
        local expectedDrift = (now - lastTickAt) * (timeScale or 0) / 3600
        local jump = localAbs - lastLocalAbs - expectedDrift
        if jump > LOCAL_JUMP_HOURS and jump <= MAX_REQUEST_HOURS then
            timeRequests = timeRequests + 1
            mp.sendEvent('WorldTimeRequest', { advanceHours = jump, reason = 'rest' })
            -- Adopt it locally: the server will echo it back as WorldTime and the slew
            -- must not then treat our own rest as a gap to close twice.
            if targetAbs then targetAbs = targetAbs + jump end
        end
    end

    -- Slew toward the server clock.
    if targetAbs then
        -- The server free-runs too; extrapolate its clock so we converge on a moving target.
        if lastTickAt then targetAbs = targetAbs + (now - lastTickAt) * (timeScale or 0) / 3600 end
        local delta = targetAbs - localAbs
        if math.abs(delta) >= SLEW_MIN_HOURS then
            -- Big gap = we just arrived somewhere; take the world's time as given.
            local step = (math.abs(delta) >= SNAP_HOURS) and delta or (delta * SLEW_FRACTION)
            local newAbs = localAbs + step
            if writeLocalTime(fromAbs(newAbs)) then
                localAbs = newAbs
            end
        end
    end

    lastLocalAbs = localAbs
    lastTickAt = now
end

-- ================================================================== weather

local weatherIndex = nil -- recordId -> 0-based wire index

local function buildWeatherIndex()
    if weatherIndex then return weatherIndex end
    weatherIndex = {}
    local ok = pcall(function()
        for i, rec in ipairs(core.weather.records) do
            weatherIndex[rec.recordId] = i - 1 -- the wire is 0-based (TES3MP convention)
        end
    end)
    if not ok then weatherIndex = {} end
    return weatherIndex
end

local function weatherRecordAt(index)
    local ok, rec = pcall(function() return core.weather.records[index + 1] end)
    if ok then return rec end
    return nil
end

local function isHolderOf(region)
    return region ~= nil and regionHolder[region] ~= nil and regionHolder[region] == deps.ownIdFn()
end

local function tickWeather(now)
    if now - lastWeatherAt < WEATHER_POLL then return end
    lastWeatherAt = now
    if not ownRegion or not isHolderOf(ownRegion) then return end
    local okc, current = pcall(function() return core.weather.getCurrent() end)
    if not okc or not current then return end -- interiors have no sky
    local index = buildWeatherIndex()
    local body = { region = ownRegion, current = index[current.recordId] or 0 }
    local okn, nextW = pcall(function() return core.weather.getNext() end)
    if okn and nextW then body.next = index[nextW.recordId] end
    local okt, transition = pcall(function() return core.weather.getTransition() end)
    if okt and type(transition) == 'number' then
        body.transition = math.max(0, math.min(1, transition))
    end
    local fp = string.format('%s|%d|%s|%.2f', body.region, body.current,
        tostring(body.next), body.transition or 0)
    if fp == lastWeatherSent then return end
    lastWeatherSent = fp
    mp.sendEvent('WorldWeather', body)
end

-- ================================================================== records

-- Every §M7 RecordCreate kind, with the store that owns it. Spells and enchantments are
-- NOT under openmw.types (they live in core.magic — magicbindings.cpp:242/248), which is
-- why a types-only search makes them look absent; world.createRecord takes both
-- (worldbindings.cpp createRecord overloads for ESM::Spell / ESM::Enchantment).
local RECORD_KIND_OF_TYPE = {
    { kind = 'armor', t = types.Armor },
    { kind = 'weapon', t = types.Weapon },
    { kind = 'clothing', t = types.Clothing },
    { kind = 'book', t = types.Book },
    { kind = 'potion', t = types.Potion },
    { kind = 'misc', t = types.Miscellaneous },
    { kind = 'spell', t = core.magic.spells },
    { kind = 'enchantment', t = core.magic.enchantments },
}

local DRAFT_OF_KIND = {
    armor = types.Armor, weapon = types.Weapon, clothing = types.Clothing,
    book = types.Book, potion = types.Potion, misc = types.Miscellaneous,
    spell = core.magic.spells, enchantment = core.magic.enchantments,
}

-- Effect entries are userdata (ESM3_EffectParams), so they are copied field by field in
-- both directions; the names match tableToEnamStruct (magictypebindings.cpp:149).
local EFFECT_FIELDS = {
    'id', 'affectedSkill', 'affectedAttribute', 'range', 'area',
    'magnitudeMin', 'magnitudeMax', 'duration',
}

-- Fields we copy both ways. Anything absent on a given kind is simply skipped, so one
-- table serves every item kind.
local RECORD_FIELDS = {
    'name', 'model', 'icon', 'weight', 'value', 'type', 'health', 'baseArmor',
    'enchantCapacity', 'isScroll', 'skill', 'chopMinDamage', 'chopMaxDamage',
    'slashMinDamage', 'slashMaxDamage', 'thrustMinDamage', 'thrustMaxDamage', 'speed',
    'reach', 'text', 'isAutocalc', 'cost', 'charge', 'alwaysSucceedFlag',
    'starterSpellFlag',
}

-- A record the local client MINTED (world.createRecord): those ids are per-client and must
-- never travel — that is the M3 bug §M7 exists to close (a peer resolved a foreign dynamic
-- id onto an unrelated local record).
--
-- 0.52 mints them as "Generated:0x<n>" (ESM::RefId::generated -> serializeText), numbered
-- per client, which is exactly why two clients can hand each other the same string for two
-- different records. VERIFIED against a live client, not assumed: a runtime armor record
-- came back as `Generated:0x0`. '$' is kept because older builds used that form.
local function isDynamicId(id)
    if type(id) ~= 'string' then return false end
    return id:sub(1, 1) == '$' or id:sub(1, 10) == 'Generated:'
end

local function kindOfLocalRecord(id)
    for _, entry in ipairs(RECORD_KIND_OF_TYPE) do
        local ok, rec = pcall(function() return entry.t.records[id] end)
        if ok and rec then return entry.kind, rec end
    end
    return nil
end

local function effectsData(rec)
    local ok, list = pcall(function() return rec.effects end)
    if not ok or not list then return nil end
    local out = {}
    local okIter = pcall(function()
        for _, effect in ipairs(list) do
            local entry = {}
            for _, field in ipairs(EFFECT_FIELDS) do
                local okf, value = pcall(function() return effect[field] end)
                if okf and value ~= nil then entry[field] = value end
            end
            out[#out + 1] = entry
        end
    end)
    if not okIter or #out == 0 then return nil end
    return out
end

-- Forward declaration: an enchanted item's `enchant` field is itself a record id, and it
-- has to be mapped through the registry in both directions or the peer would resolve the
-- AUTHOR's local enchantment id (the same class of bug as the item id itself).
local toNetId, toLocalId

local function recordData(rec)
    local data = {}
    for _, field in ipairs(RECORD_FIELDS) do
        local ok, value = pcall(function() return rec[field] end)
        if ok and value ~= nil and type(value) ~= 'userdata' and type(value) ~= 'function' then
            data[field] = value
        end
    end
    local okEnchant, enchant = pcall(function() return rec.enchant end)
    if okEnchant and type(enchant) == 'string' and enchant ~= '' then
        data.enchant = toNetId(enchant)
    end
    local effects = effectsData(rec)
    if effects then data.effects = effects end
    return data
end

-- Announce a locally minted record so every client can resolve it by the SERVER's id.
function worldmp.registerRecord(localId)
    if not isDynamicId(localId) or localToNet[localId] then return localToNet[localId] end
    local kind, rec = kindOfLocalRecord(localId)
    if not kind then
        print('[mp] record ' .. tostring(localId) .. ' is not an item kind we can share')
        return nil
    end
    for tempId, pendingId in pairs(pendingRecords) do
        if pendingId == localId then return nil end -- already in flight
    end
    -- An enchanted item REFERENCES another custom record. Its server id only exists once
    -- the server has acked it, so the item's own RecordCreate has to wait for that ack —
    -- otherwise recordData() serializes the enchantment as our LOCAL id and the peer
    -- rebuilds an item pointing at a record it does not have. (Caught by s71: B received
    -- `enchant="Generated:0x3"` — the author's id — and lost the enchantment entirely.)
    local okEnchant, enchant = pcall(function() return rec.enchant end)
    if okEnchant and type(enchant) == 'string' and enchant ~= '' and isDynamicId(enchant) then
        worldmp.registerRecord(enchant)
        if not localToNet[enchant] then
            pendingDeps[localId] = { dep = enchant, until_ = core.getRealTime() + DEP_WAIT_SECONDS }
            return nil
        end
    end
    recordTemp = recordTemp + 1
    pendingRecords[recordTemp] = localId
    mp.sendEvent('RecordCreate', { tempId = recordTemp, kind = kind, data = recordData(rec) })
    return nil
end

-- Wire id for a local record id (identity for content records).
toNetId = function(localId) return worldmp.toNet(localId) end
toLocalId = function(netId) return worldmp.toLocal(netId) end

function worldmp.toNet(localId)
    if localToNet[localId] then return localToNet[localId] end
    if isDynamicId(localId) then
        worldmp.registerRecord(localId) -- late: still local this frame, netId lands shortly
    end
    return localId
end

-- Local record id for a wire id (identity for content records / unknown ids).
function worldmp.toLocal(netId)
    return netToLocal[netId] or netId
end

function worldmp.isNetRecord(netId)
    return netToLocal[netId] ~= nil
end

local function applyRecord(entry)
    local netId = entry.recordNetId
    if type(netId) ~= 'string' or netToLocal[netId] then return end
    local draftType = DRAFT_OF_KIND[entry.kind]
    if not draftType then
        print('[mp] RecordsSync: unsupported kind ' .. tostring(entry.kind))
        return
    end
    local data = {}
    for k, v in pairs(entry.data or {}) do data[k] = v end
    if type(data.enchant) == 'string' then
        data.enchant = toLocalId(data.enchant)
    end
    if type(data.effects) == 'table' then
        -- LSER arrays come back 1-based integer-keyed, which is what createRecordDraft wants.
        local effects = {}
        for _, e in ipairs(data.effects) do effects[#effects + 1] = e end
        data.effects = effects
    end
    local ok, rec = pcall(function()
        return world.createRecord(draftType.createRecordDraft(data))
    end)
    if not ok then
        print('[mp] RecordsSync: could not build ' .. tostring(entry.kind) .. ' ' .. netId
            .. ': ' .. tostring(rec))
        return
    end
    netToLocal[netId] = rec.id
    localToNet[rec.id] = netId
    recordsSynced = recordsSynced + 1
end

-- ================================================================== handlers

local handlers = {}

handlers.MP_WorldTime = function(data)
    if type(data.gameHour) ~= 'number' then return end
    target = data
    targetAbs = targetAbsOf(data)
    timeApplied = timeApplied + 1
    -- ADOPT THE WORLD'S CLOCK OUTRIGHT ON ARRIVAL. The server's clock free-runs whether or
    -- not anyone is connected, so a world left alone for an afternoon is game-DAYS ahead of
    -- a client that just booted. Slewing that difference walks the sky through cycle after
    -- cycle of day and night while the player stands there watching. Time of day is not
    -- something to converge on — it is a fact about the world you just entered. Take it in
    -- one step, then slew from there for the ordinary drift between two running clocks.
    if not adoptedClock then
        adoptedClock = true
        local t = readLocalTime()
        if t and writeLocalTime(fromAbs(targetAbs)) then
            lastLocalAbs = targetAbs   -- ours, not a rest: keep the jump detector quiet
        end
    end
    if type(data.timeScale) == 'number' and data.timeScale ~= timeScale then
        timeScale = data.timeScale
        -- The server owns the rate too: match it so our free-run does not drift away
        -- between broadcasts. timeScale 0 is legal (a frozen world).
        local ok, err = pcall(function() world.setGameTimeScale(timeScale) end)
        if not ok then print('[mp] setGameTimeScale failed: ' .. tostring(err)) end
    end
end

handlers.MP_WorldWeatherAuthority = function(data)
    if type(data.region) ~= 'string' then return end
    local holder = data.holderId
    regionHolder[data.region] = (type(holder) == 'number' and holder ~= 0) and holder or nil
    if regionHolder[data.region] == nil then
        lastWeatherSent = nil -- lost it: re-announce from scratch if we get it back
    end
end

handlers.MP_WorldWeather = function(data)
    if type(data.region) ~= 'string' or type(data.current) ~= 'number' then return end
    -- The broadcast is global; only the region we are standing in is ours to render, and
    -- the holder must never apply its own echo back onto itself.
    --
    -- EXCEPT the continuity handback (`restore`), which the server sends to the NEW HOLDER
    -- immediately after granting it the region, carrying the weather that region had before it
    -- went dormant. That arrives after the grant, so this guard used to discard it — leaving the
    -- holder on whatever weather it rolled at boot. Solo, that is a fresh roll every session:
    -- the "weather is randomised on each load" report.
    if isHolderOf(data.region) and data.restore ~= true then return end
    local rec = weatherRecordAt(data.current)
    if not rec then
        print('[mp] weather index ' .. tostring(data.current) .. ' unknown here')
        return
    end
    local ok, err = pcall(function() core.weather.changeWeather(data.region, rec) end)
    if not ok then
        print('[mp] changeWeather(' .. data.region .. ') failed: ' .. tostring(err))
        return
    end
    weatherApplied = { region = data.region, current = data.current }
end

handlers.MP_RecordCreateAck = function(data)
    local localId = pendingRecords[data.tempId]
    pendingRecords[data.tempId] = nil
    if not localId or type(data.recordNetId) ~= 'string' then return end
    netToLocal[data.recordNetId] = localId
    localToNet[localId] = data.recordNetId
end

handlers.MP_RecordsSync = function(data)
    for _, entry in ipairs(data.records or {}) do
        applyRecord(entry)
    end
end

handlers.MP_WorldCellReset = function(data)
    if type(data.cellKey) ~= 'string' then return end
    print('[mp] cell reset: ' .. data.cellKey)
    if deps.onCellResetFn then deps.onCellResetFn(data.cellKey) end
end

handlers.MP_WorldMapExplored = function(data)
    -- Applied through mp.setMapExplored (mwmp/luabindings.cpp -> WindowManager::
    -- addVisitedLocation): a peer's discovery puts the location on OUR map. Interior keys
    -- carry no grid position, so only exterior cells can travel.
    local applied = 0
    for _, key in ipairs(data.cellKeys or {}) do
        if type(key) == 'string' then
            exploredIn[key] = true
            local gx, gy = key:match('^(-?%d+),(-?%d+)$')
            if gx and mp.setMapExplored then
                local name = key
                local okc, cell = pcall(function() return world.getExteriorCell(tonumber(gx), tonumber(gy)) end)
                if okc and cell and cell.name and cell.name ~= '' then name = cell.name end
                local ok, err = pcall(function() mp.setMapExplored(name, tonumber(gx), tonumber(gy)) end)
                if ok then
                    applied = applied + 1
                else
                    print('[mp] setMapExplored(' .. key .. ') failed: ' .. tostring(err))
                end
            end
        end
    end
    mp.testSet('mapExploredIn', string.format('%.0f', applied))
end

handlers.MP_GuiMessageBox = function(data)
    deps.toPlayerFn('MP_Gui', { kind = 'messagebox', guiId = data.guiId,
        text = data.text, buttons = data.buttons })
end

handlers.MP_GuiInputDialog = function(data)
    deps.toPlayerFn('MP_Gui', { kind = 'input', guiId = data.guiId, label = data.label })
end

handlers.MP_GuiListBox = function(data)
    deps.toPlayerFn('MP_Gui', { kind = 'list', guiId = data.guiId,
        label = data.label, items = data.items })
end

-- player.lua answered a dialog (mpGuiReply -> here -> the server).
function worldmp.sendGuiReply(guiId, replyData)
    if type(guiId) ~= 'number' then return end
    mp.sendEvent('GuiReply', { guiId = guiId, data = replyData or {} })
end

worldmp.handlers = handlers

-- ================================================================== region / map

local function tickRegion()
    local player = playerObj()
    if not player or not player.cell then return end
    local ok, region = pcall(function() return player.cell.region end)
    if not ok then return end
    -- Interiors report no region (RefId empty -> nil): keep the last exterior one rather
    -- than flapping the server's occupancy on every doorway.
    if type(region) ~= 'string' or region == '' or region == ownRegion then return end
    ownRegion = region
    lastWeatherSent = nil
    mp.sendEvent('WorldRegionChange', { region = region })
end

function worldmp.onCellEntered(cellKey)
    if type(cellKey) == 'string' and not exploredSent[cellKey] then
        exploredPending[cellKey] = true
    end
end

local function tickMap(now)
    if now - lastMapFlush < MAP_FLUSH then return end
    lastMapFlush = now
    local keys = {}
    for key in pairs(exploredPending) do
        keys[#keys + 1] = key
        exploredSent[key] = true
    end
    if #keys == 0 then return end
    exploredPending = {}
    mp.sendEvent('WorldMapExplored', { cellKeys = keys })
end

-- ================================================================== tick / mirror

local function mirror()
    local localT = readLocalTime()
    if localT then
        mp.testSet('gameTime', json.encode({
            gameHour = math.floor((localT.gameHour or 0) * 100 + 0.5) / 100,
            day = localT.day, month = localT.month, year = localT.year,
            abs = math.floor(absHours(localT) * 100 + 0.5) / 100,
        }))
    end
    mp.testSet('timeScale', timeScale and string.format('%.2f', timeScale) or '')
    mp.testSet('clockWritable', clockWritable == nil and '' or tostring(clockWritable))
    mp.testSet('timeApplied', string.format('%.0f', timeApplied))
    mp.testSet('timeRequests', string.format('%.0f', timeRequests))
    mp.testSet('region', ownRegion or '')
    local holder = ownRegion and regionHolder[ownRegion] or nil
    mp.testSet('weatherHolder', holder and string.format('%.0f', holder) or 'none')
    mp.testSet('isWeatherHolder', tostring(isHolderOf(ownRegion)))
    mp.testSet('weatherApplied', weatherApplied and json.encode(weatherApplied) or '')
    local recs = {}
    local described = {}
    for netId, localId in pairs(netToLocal) do
        recs[netId] = localId
        local info = worldmp.describeRecord(localId)
        if info then described[netId] = info end
    end
    mp.testSet('netRecords', json.encode(recs))
    -- What each shared record actually IS on this client (name/effect/enchantment), so a
    -- scenario can prove the REAL record resolved rather than a same-shaped placeholder.
    mp.testSet('netRecordInfo', json.encode(described))
    mp.testSet('recordsSynced', string.format('%.0f', recordsSynced))
end

local function tickRecordDeps(now)
    for localId, entry in pairs(pendingDeps) do
        if localToNet[entry.dep] then
            pendingDeps[localId] = nil
            worldmp.registerRecord(localId) -- the dependency has a server id now
        elseif now > entry.until_ then
            pendingDeps[localId] = nil
            -- Never ship it with an untranslatable reference: say so instead.
            print('[mp] record ' .. tostring(localId) .. ' not shared: its referenced record '
                .. tostring(entry.dep) .. ' was never acked')
        end
    end
end

function worldmp.tick(now)
    tickRecordDeps(now)
    if now >= nextTickAt then
        nextTickAt = now + TICK
        tickClock(now)
        tickRegion()
    end
    tickWeather(now)
    tickMap(now)
    if now - lastMirror >= MIRROR_INTERVAL then
        lastMirror = now
        mirror()
    end
end

function worldmp.reset()
    target = nil
    targetAbs = nil
    adoptedClock = false -- next world's clock is adopted outright, not slewed towards
    lastLocalAbs = nil
    lastTickAt = nil
    timeRequests = 0
    timeApplied = 0
    ownRegion = nil
    regionHolder = {}
    lastWeatherSent = nil
    weatherApplied = nil
    netToLocal = {}
    localToNet = {}
    pendingRecords = {}
    pendingDeps = {}
    recordsSynced = 0
    exploredPending = {}
    exploredSent = {}
end

-- ================================================================== test hooks

-- Advance the LOCAL clock the way resting does, so the jump detector (the real mechanism)
-- is what produces the WorldTimeRequest.
function worldmp.testRest(hours)
    local localT = readLocalTime()
    if not localT then return end
    writeLocalTime(fromAbs(absHours(localT) + hours))
end

-- Mint a custom item record locally, exactly like enchanting/alchemy would, and register
-- it with the server. Returns the local id.
-- `noRegister` mints a record that never reaches the server. Its only use is to make one
-- client's dynamic-id counter diverge from the other's: both clients rebuild every SHARED
-- record, so their `Generated:0x<n>` counters otherwise advance in lockstep and the same
-- number means the same record by accident — which would let a broken registry pass a
-- cross-client test (measured: both clients minted `Generated:0x2` for it).
function worldmp.testCreateRecord(name, noRegister)
    local ok, rec = pcall(function()
        return world.createRecord(types.Armor.createRecordDraft({
            name = name,
            model = 'meshes/marker_error.osgt',
            icon = '',
            type = types.Armor.TYPE.Cuirass,
            weight = 3,
            value = 777,
            health = 250,
            baseArmor = 17,
            enchantCapacity = 0,
        }))
    end)
    if not ok then
        print('[mp] testCreateRecord failed: ' .. tostring(rec))
        return nil
    end
    if not noRegister then
        worldmp.registerRecord(rec.id)
        local player = playerObj()
        if player then
            world.createObject(rec.id):moveInto(types.Actor.inventory(player))
        end
    end
    mp.testSet('lastRecordLocalId', rec.id)
    return rec.id
end

-- Mint a custom SPELL the way spellmaking does, and register it (§M7 kind "spell").
function worldmp.testCreateSpell(name)
    local effectId = nil
    local okE = pcall(function()
        for _, rec in ipairs(core.magic.effects.records) do
            if rec.id then effectId = rec.id break end
        end
    end)
    if not okE or not effectId then
        print('[mp] testCreateSpell: no magic effects in this content')
        return nil
    end
    local ok, rec = pcall(function()
        return world.createRecord(core.magic.spells.createRecordDraft({
            name = name,
            type = core.magic.SPELL_TYPE.Spell,
            cost = 15,
            effects = { { id = effectId, range = 0, area = 0,
                magnitudeMin = 5, magnitudeMax = 9, duration = 7 } },
        }))
    end)
    if not ok then
        print('[mp] testCreateSpell failed: ' .. tostring(rec))
        return nil
    end
    worldmp.registerRecord(rec.id)
    mp.testSet('lastSpellLocalId', rec.id)
    return rec.id
end

-- Mint an ENCHANTED item: enchantment record + an armor record that references it, which
-- is the case where a raw local id would poison the peer twice over.
function worldmp.testCreateEnchanted(name)
    local effectId = nil
    pcall(function()
        for _, rec in ipairs(core.magic.effects.records) do
            if rec.id then effectId = rec.id break end
        end
    end)
    if not effectId then
        print('[mp] testCreateEnchanted: no magic effects in this content')
        return nil
    end
    local okE, ench = pcall(function()
        return world.createRecord(core.magic.enchantments.createRecordDraft({
            type = core.magic.ENCHANTMENT_TYPE.ConstantEffect,
            charge = 100,
            cost = 10,
            isAutocalc = false,
            effects = { { id = effectId, range = 0, area = 0,
                magnitudeMin = 3, magnitudeMax = 3, duration = 0 } },
        }))
    end)
    if not okE then
        print('[mp] testCreateEnchanted: enchantment failed: ' .. tostring(ench))
        return nil
    end
    local okA, armor = pcall(function()
        return world.createRecord(types.Armor.createRecordDraft({
            name = name,
            model = 'meshes/marker_error.osgt',
            icon = '',
            type = types.Armor.TYPE.Helmet,
            weight = 2,
            value = 900,
            health = 200,
            baseArmor = 11,
            enchantCapacity = 20,
            enchant = ench.id,
        }))
    end)
    if not okA then
        print('[mp] testCreateEnchanted: armor failed: ' .. tostring(armor))
        return nil
    end
    worldmp.registerRecord(armor.id) -- registers the enchantment first
    local player = playerObj()
    if player then
        world.createObject(armor.id):moveInto(types.Actor.inventory(player))
    end
    mp.testSet('lastEnchantLocalId', armor.id)
    return armor.id
end

-- What a record resolves to here, including its enchantment chain: the scenarios compare
-- this across clients, because a placeholder stand-in still "exists".
function worldmp.describeRecord(recordId)
    for _, entry in ipairs(RECORD_KIND_OF_TYPE) do
        local ok, rec = pcall(function() return entry.t.records[recordId] end)
        if ok and rec then
            local out = { kind = entry.kind, name = rec.name or '' }
            local okc, cost = pcall(function() return rec.cost end)
            if okc and cost then out.cost = cost end
            local oke, enchant = pcall(function() return rec.enchant end)
            if oke and type(enchant) == 'string' and enchant ~= '' then
                out.enchant = enchant
                local oken, ench = pcall(function() return core.magic.enchantments.records[enchant] end)
                if oken and ench then
                    local effects = effectsData(ench)
                    out.enchantEffect = effects and effects[1] and effects[1].id or ''
                    local okch, charge = pcall(function() return ench.charge end)
                    if okch then out.enchantCharge = charge end
                end
            end
            local effects = effectsData(rec)
            if effects and effects[1] then
                out.effect = effects[1].id
                out.magnitude = effects[1].magnitudeMax
            end
            return out
        end
    end
    return nil
end

function worldmp.testWeather(index)
    local rec = weatherRecordAt(index)
    if not rec then
        print('[mp] testWeather: no weather index ' .. tostring(index))
        return
    end
    if not ownRegion then
        print('[mp] testWeather: no region yet')
        return
    end
    local ok, err = pcall(function() core.weather.changeWeather(ownRegion, rec) end)
    if not ok then print('[mp] testWeather failed: ' .. tostring(err)) end
end

-- Name of the record an object resolves to here (scenario evidence that a peer got the
-- REAL record and not a placeholder).
function worldmp.recordNameOf(recordId)
    for _, entry in ipairs(RECORD_KIND_OF_TYPE) do
        local ok, rec = pcall(function() return entry.t.records[recordId] end)
        if ok and rec then return rec.name or '' end
    end
    return nil
end

function worldmp.init(d)
    deps = d
end

return worldmp
