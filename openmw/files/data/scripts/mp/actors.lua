-- M4 shared-NPC authority hub (GLOBAL context; wired from scripts/mp/global.lua).
-- See server/PROTOCOL.md §M4. The server grants each cell a single authority HOLDER; that
-- client simulates the cell's NPCs/creatures (normal engine AI) and broadcasts their pose /
-- stats / death. Every other client renders them as ref-keyed puppets (scripts/mp/puppet.lua
-- with enableAI(false)), driven off ActorMoveBatch. Simulation hands off seamlessly when the
-- holder leaves (Grant to the longest-present remaining occupant, epoch-guarded).
local core = require('openmw.core')
local types = require('openmw.types')
local util = require('openmw.util')
local world = require('openmw.world')
local mp = require('openmw.mp')

local json = require('scripts.mp.json')

local actors = {}

local BROADCAST_HZ = 15
local SNAPSHOT_SECONDS = 5
-- How often a non-holder re-sweeps its cell for actors to puppet. Cheap (per-key
-- idempotent) and must keep running: cell actors stream in after the cell-change event.
local ATTACH_SWEEP_SECONDS = 1
local STATS_MIN_INTERVAL = 0.25

local deps = nil -- {playerFn, ownCellKeyFn, ownIdFn, isMpPuppetFn}

-- Per-cell authority we hold: cellKey -> epoch. We only ever hold our own current cell in
-- practice, but the server addresses by cellKey, so key by it.
local held = {} -- cellKey -> { epoch, actors = { refKey -> tracked } }
local holderOfCell = {} -- cellKey -> holderId (non-holder knowledge, from ActorAuthorityInfo)
local infoEpoch = {} -- cellKey -> epoch learned as a NON-holder (M5 actor targeting)
local puppetActors = {} -- refKey -> { obj, cellKey } (NPCs we puppet as a non-holder)

local lastBroadcast = 0
local lastSnapshot = 0
local lastMirror = 0
local lastAttachSweep = 0
local watchKillRecord = nil -- record whose shared kill tally the scenarios watch
local batchesIn = 0 -- diagnostic: ActorMoveBatch frames applied as a non-holder

-- --------------------------------------------------------------- ref helpers

local function refKeyOf(obj)
    -- content-file objects only (actors are never runtime-spawned): stable per session.
    return 'o:' .. obj.id
end

local function cellKeyOf(cell)
    if not cell then return nil end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

-- Live NPCs/creatures physically in the given cellKey, excluding the player and any MP
-- puppets (remote-player avatars we spawned — those are driven by player move frames, and
-- driving/broadcasting them as actors would double-drive them).
local function cellActors(cellKey)
    local out = {}
    for _, obj in ipairs(world.activeActors) do
        if obj:isValid()
            and not types.Player.objectIsInstance(obj)
            and cellKeyOf(obj.cell) == cellKey
            and not deps.isMpPuppetFn(obj) then
            out[#out + 1] = obj
        end
    end
    return out
end

-- --------------------------------------------------------------- holder mode

local function actorPose(obj)
    local pos = obj.position
    local walkSpeed = 0
    local speed = 0
    pcall(function()
        walkSpeed = types.Actor.getWalkSpeed(obj)
        speed = types.Actor.getCurrentSpeed(obj)
    end)
    local animVel = walkSpeed > 0 and (speed / walkSpeed) or 0
    -- Coarse AI-package hint from motion (reading a foreign actor's AI package is not
    -- exposed to global scripts; motion is a good enough facing/anim hint for puppets).
    local flags = 0
    local ok, running = pcall(function() return types.Actor.isRunning and types.Actor.isRunning(obj) end)
    if ok and running then flags = flags + 1 end
    return {
        obj = obj,
        x = pos.x, y = pos.y, z = pos.z,
        yaw = obj.rotation:getYaw(),
        pitch = 0,
        flags = flags,
        animVel = animVel,
    }
end

local function dynSnapshot(obj)
    local d = types.Actor.stats.dynamic
    local function stat(s)
        return { c = math.floor(s.current + 0.5), b = math.floor(s.base + 0.5) }
    end
    return { hp = stat(d.health(obj)), mp = stat(d.magicka(obj)), ft = stat(d.fatigue(obj)) }
end

local function broadcastCell(cellKey, epoch, cell, now)
    local batch = {}
    local live = cellActors(cellKey)
    for _, obj in ipairs(live) do
        local key = refKeyOf(obj)
        cell.actors[key] = cell.actors[key] or { deathNo = 0 }
        local tracked = cell.actors[key]
        tracked.obj = obj
        tracked.seen = now

        batch[#batch + 1] = actorPose(obj)

        -- Stats diff (0.25 s min): hp/mp/ft change or death.
        local dead = types.Actor.isDead(obj)
        if not tracked.nextStats or now >= tracked.nextStats then
            local dyn = dynSnapshot(obj)
            local fp = dyn.hp.c .. '/' .. dyn.mp.c .. '/' .. dyn.ft.c
            if fp ~= tracked.statsFp then
                tracked.statsFp = fp
                tracked.nextStats = now + STATS_MIN_INTERVAL
                mp.sendEvent('ActorStatsDynamic',
                    { cellKey = cellKey, epoch = epoch, ref = obj, hp = dyn.hp, mp = dyn.mp, ft = dyn.ft })
            end
        end

        -- Death edge -> ActorDeath (killedRecordId is the tally key the server counts on).
        if dead and not tracked.dead then
            tracked.dead = true
            tracked.deathNo = (tracked.deathNo or 0) + 1
            mp.sendEvent('ActorDeath', {
                cellKey = cellKey,
                epoch = epoch,
                ref = obj,
                killerPlayerId = deps.ownIdFn(), -- holder attribution; nil-safe on the server
                deathNo = tracked.deathNo,
                killedRecordId = obj.recordId,
            })
        elseif not dead then
            tracked.dead = false
        end
    end

    if #batch > 0 then
        mp.sendActorMoveBatch(epoch, batch)
    end
end

local function snapshotCell(cellKey, epoch)
    local snapActors = {}
    for _, obj in ipairs(cellActors(cellKey)) do
        local dyn = dynSnapshot(obj)
        snapActors[#snapActors + 1] = {
            ref = obj,
            x = obj.position.x, y = obj.position.y, z = obj.position.z,
            rotZ = obj.rotation:getYaw(),
            hp = dyn.hp, mp = dyn.mp, ft = dyn.ft,
            dead = types.Actor.isDead(obj),
        }
    end
    mp.sendEvent('ActorSnapshot', { cellKey = cellKey, epoch = epoch, actors = snapActors })
end

-- --------------------------------------------------------------- non-holder puppets

local function attachActorPuppets(cellKey)
    for _, obj in ipairs(cellActors(cellKey)) do
        local key = refKeyOf(obj)
        if not puppetActors[key] then
            local ok = pcall(function()
                obj:addScript('scripts/mp/puppet.lua', { actorKey = key })
            end)
            if ok then puppetActors[key] = { obj = obj, cellKey = cellKey } end
        end
    end
end

local function detachActorPuppetsInCell(cellKey)
    for key, p in pairs(puppetActors) do
        if p.cellKey == cellKey and p.obj:isValid() then
            -- Only signal: the puppet re-enables AI and removes ITSELF (see puppet.lua's
            -- MP_Detach). Removing the script from here raced the queued event and left
            -- mDisableAI stuck on, freezing the cell's NPCs after every handoff.
            pcall(function() p.obj:sendEvent('MP_Detach', {}) end)
            puppetActors[key] = nil
        end
    end
end

local function resolveRefKey(key)
    -- puppet keys are "o:<obj.id>"; scan active actors for the match (cheap, cell-sized).
    local id = key:match('^o:(.+)$')
    if not id then return nil end
    for _, obj in ipairs(world.activeActors) do
        if obj.id == id then return obj end
    end
    return nil
end

-- --------------------------------------------------------------- appliers

actors.handlers = {}

actors.handlers.MP_ActorAuthorityGrant = function(data)
    local cellKey = data.cellKey
    if not cellKey then return end
    -- Becoming holder: detach any puppets we had on these actors, apply the snapshot, and
    -- the engine's own AI resumes (mDisableAI cleared by MP_Detach).
    detachActorPuppetsInCell(cellKey)
    holderOfCell[cellKey] = deps.ownIdFn()
    held[cellKey] = { epoch = data.epoch or 0, actors = {} }
    -- Apply the handoff snapshot: teleport actors to their last authoritative pose + stats.
    local snap = data.snapshot and data.snapshot.actors or {}
    for _, a in ipairs(snap) do
        local obj = a.ref and a.ref:isValid() and a.ref or nil
        if obj then
            local cellArg = obj.cell and not obj.cell.isExterior and obj.cell.name or ''
            pcall(function()
                obj:teleport(cellArg, util.vector3(a.x, a.y, a.z),
                    { rotation = util.transform.rotateZ(a.rotZ or 0) })
            end)
            pcall(function()
                local d = types.Actor.stats.dynamic
                if a.hp then d.health(obj).base = a.hp.b; d.health(obj).current = a.hp.c end
                if a.mp then d.magicka(obj).base = a.mp.b; d.magicka(obj).current = a.mp.c end
                if a.ft then d.fatigue(obj).base = a.ft.b; d.fatigue(obj).current = a.ft.c end
            end)
        end
    end
    print('[mp] actor authority GRANTED for ' .. cellKey .. ' epoch ' .. tostring(data.epoch))
end

actors.handlers.MP_ActorAuthorityRevoke = function(data)
    local cellKey = data.cellKey
    if not cellKey or not held[cellKey] then return end
    held[cellKey] = nil
    -- We are no longer the holder: re-attach puppets so the new holder drives these actors.
    attachActorPuppets(cellKey)
    print('[mp] actor authority REVOKED for ' .. cellKey)
end

actors.handlers.MP_ActorAuthorityInfo = function(data)
    if data.cellKey then
        holderOfCell[data.cellKey] = data.holderId
        -- M5 needs the LIVE epoch to address actor targets, and a non-holder only ever sees
        -- Info. Read it defensively: older servers omit it (combat on non-held cells is then
        -- undeliverable — see the M5 note in the report).
        if data.epoch then infoEpoch[data.cellKey] = data.epoch end
        -- A cell we're in already has a holder: puppet its actors.
        if data.holderId ~= deps.ownIdFn() then
            attachActorPuppets(data.cellKey)
        end
    end
end

-- ActorMoveBatch arrives decoded (like MP_MoveBatch) as an array of {ref,x,y,z,yaw,pitch,
-- flags,animVel}; route each to its ref-keyed puppet.
actors.handlers.MP_ActorMoveBatch = function(batch)
    local now = core.getRealTime()
    batchesIn = batchesIn + 1
    for _, e in ipairs(batch) do
        local obj = e.ref and e.ref:isValid() and e.ref or nil
        if obj and not types.Player.objectIsInstance(obj) then
            local key = refKeyOf(obj)
            if not puppetActors[key] then
                -- We got a pose for an actor we aren't puppeting yet (entered the cell after
                -- the holder): attach now.
                local ok = pcall(function()
                    obj:addScript('scripts/mp/puppet.lua', { actorKey = key })
                end)
                if ok then puppetActors[key] = { obj = obj, cellKey = cellKeyOf(obj.cell) } end
            end
            e.t = now
            pcall(function() obj:sendEvent('MP_Pose', e) end)
        end
    end
end

actors.handlers.MP_ActorStatsDynamic = function(data)
    local obj = data.ref and data.ref:isValid() and data.ref or nil
    if obj and puppetActors[refKeyOf(obj)] then
        pcall(function() obj:sendEvent('MP_Stats', { hp = data.hp, mp = data.mp, ft = data.ft }) end)
    end
end

-- Phase 3 public economy: this corpse must carry nothing. Sent by the server for unique
-- NPCs in a world that respawns them — killing a god stays a spectacle, it just is not a
-- payday, and without this an infinite-respawn world mints artifacts forever. Applied by
-- every client in the cell (an event, not a per-player view), so nobody can decline it.
actors.handlers.MP_ActorStripLoot = function(data)
    local obj = data.ref
    local okValid, valid = pcall(function() return obj:isValid() end)
    if not (okValid and valid) then return end
    pcall(function()
        for _, item in ipairs(types.Actor.inventory(obj):getAll()) do
            if item:isValid() then item:remove() end
        end
    end)
end

actors.handlers.MP_ActorDeath = function(data)
    local obj = data.ref and data.ref:isValid() and data.ref or nil
    if obj and puppetActors[refKeyOf(obj)] then
        pcall(function() obj:sendEvent('MP_Kill', {}) end)
    end
end

-- Server-authoritative kill tallies, re-asserted every mirror tick.
--
-- A single setDeadCount on arrival is NOT enough: a non-holder ALSO increments its own
-- engine death counter when its puppet dies, and that local bump can land after the
-- server's value, leaving the record permanently one too high (observed: holder=1,
-- non-holder=2). Since the shared tally is owned by the server, converging on it
-- continuously is both correct and idempotent — the holder's own count already agrees,
-- and any death the server hasn't counted yet arrives as a fresh WorldKillCount.
local authKills = {}

actors.handlers.MP_WorldKillCount = function(data)
    if data.refId and data.count then
        authKills[data.refId] = data.count
        mp.setDeadCount(data.refId, data.count)
        watchKillRecord = data.refId -- mirror this record's tally for the scenarios
    end
end

-- Test hook (holder side): damage a specific cell NPC to death so the death edge, the
-- ActorDeath relay and the shared kill tally can be asserted end to end.
function actors.killActorByRecord(recordId)
    watchKillRecord = recordId
    for _, obj in ipairs(cellActors(deps.ownCellKeyFn())) do
        if obj.recordId == recordId then
            -- Dynamic-stat writes are Self-gated: setting health from here silently fails
            -- (a pcall around it just hides the error). Attach a one-shot CUSTOM script to
            -- reach the actor's own Self context instead.
            local ok, err = pcall(function()
                obj:addScript('scripts/mp/testkill.lua', {})
            end)
            if not ok then print('[mp] killActorByRecord: addScript failed: ' .. tostring(err)) end
            return ok
        end
    end
    return false
end

-- Snap service for actor puppets that diverged (routed here from global.lua's mpSnapRequest).
function actors.snapActor(actorKey, pos)
    local obj = resolveRefKey(actorKey)
    if obj and obj:isValid() then
        local cellArg = obj.cell and not obj.cell.isExterior and obj.cell.name or ''
        pcall(function() obj:teleport(cellArg, util.vector3(pos.x, pos.y, pos.z)) end)
    end
end

function actors.isPuppetedActor(obj)
    return puppetActors[refKeyOf(obj)] ~= nil
end

-- M5: the live epoch for a cell — ours when we hold it, otherwise whatever the server told
-- us via ActorAuthorityInfo. nil means "no legal value to send" (the server would drop it).
function actors.epochOf(cellKey)
    local mine = held[cellKey]
    if mine then return mine.epoch end
    return infoEpoch[cellKey]
end

function actors.isHolderOf(cellKey)
    return cellKey ~= nil and held[cellKey] ~= nil
end

function actors.cellKeyOfObj(obj)
    return cellKeyOf(obj.cell)
end

-- --------------------------------------------------------------- tick

function actors.tick(now)
    -- Non-holder: keep trying to puppet our cell's actors. Attaching ONLY on
    -- MP_ActorAuthorityInfo loses the race — that event lands on our PlayerCellChange,
    -- while the cell's actors are still streaming in, so cellActors() is empty or partial
    -- and nothing gets attached. (Symptom: authority elected fine, actors visible on both
    -- clients, yet the non-holder's NPCs ran their own AI and drifted hundreds of units.)
    -- attachActorPuppets is per-key idempotent, so re-running it is cheap and also picks up
    -- actors that spawn or wander in later.
    if now - lastAttachSweep >= ATTACH_SWEEP_SECONDS then
        lastAttachSweep = now
        local ownCell = deps.ownCellKeyFn()
        local holder = ownCell and holderOfCell[ownCell]
        if ownCell and holder and holder ~= deps.ownIdFn() and not held[ownCell] then
            attachActorPuppets(ownCell)
        end
    end

    -- Holder broadcast loop.
    if now - lastBroadcast >= 1 / BROADCAST_HZ then
        lastBroadcast = now
        for cellKey, cell in pairs(held) do
            broadcastCell(cellKey, cell.epoch, cell, now)
        end
    end
    if now - lastSnapshot >= SNAPSHOT_SECONDS then
        lastSnapshot = now
        for cellKey, cell in pairs(held) do
            snapshotCell(cellKey, cell.epoch)
        end
    end

    if now - lastMirror >= 0.5 then
        lastMirror = now
        -- Re-assert server truth over any local engine death increments (see authKills).
        for refId, count in pairs(authKills) do
            if mp.getDeadCount(refId) ~= count then mp.setDeadCount(refId, count) end
        end
        local ownCell = deps.ownCellKeyFn()
        -- Ids arrive over LSER as doubles: format as integers so "1" never reads as "1.0".
        local holderId = holderOfCell[ownCell]
        mp.testSet('authorityHolder', holderId and string.format('%.0f', holderId) or 'none')
        mp.testSet('isHolder', tostring(held[ownCell] ~= nil))
        mp.testSet('actorCount', tostring(#cellActors(ownCell)))
        -- Diagnostic: unfiltered active-actor census (distinguishes "filter too strict" from
        -- "content ships no actors"; the clean Example Suite ships none).
        local raw, census = 0, {}
        for _, obj in ipairs(world.activeActors) do
            raw = raw + 1
            local tag = types.Player.objectIsInstance(obj) and 'player'
                or (deps.isMpPuppetFn(obj) and 'mppuppet' or 'npc')
            census[#census + 1] = tag .. '@' .. tostring(cellKeyOf(obj.cell))
        end
        mp.testSet('activeActorsRaw', tostring(raw))
        mp.testSet('actorCensus', json.encode(census))
        local puppeted = 0
        for _ in pairs(puppetActors) do puppeted = puppeted + 1 end
        mp.testSet('puppetedActors', tostring(puppeted))
        mp.testSet('actorBatchesIn', tostring(batchesIn))
        -- Deterministic cross-client actor probe: world.activeActors is in engine-internal
        -- order, which differs per client, so key by recordId and sort. Scenarios compare
        -- the SAME record on both clients.
        local probe = {}
        for _, obj in ipairs(cellActors(ownCell)) do
            local rec = obj.recordId
            if not probe[rec] then
                local p = obj.position
                probe[rec] = { x = p.x, y = p.y, z = p.z, dead = types.Actor.isDead(obj) }
            end
        end
        mp.testSet('actorProbe', json.encode(probe))
        if watchKillRecord then
            mp.testSet('killCountOf',
                watchKillRecord .. '=' .. string.format('%.0f', mp.getDeadCount(watchKillRecord)))
        end
    end
end

function actors.reset()
    -- Detach all puppets on session loss.
    for key, p in pairs(puppetActors) do
        if p.obj:isValid() then
            -- Send ONLY. Removing the script here destroys it before the queued MP_Detach is
            -- delivered (events land next frame, removeScript takes effect at once), so the
            -- puppet never runs the handler that re-enables AI — leaving mDisableAI set and
            -- every puppeted NPC frozen for good after a disconnect. The same trap is
            -- documented at the handoff site above; it just was not applied here. The puppet
            -- removes itself via mpPuppetDetached once AI is back on.
            pcall(function() p.obj:sendEvent('MP_Detach', {}) end)
        end
    end
    held = {}
    holderOfCell = {}
    infoEpoch = {}
    puppetActors = {}
end

function actors.init(d)
    deps = d
end

return actors
