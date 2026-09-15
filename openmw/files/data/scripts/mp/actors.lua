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
local threat = require('scripts.mp.threat')

local actors = {}

local SNAPSHOT_SECONDS = 5
-- How often a non-holder re-sweeps its cell for actors to puppet. Cheap (per-key
-- idempotent) and must keep running: cell actors stream in after the cell-change event.
local ATTACH_SWEEP_SECONDS = 1
local STATS_MIN_INTERVAL = 0.25
-- Equipment changes far less often than stats and costs more to apply (the puppet has to
-- create the items), so it is diffed on a slower beat.
local EQUIP_MIN_INTERVAL = 0.5

local deps = nil -- {playerFn, ownCellKeyFn, ownIdFn, isMpPuppetFn}

-- Per-cell authority we hold: cellKey -> epoch. We only ever hold our own current cell in
-- practice, but the server addresses by cellKey, so key by it.
local held = {} -- cellKey -> { epoch, actors = { refKey -> tracked } }
local holderOfCell = {} -- cellKey -> holderId (non-holder knowledge, from ActorAuthorityInfo)
local infoEpoch = {} -- cellKey -> epoch learned as a NON-holder (M5 actor targeting)
local puppetActors = {} -- refKey -> { obj, cellKey } (NPCs we puppet as a non-holder)

local lastSnapshot = 0
local lastMirror = 0
local lastAttachSweep = 0
local watchKillRecord = nil -- record whose shared kill tally the scenarios watch
local batchesIn = 0 -- diagnostic: ActorMoveBatch frames applied as a non-holder

-- --------------------------------------------------------------- ref helpers

local function refKeyOf(obj)
    -- local key, stable per session. Runtime-spawned actors (levelled lists, PlaceAt,
    -- summons) have no content RefNum: they are addressed on the wire by the net id the
    -- server gave them (actorAddr), and resolved back with actorOf.
    return 'o:' .. obj.id
end

-- WIRE ADDRESS of an actor: content ref, or the net id of a runtime-spawned one. nil for a
-- runtime actor the server has not named yet -- it must not travel until it can be resolved
-- on the other side.
local function actorAddr(obj)
    local netId = deps and deps.netIdOf and deps.netIdOf(obj)
    if netId then return { net = netId } end
    if obj.contentFile then return { ref = obj } end
    return nil
end

-- MAGIC THAT SHOWS ON AN NPC (#296). Everything else in an active effect is the holder's
-- business (the puppet's bars are a mirror); these change what an observer SEES or how the
-- streamed pose has to be read: an invisible guard fades, a paralysed one freezes, a
-- levitating one is not snapped to the floor. Keys are effect ids (core.magic.EFFECT_TYPE).
local ACTOR_VISIBLE_EFFECT = { invisibility = true, chameleon = true, light = true, levitate = true,
    slowfall = true, waterwalking = true, paralyze = true, sanctuary = true }
local function visibleActives(obj)
    local out = {} -- activeSpellId -> { id = record, effects = { zero-based indexes } }
    pcall(function()
        for _, sp in pairs(types.Actor.activeSpells(obj)) do
            if sp.temporary and not sp.fromEquipment and sp.activeSpellId ~= nil then
                local idx = {}
                for _, e in ipairs(sp.effects or {}) do
                    if e.index ~= nil and ACTOR_VISIBLE_EFFECT[e.id] then idx[#idx + 1] = e.index end
                end
                if #idx > 0 then out[sp.activeSpellId] = { id = sp.id, effects = idx } end
            end
        end
    end)
    return out
end

-- Fight/Flee/Alarm base values (#229): shared like disposition (a result script's ModFight
-- or a taunt writes them on ONE engine), so they ride ActorDisposition as `ai`.
local AI_SETTINGS = { 'fight', 'flee', 'alarm' }
function actors.aiSettings(obj)
    local out = {}
    local ok = pcall(function()
        for _, k in ipairs(AI_SETTINGS) do out[k] = types.Actor.stats.ai[k](obj).base end
    end)
    return ok and out or nil
end
local function aiFp(ai)
    return ai and (tostring(ai.fight) .. '/' .. tostring(ai.flee) .. '/' .. tostring(ai.alarm)) or ''
end

local function withAddr(body, obj)
    local a = actorAddr(obj)
    if not a then return nil end
    body.ref = a.ref
    body.net = a.net
    return body
end

-- The actor a relayed body names, here: a content ref, or our copy of a net actor.
local pendingDeaths = {} -- refKey -> true: recorded dead by the world, not yet a puppet here
local function actorOf(data)
    if data.net ~= nil and deps and deps.objOfNet then
        local obj = deps.objOfNet(data.net)
        if obj and obj:isValid() then return obj end
        return nil
    end
    local ref = data.ref
    local ok, valid = pcall(function() return ref and ref:isValid() end)
    return (ok and valid) and ref or nil
end

-- Runtime actors the holder has asked the server to name (netId pending).
local netPending = {}

local function cellKeyOf(cell)
    if not cell then return nil end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

-- Live NPCs/creatures bucketed by cell key, excluding the player and any MP puppets
-- (remote-player avatars we spawned — those are driven by player move frames, and
-- driving/broadcasting them as actors would double-drive them). ONE scan of activeActors:
-- the holder used to rescan every actor once per held cell per tick (#267).
local function actorsByCell()
    local out = {}
    for _, obj in ipairs(world.activeActors) do
        if obj:isValid()
            and not types.Player.objectIsInstance(obj)
            and not deps.isMpPuppetFn(obj) then
            local key = cellKeyOf(obj.cell)
            if key then
                local list = out[key]
                if not list then list = {}; out[key] = list end
                list[#list + 1] = obj
            end
        end
    end
    return out
end

local function cellActors(cellKey)
    return actorsByCell()[cellKey] or {}
end

-- --------------------------------------------------------------- holder mode

-- pcall targets, module-level: a closure per actor per tick was garbage at 20 Hz x N (#267).
local function speedsOf(obj) return types.Actor.getWalkSpeed(obj), types.Actor.getCurrentSpeed(obj) end
local function stanceOf(obj) return types.Actor.getStance(obj) end

local function actorPose(obj)
    local pos = obj.position
    local okV, walkSpeed, speed = pcall(speedsOf, obj)
    if not okV then walkSpeed, speed = 0, 0 end
    local animVel = walkSpeed > 0 and (speed / walkSpeed) or 0
    -- Coarse AI-package hint from motion (reading a foreign actor's AI package is not
    -- exposed to global scripts; motion is a good enough facing/anim hint for puppets).
    -- Bit 0 (run): types.Actor.isRunning does not exist, so the bit was never set and a running
    -- guard outpaced its walking puppet into a snap every cooldown (#286). Motion decides:
    -- faster than a walk is a run.
    local flags = 0
    if animVel > 1.05 then flags = flags + 1 end
    -- Posture (bits 4/5, the player pose's bits): an NPC fighting someone on the holder must
    -- look like it everywhere else -- weapon out, spell readied -- or a player takes damage
    -- from a body standing at ease. puppet.lua mirrors the stance; it still never swings.
    local okS, stance = pcall(stanceOf, obj)
    if okS then
        if stance == types.Actor.STANCE.Weapon then flags = flags + 16 end
        if stance == types.Actor.STANCE.Spell then flags = flags + 32 end
    end
    local netId = deps and deps.netIdOf and deps.netIdOf(obj)
    return {
        obj = (not netId) and obj or nil,
        net = netId,
        x = pos.x, y = pos.y, z = pos.z,
        yaw = obj.rotation:getYaw(),
        pitch = obj.rotation:getPitch(), -- flyers/swimmers level off without it (#291)
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

local function broadcastCell(cellKey, epoch, cell, now, live)
    local batch = {}
    -- THE WORLD'S RECORD OF THIS CELL, once it is loaded here. The holder used to simulate
    -- from a vanilla load: a door the players opened stayed shut for its pathing, a smuggler
    -- they killed stood up again after every restart. The grant asks once too, but the
    -- engine may not have the cell yet then; the first actor seen is the sure sign it does.
    if not cell.resynced and #live > 0 then
        cell.resynced = true
        mp.sendEvent('ResyncRequest', { cellKey = cellKey })
    end
    -- Phase 4: threat decays continuously, so a hit landed a minute ago stops owning the
    -- fight. Cheap: a multiply per tracked (actor, player) pair, and only for actors in
    -- the cell we are simulating.
    threat.decay(now)
    -- RUNTIME-SPAWNED ACTORS (levelled lists, PlaceAt, summons) exist on this engine only.
    -- Ask the server to name each one; it becomes a net object every client builds from the
    -- record (ObjectPlace with actor=true) and this stream addresses by net id. Until it is
    -- named nothing about it travels -- nobody could resolve it -- so it is left out below.
    local addressable = {}
    for _, obj in ipairs(live) do
        if obj.contentFile or (deps.netIdOf and deps.netIdOf(obj)) then
            addressable[#addressable + 1] = obj
        elseif not netPending[obj.id] and deps.requestNetActor
            -- CONTENT RECORDS ONLY. A levelled creature, a script spawn, a summon: all bodies
            -- built from a record everyone has. A "Generated:" record is a puppet or avatar
            -- body this engine minted -- seen here for one tick between despawnPuppet
            -- forgetting it and the engine removing it -- and naming it made every client
            -- try to build an actor from a record only this process knows.
            and not tostring(obj.recordId):lower():match('^generated:') then
            netPending[obj.id] = true
            deps.requestNetActor(obj, cellKey)
        end
    end
    live = addressable
    for _, obj in ipairs(live) do
        local key = refKeyOf(obj)
        cell.actors[key] = cell.actors[key] or { deathNo = 0 }
        local tracked = cell.actors[key]
        tracked.obj = obj
        tracked.seen = now
        tracked.netId = deps.netIdOf and deps.netIdOf(obj) or nil

        -- Sticky aggro: retarget only when a challenger clears the margin, which is what
        -- stops the enemy strobing between two players and hitting neither.
        local want = threat.targetOf(key)
        if want then
            local target = nil
            for _, p in ipairs(world.players) do
                if p:isValid() and deps.playerIdOfFn and deps.playerIdOfFn(p) == want then target = p end
            end
            if target then pcall(function() types.Actor.setStance(obj, types.Actor.STANCE.Weapon) end) end
        end

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
                    withAddr({ cellKey = cellKey, epoch = epoch, hp = dyn.hp, mp = dyn.mp, ft = dyn.ft }, obj))
            end
        end

        -- EQUIPMENT DIFF. ActorEquip has always been relayed by the server (holder-only,
        -- epoch-guarded, cell-scoped) and no client ever SENT one, so an NPC that drew a
        -- weapon, swapped armour or was disarmed looked different on every screen: whatever it
        -- happened to be wearing when that client first loaded the cell. Record ids travel, not
        -- objects -- a foreign object id means nothing here, which is the same reason the
        -- player equipment path sends ids.
        if not tracked.nextEquip or now >= tracked.nextEquip then
            local okEq, eq = pcall(function() return types.Actor.getEquipment(obj) end)
            if okEq and eq then
                local slots, parts = {}, {}
                for slot, item in pairs(eq) do
                    local okr, rid = pcall(function() return item.recordId end)
                    if okr and rid then
                        slots[slot] = rid
                        parts[#parts + 1] = tostring(slot) .. '=' .. rid
                    end
                end
                table.sort(parts)
                local fp = table.concat(parts, ',')
                if fp ~= tracked.equipFp then
                    tracked.equipFp = fp
                    tracked.nextEquip = now + EQUIP_MIN_INTERVAL
                    mp.sendEvent('ActorEquip',
                        withAddr({ cellKey = cellKey, epoch = epoch, slots = slots }, obj))
                end
            end
        end
        -- Visible magic, diffed by instance on the equipment beat (#296): an add per new
        -- instance, a remove per expiry/dispel. Record ids travel in wire form.
        if not tracked.nextFx or now >= tracked.nextFx then
            tracked.nextFx = now + EQUIP_MIN_INTERVAL
            local present = visibleActives(obj)
            local add, remove = {}, {}
            for aid, v in pairs(present) do
                if not (tracked.fx and tracked.fx[aid]) then add[#add + 1] = { id = deps.toNet(v.id), effects = v.effects } end
            end
            for aid, v in pairs(tracked.fx or {}) do
                if not present[aid] then remove[#remove + 1] = { id = deps.toNet(v.id) } end
            end
            tracked.fx = present
            if #add > 0 or #remove > 0 then
                mp.sendEvent('ActorEffects', withAddr({ cellKey = cellKey, epoch = epoch, add = add, remove = remove }, obj))
            end
        end

        -- DISPOSITION. Shared, not personal: getBaseDisposition(npc, player) ignores its player
        -- argument and reads one value off the NPC's stats, so persuading, bribing or
        -- threatening someone changes how they feel about EVERYONE. Left unsynced it was
        -- per-client, so a player could talk a guard down and their friend would still be
        -- attacked by the same guard. Same slow beat as equipment; it moves rarely.
        if not tracked.nextDisp or now >= tracked.nextDisp then
            local ownPlayer = world.players[1]
            if ownPlayer and ownPlayer:isValid() then
                local okD, disp = pcall(function()
                    return types.NPC.getBaseDisposition(obj, ownPlayer)
                end)
                local ai = actors.aiSettings(obj)
                local dispFp = tostring(disp) .. '|' .. aiFp(ai)
                if okD and type(disp) == 'number' and dispFp ~= tracked.dispVal then
                    tracked.dispVal = dispFp
                    tracked.nextDisp = now + EQUIP_MIN_INTERVAL
                    mp.sendEvent('ActorDisposition',
                        withAddr({ cellKey = cellKey, epoch = epoch, disposition = disp, ai = ai }, obj))
                end
            end
        end

        -- Death edge -> ActorDeath (killedRecordId is the tally key the server counts on).
        if dead and not tracked.dead then
            tracked.dead = true
            tracked.deathNo = (tracked.deathNo or 0) + 1
            mp.sendEvent('ActorDeath', {
                cellKey = cellKey,
                epoch = epoch,
                ref = actorAddr(obj) and actorAddr(obj).ref or nil,
                net = actorAddr(obj) and actorAddr(obj).net or nil,
                killerPlayerId = deps.ownIdFn(), -- holder attribution; nil-safe on the server
                deathNo = tracked.deathNo,
                killedRecordId = obj.recordId,
            })
            if deps.corpseFn then pcall(deps.corpseFn, obj) end -- #297: our copy is the loot
        elseif not dead then
            -- Revive edge (#293): a scripted Resurrect on the holder stands the actor up
            -- everywhere, and the server forgets the death so a cell entry stops re-killing it.
            if tracked.dead then
                mp.sendEvent('ActorRevive', withAddr({ cellKey = cellKey, epoch = epoch }, obj))
            end
            tracked.dead = false
        end
    end

    -- ACTORS THAT LEFT THIS CELL. Everything above describes actors we can still see; this
    -- is the one thing that has to be said about an actor we CANNOT. A follower who walks
    -- through a door -- or travels with you -- vanishes from `live`, so the pose stream simply
    -- stops and every other client is left with that NPC standing in the old cell forever.
    --
    -- Sent as its own event rather than by widening the pose batch: poses go out at 10 Hz and
    -- a cell change happens seconds or minutes apart, so paying for a cell key on every pose
    -- to carry a fact that almost never changes is the wrong trade.
    for key, tracked in pairs(cell.actors) do
        if tracked.seen ~= now then
            local obj = tracked.obj
            if obj and obj:isValid() then
                local toCell = cellKeyOf(obj.cell)
                -- toCell == cellKey would mean it is still here and we merely missed it this
                -- pass; only a real move is worth an event.
                if toCell and toCell ~= cellKey and tracked.leftTo ~= toCell then
                    tracked.leftTo = toCell
                    local pos = obj.position
                    local body = withAddr({
                        cellKey = cellKey, epoch = epoch, toCellKey = toCell,
                        x = pos.x, y = pos.y, z = pos.z,
                    }, obj)
                    if body then mp.sendEvent('ActorCellChange', body) end
                end
            else
                -- Gone entirely (unloaded or destroyed). Drop the row so a recycled key
                -- cannot inherit a stale leftTo and swallow a later, real move. A NAMED
                -- runtime actor that is gone here (a script's Disable/SetDelete, a summon
                -- expiring) is gone everywhere: every client holds a copy built from our word.
                if tracked.netId then
                    mp.sendEvent('ObjectDelete', { net = tracked.netId, cellKey = cellKey })
                end
                cell.actors[key] = nil
            end
        else
            tracked.leftTo = nil
        end
    end

    -- The wire count is a u8 (netmanager.cpp caps at 255): a bigger cell goes out as
    -- several batches or actor 256+ never moves (#271).
    for i = 1, #batch, 255 do
        mp.sendActorMoveBatch(epoch, { table.unpack(batch, i, math.min(i + 254, #batch)) })
    end
end

local function snapshotCell(cellKey, epoch)
    local snapActors = {}
    local ownPlayer = world.players[1]
    for _, obj in ipairs(cellActors(cellKey)) do
        local dyn = dynSnapshot(obj)
        local addr = actorAddr(obj)
        -- Disposition rides in the snapshot: persuaded, bribed or threatened is a fact about
        -- the NPC that a fresh holder (a restarted peer) must inherit, not re-roll from the record.
        local disp = nil
        if ownPlayer and ownPlayer:isValid() and types.NPC.objectIsInstance(obj) then
            pcall(function() disp = types.NPC.getBaseDisposition(obj, ownPlayer) end)
        end
        if addr then snapActors[#snapActors + 1] = {
            ref = addr.ref, net = addr.net,
            x = obj.position.x, y = obj.position.y, z = obj.position.z,
            rotZ = obj.rotation:getYaw(),
            hp = dyn.hp, mp = dyn.mp, ft = dyn.ft,
            dead = types.Actor.isDead(obj),
            disp = disp,
        } end
    end
    mp.sendEvent('ActorSnapshot', { cellKey = cellKey, epoch = epoch, actors = snapActors })
end

-- --------------------------------------------------------------- non-holder puppets

local function attachActorPuppets(cellKey)
    for _, obj in ipairs(cellActors(cellKey)) do
        local key = refKeyOf(obj)
        -- A stale row (the object it named was removed -- a named runtime actor deleted, a
        -- corpse disposed -- and the engine reused the slot) must not block the new actor.
        local have = puppetActors[key]
        if have then
            local okv, same = pcall(function() return have.obj:isValid() and have.obj.id == obj.id end)
            if not (okv and same) then have = nil end
        end
        if not have then
            local ok = pcall(function()
                obj:addScript('scripts/mp/puppet.lua', { actorKey = key })
            end)
            if ok then
                puppetActors[key] = { obj = obj, cellKey = cellKey }
                -- Died before we got here: the world says so; the body must agree.
                if pendingDeaths[key] then
                    pendingDeaths[key] = nil
                    pcall(function() obj:sendEvent('MP_Kill', {}) end)
                end
            end
        end
    end
end

-- `degraded`: the peer is gone (holder lost), not a departure -- the puppet keeps its script
-- and hit intercept so outage swings cancel (backlog 328, puppet.lua MP_Detach).
local function detachActorPuppetsInCell(cellKey, degraded)
    for key, p in pairs(puppetActors) do
        if p.cellKey == cellKey and p.obj:isValid() then
            -- Only signal: the puppet re-enables AI and removes ITSELF (see puppet.lua's
            -- MP_Detach). Removing the script from here raced the queued event and left
            -- mDisableAI stuck on, freezing the cell's NPCs on every peer restart.
            pcall(function() p.obj:sendEvent('MP_Detach', { degraded = degraded == true }) end)
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
    -- ONLY THE SIM PEER IS EVER GRANTED (server authority.ts: canSimulate = system only), so
    -- this and Revoke below run on the peer alone; a browser client only ever sees Info.
    -- There is no human holder and no handoff between clients -- the "previous holder" a
    -- snapshot comes from is this same peer's earlier life, or the cell doc.
    -- Inherit the outgoing holder's threat state: without it every fight in the cell
    -- visibly forgets who it was angry at the moment authority moves.
    if data.snapshot and data.snapshot.threat then threat.import(data.snapshot.threat) end
    -- Becoming holder: detach any puppets we had on these actors, apply the snapshot, and
    -- the engine's own AI resumes (mDisableAI cleared by MP_Detach).
    detachActorPuppetsInCell(cellKey)
    holderOfCell[cellKey] = deps.ownIdFn()
    held[cellKey] = { epoch = data.epoch or 0, actors = {} }
    mp.sendEvent('ResyncRequest', { cellKey = cellKey }) -- doors, locks, the dead (see broadcastCell)
    -- Apply the handoff snapshot: teleport actors to their last authoritative pose + stats.
    local snap = data.snapshot and data.snapshot.actors or {}
    for _, a in ipairs(snap) do
        -- A dead entry stays where the death left it: teleport + hp 0 here re-killed every
        -- respawned guard at each re-anchor. WorldCellState -> noteCellDeaths re-asserts a
        -- death that still stands (#287).
        local obj = (not a.dead) and actorOf(a) or nil
        if obj then
            local cellArg = obj.cell and not obj.cell.isExterior and obj.cell.name or ''
            pcall(function()
                obj:teleport(cellArg, util.vector3(a.x, a.y, a.z),
                    { rotation = util.transform.rotateZ(a.rotZ or 0) })
            end)
            -- Self-gated write: the actor's own script (companion.lua mpSetStats) applies it.
            pcall(function() obj:sendEvent('mpSetStats', { hp = a.hp, mp = a.mp, ft = a.ft }) end)
            if type(a.disp) == 'number' then
                local ownPlayer = world.players[1]
                if ownPlayer and ownPlayer:isValid() then
                    pcall(function() types.NPC.setBaseDisposition(obj, ownPlayer, a.disp) end)
                end
            end
        end
    end
    print('[mp] actor authority GRANTED for ' .. cellKey .. ' epoch ' .. tostring(data.epoch))
end

actors.handlers.MP_ActorAuthorityRevoke = function(data)
    local cellKey = data.cellKey
    if not cellKey or not held[cellKey] then return end
    held[cellKey] = nil
    -- The peer walked its avatar out of a cell it still occupies via another anchor; the
    -- server re-grants at once (there is nobody else to hand it to). Attach in the gap.
    attachActorPuppets(cellKey)
    print('[mp] actor authority REVOKED for ' .. cellKey)
end

actors.handlers.MP_ActorAuthorityInfo = function(data)
    if data.cellKey then
        -- HOLDER LOST (peer gone): the server sends this with no holderId. Clear the mirror
        -- and DETACH this cell's actor puppets so their AI re-enables and the client
        -- simulates them locally (degraded mode). Detach is correct here -- this is loss,
        -- not a handoff to another holder -- and local AI is the only fallback with no peer.
        -- LOSING IT ANYWHERE IS LOSING IT EVERYWHERE (#295). The peer is the only holder, so
        -- a lost holder means the peer is gone, and the puppets it drove in the neighbouring
        -- cells (attached off ActorMoveBatch, never Info'd, so absent from the mirror) are
        -- frozen too. Clear the whole mirror and detach every puppet; a live holder
        -- re-attaches them on its next pose, which is the path a late attach already takes.
        if data.holderId == nil then
            -- Every cell, degraded (#328): the puppets keep their script armed so an outage
            -- swing still cancels; the whole mirror clears (#295).
            for key in pairs(held) do detachActorPuppetsInCell(key, true) end
            for key, p in pairs(puppetActors) do
                if p.obj:isValid() then pcall(function() p.obj:sendEvent('MP_Detach', { degraded = true }) end) end
                puppetActors[key] = nil
            end
            held = {}
            holderOfCell = {}
            infoEpoch = {}
            return
        end
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
        local obj = actorOf(e)
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

-- The holder says an actor has LEFT the cell it was being simulated in. Without this the
-- puppet stands where the pose stream stopped -- which is what left a travelling companion
-- behind for everyone except the player who recruited them.
actors.handlers.MP_ActorCellChange = function(data)
    local obj = actorOf(data)
    if not obj or type(data.toCellKey) ~= 'string' then return end
    local key = refKeyOf(obj)
    -- DETACH FIRST. The puppet script suppresses this actor's own AI, and it is keyed to the
    -- cell it was puppeted in; carrying it across would leave an actor frozen in a cell whose
    -- holder has never heard of it. The destination cell's holder re-attaches on its next
    -- pose, which is the same path an actor entering a cell already takes.
    local p = puppetActors[key]
    if p then
        pcall(function() p.obj:sendEvent('MP_Detach', {}) end)
        puppetActors[key] = nil
    end
    -- AN EXTERIOR KEY IS NOT A CELL NAME. teleport() takes a cell NAME (interiors) or '' for
    -- the exterior, where the position picks the grid square; "x,y" is our own key and the
    -- engine looked it up as a name, failed inside the pcall, and the actor never arrived --
    -- so every NPC that walked outdoors kept standing indoors on every other screen.
    local cellArg = data.toCellKey:match('^%-?%d+,%-?%d+$') and '' or data.toCellKey
    pcall(function()
        obj:teleport(cellArg, util.vector3(data.x or 0, data.y or 0, data.z or 0))
    end)
end

actors.handlers.MP_ActorStatsDynamic = function(data)
    local obj = actorOf(data)
    if obj and puppetActors[refKeyOf(obj)] then
        pcall(function() obj:sendEvent('MP_Stats', { hp = data.hp, mp = data.mp, ft = data.ft }) end)
    end
end

-- The holder says what magic SHOWS on this actor (#296). Applied in place: activeSpells:add is
-- a global-context call for a foreign actor, and the puppet's own engine expires a timed
-- effect on the same clock; a remove after that is a no-op. Same shape as the avatar path
-- (global.lua MP_AvatarActiveSpells): stackable per instance, resistances already rolled.
actors.handlers.MP_ActorEffects = function(data)
    local obj = actorOf(data)
    if not obj or not puppetActors[refKeyOf(obj)] then return end
    local spells = types.Actor.activeSpells(obj)
    for _, sp in ipairs(data.add or {}) do
        local localId = sp.id and deps.toLocal(sp.id)
        if localId and type(sp.effects) == 'table' and #sp.effects > 0 then
            pcall(function()
                spells:add({ id = localId, effects = sp.effects, caster = obj, stackable = true,
                    ignoreResistances = true, ignoreSpellAbsorption = true, ignoreReflect = true, quiet = true })
            end)
        end
    end
    for _, sp in ipairs(data.remove or {}) do
        local localId = sp.id and deps.toLocal(sp.id)
        if localId then
            pcall(function()
                for _, active in pairs(spells) do
                    if active.temporary and active.id == localId and active.activeSpellId then
                        spells:remove(active.activeSpellId)
                        break
                    end
                end
            end)
        end
    end
end

-- The holder says what this actor is wearing. Handed to the puppet script, which already knows
-- how to turn record ids into equipped objects and retry until the items exist (puppet.lua
-- MP_Equip / pendingEquip) -- the same path a remote PLAYER's equipment takes.
-- The holder says how this NPC now feels. Applied directly rather than through the puppet:
-- disposition lives on the actor's own stats, and setBaseDisposition is a GLOBAL-context call
-- (local scripts may only modify themselves), which is the context this handler runs in.
actors.handlers.MP_ActorDisposition = function(data)
    local obj = actorOf(data)
    if not obj or type(data.disposition) ~= 'number' then return end
    local ownPlayer = world.players[1]
    if not (ownPlayer and ownPlayer:isValid()) then return end
    pcall(function() types.NPC.setBaseDisposition(obj, ownPlayer, data.disposition) end)
    if type(data.ai) == 'table' then
        for _, k in ipairs(AI_SETTINGS) do
            local v = tonumber(data.ai[k])
            if v then pcall(function() types.Actor.stats.ai[k](obj).base = math.floor(v) end) end
        end
    end
end

-- COMPANIONS, the sending half. Called from global.lua when an actor's OWN script reports a
-- change in who it follows -- which is how the fact gets here at all, because a global script
-- cannot read AI package state for a foreign actor. ActorAI has been relayed by the server
-- since M4 and no client ever sent one; this is that gap closed.
--
-- Holder-only, like every other actor fact: two clients both announcing the same follower
-- would fight over it, and the holder is the one whose simulation is authoritative anyway.
local claimedFollow = {} -- refKey -> true: actors we told the server follow US while not holding

function actors.noteFollow(obj, target, escort)
    if not (obj and obj:isValid()) then return end
    local cellKey = actors.cellKeyOfObj(obj)
    if not cellKey then return end
    -- nil target is a real value here: it means 'stopped following', which has to travel or a
    -- dismissed companion keeps trailing everyone else forever.
    local followId = deps.playerIdOf and deps.playerIdOf(target) or nil
    local epoch = actors.epochOf(cellKey)
    if not actors.isHolderOf(cellKey) then
        -- RECRUITING IS A DIALOGUE ACTION, and dialogue runs on the recruiting player's own
        -- client -- which, on a peer-simulated world, is never the holder. Holder-only here
        -- meant the fact was born on a non-holder and thrown away, so no companion ever
        -- followed anyone on any screen. A non-holder may still say exactly one thing about an
        -- actor: "this one now follows ME" (or stopped). The server holds it to that
        -- (worldstate.ts followClaim) and relays it to the holder, who starts the package.
        local key = refKeyOf(obj)
        local own = deps.ownIdFn and deps.ownIdFn() or nil
        if followId ~= nil and followId ~= own then
            pcall(function() mp.set('followClaim', 'not-mine:' .. tostring(followId) .. '/' .. tostring(own)) end)
            return
        end
        if followId == nil and not claimedFollow[key] then return end
        claimedFollow[key] = (followId ~= nil) or nil
        epoch = epoch or 0 -- a claim is not epoch-checked; the field only has to be present
    end
    local body = withAddr({
        cellKey = cellKey, epoch = epoch, follow = followId,
        escort = (followId ~= nil and type(escort) == 'table') and escort or nil,
    }, obj)
    -- Scenario mirror (s114): what went out, or why nothing did.
    pcall(function() mp.set('followClaim', body and ('sent:' .. tostring(followId)) or 'no-addr') end)
    if body then mp.sendEvent('ActorAI', body) end
end

-- PERSUASION, the sending half. Called by quests.lua when a conversation ends and the NPC's
-- disposition is not what it was when it began. The server admits it from the player who
-- held that NPC's dialogue lock (worldstate.ts), so this is sent BEFORE the lock is released.
function actors.noteDisposition(obj, disposition, ai)
    if not (obj and obj:isValid()) or type(disposition) ~= 'number' then return end
    local cellKey = actors.cellKeyOfObj(obj)
    if not cellKey then return end
    local body = withAddr({
        cellKey = cellKey, epoch = actors.epochOf(cellKey) or 0,
        disposition = math.max(0, math.min(100, math.floor(disposition + 0.5))),
        ai = ai, -- #229: Fight/Flee/Alarm the conversation changed (nil = unchanged)
    }, obj)
    if body then mp.sendEvent('ActorDisposition', body) end
end

-- COMBAT STATE, the sending half. Holder-only (the holder is where the fight is real): who
-- this actor is fighting, when that is a player. Rides ActorAI with a `combat` field so the
-- client's AI-off puppet can be put into the same state and vanilla's own checks -- rest
-- refused while an enemy is on you, no greeting from someone swinging at you -- read true.
-- refKey -> true while the actor's own script last reported a Combat package with a live
-- target (any target, not only a player). Global context cannot read an actor's AI stack,
-- so this is the only "is it fighting" the follow-teleport (global.lua) can ask.
local inCombat = {}

function actors.inCombat(obj)
    return inCombat[refKeyOf(obj)] == true
end

function actors.noteCombat(obj, target)
    if not (obj and obj:isValid()) then return end
    inCombat[refKeyOf(obj)] = (target ~= nil) or nil
    local cellKey = actors.cellKeyOfObj(obj)
    if not cellKey then return end
    local foeId = deps.playerIdOf and deps.playerIdOf(target) or nil
    if not actors.isHolderOf(cellKey) then
        -- Not ours to say -- except "it now fights ME", the result of a taunt or of resisting
        -- arrest, which happens on this client and nowhere else. The server admits it from the
        -- player who was just talking to the NPC (worldstate.ts), and the holder starts the fight.
        local own = deps.ownIdFn and deps.ownIdFn() or nil
        if foeId == nil or foeId ~= own then return end
    end
    local body = withAddr({
        cellKey = cellKey, epoch = actors.epochOf(cellKey) or 0, combat = foeId or false,
    }, obj)
    if body then mp.sendEvent('ActorAI', body) end
end

-- SCRIPTED TRAVEL. "AITravel x y z" from a dialogue result stacks Travel on the talking
-- player's puppet; the holder's copy never moves. The holder reports its own travel too (it
-- is authoritative), a non-holder only right after talking to the NPC (worldstate.ts admits
-- it from the dialogue-lock holder) -- and on an AI-off puppet the only way the active package
-- changes IS a script, so there is nothing else this could be.
function actors.noteTravel(obj, dest)
    if not (obj and obj:isValid()) or type(dest) ~= 'table' or type(dest.x) ~= 'number' then return end
    local cellKey = actors.cellKeyOfObj(obj)
    if not cellKey then return end
    local body = withAddr({
        cellKey = cellKey, epoch = actors.epochOf(cellKey) or 0,
        travel = { x = dest.x, y = dest.y or 0, z = dest.z or 0 },
    }, obj)
    if body then mp.sendEvent('ActorAI', body) end
end

-- SCRIPTED TELEPORT (backlog 216). "PositionCell" from a player-gated script (GetDistance
-- Player, OnActivate, a dialogue result) moved an AI-off puppet on this client; the holder's
-- real actor never moved -- Dagoth Ur stayed out of the Heart chamber on the peer, Mehra never
-- reached the Ghostgate for the guest. The engine notes the move (mwmp/puppets.hpp) under the
-- cell the actor is LEAVING, the one somebody holds; the holder teleports the real one. The
-- holder itself says nothing: its move is the authoritative one and streams out as a pose.
function actors.notePosition(obj, cellName, pos)
    if not (obj and obj:isValid()) or type(pos) ~= 'table' or type(pos.x) ~= 'number' then return end
    local cellKey = type(pos.cellKey) == 'string' and pos.cellKey ~= '' and pos.cellKey or actors.cellKeyOfObj(obj)
    if not cellKey or actors.isHolderOf(cellKey) then return end
    local body = withAddr({
        cellKey = cellKey, epoch = actors.epochOf(cellKey) or 0,
        position = { cell = tostring(cellName or ''), x = pos.x, y = pos.y or 0, z = pos.z or 0 },
    }, obj)
    if body then mp.sendEvent('ActorAI', body) end
end

local function aimAt(obj, target, escort)
    if type(escort) == 'table' and type(escort.x) == 'number' then
        pcall(function()
            obj:sendEvent('StartAIPackage', { type = 'Escort', target = target,
                destPosition = util.vector3(escort.x, escort.y or 0, escort.z or 0),
                duration = escort.duration or 0 })
        end)
    else
        pcall(function() obj:sendEvent('StartAIPackage', { type = 'Follow', target = target }) end)
    end
end

-- ...and the receiving half. The target is resolved LOCALLY: the player who recruited them
-- gets their own avatar, everyone else gets the puppet standing in for that person. Applied
-- by sending the actor a StartAIPackage event, because AI packages can only be started from
-- the actor's own local script -- the same asymmetry that made this a client gap.
-- playerId -> { refKey -> actor }. Companions of each player, as told by MP_ActorAI. The
-- engine carries a follower through a door only when it follows a PLAYER; on the peer the
-- target is an avatar (an NPC), so the follower would stop at the door and the player would
-- walk on alone. global.lua's MP_PlayerCellChange moves these along with the avatar.
local followersOf = {}

function actors.followersOf(playerId)
    return followersOf[playerId] or {}
end

-- The avatar body is REPLACED on a resurrect or an appearance change, and removed when the
-- player leaves; a Follow package aimed at the old object never finishes and the follower
-- stands still for good. Re-aim it at the new body, or release it when there is none.
function actors.refollow(playerId, target)
    for _, f in pairs(followersOf[playerId] or {}) do
        local obj = f.obj
        if obj:isValid() then
            if target then
                aimAt(obj, target, f.escort)
            else
                pcall(function() obj:sendEvent('RemoveAIPackages', 'Follow') end)
                pcall(function() obj:sendEvent('RemoveAIPackages', 'Escort') end)
            end
        end
    end
end

function actors.forgetFollowers(playerId)
    followersOf[playerId] = nil
end

actors.handlers.MP_ActorAI = function(data)
    local obj = actorOf(data)
    if not obj then return end
    if type(data.position) == 'table' and type(data.position.x) == 'number' then
        -- A scripted teleport from a non-holder (notePosition); the server sends it to the
        -- holder only. An empty cell name is the default exterior, resolved from x,y.
        local p = data.position
        pcall(function() obj:teleport(tostring(p.cell or ''), util.vector3(p.x, p.y or 0, p.z or 0)) end)
        return
    end
    if type(data.travel) == 'table' and type(data.travel.x) == 'number' then
        -- A scripted destination. On a puppet (AI off) it is state only; on the holder the
        -- actor walks there, which is the point.
        pcall(function()
            obj:sendEvent('StartAIPackage', { type = 'Travel',
                destPosition = util.vector3(data.travel.x, data.travel.y or 0, data.travel.z or 0) })
        end)
        return
    end
    if data.combat ~= nil then
        -- The holder says this actor is (or stopped) fighting a player. Stacked on the puppet
        -- with its AI off it never executes; it only makes the state readable. On MP_Detach
        -- the AI resumes with the fight it was actually in, which is right.
        local foe = data.combat and deps.playerObjOf and deps.playerObjOf(data.combat) or nil
        if foe then
            pcall(function() obj:sendEvent('StartAIPackage', { type = 'Combat', target = foe }) end)
            -- The provoking shout (#227): AiCombat rolls iVoiceAttackOdds per swing on the
            -- holder, whose engine is headless; rolled once here, at the fight's start.
            if puppetActors[refKeyOf(obj)] and mp.say then
                pcall(function()
                    if math.random(0, 99) < (tonumber(core.getGMST('iVoiceAttackOdds')) or 0) then mp.say(obj, 'attack') end
                end)
            end
        else
            pcall(function() obj:sendEvent('RemoveAIPackages', 'Combat') end)
        end
        return
    end
    local key = refKeyOf(obj)
    for _, list in pairs(followersOf) do list[key] = nil end
    if data.follow ~= nil then
        followersOf[data.follow] = followersOf[data.follow] or {}
        followersOf[data.follow][key] = { obj = obj, escort = data.escort }
    end
    local target = deps.playerObjOf and deps.playerObjOf(data.follow) or nil
    if mp.isSystem and mp.isSystem() then
        print(string.format('[mp] follow claim: %s -> player %s target=%s holder=%s', tostring(obj.recordId),
            tostring(data.follow), target and 'yes' or 'NO', tostring(actors.isHolderOf(actors.cellKeyOfObj(obj)))))
    end
    if target then
        aimAt(obj, target, data.escort)
    else
        -- Only Follow is removed, never the whole stack: clearing everything would also cancel
        -- the combat and wander packages that make the actor an actor.
        pcall(function() obj:sendEvent('RemoveAIPackages', 'Follow') end)
        pcall(function() obj:sendEvent('RemoveAIPackages', 'Escort') end)
    end
end

actors.handlers.MP_ActorEquip = function(data)
    local obj = actorOf(data)
    if obj and puppetActors[refKeyOf(obj)] then
        pcall(function() obj:sendEvent('MP_Equip', { slots = data.slots or {} }) end)
    end
end

-- Phase 3 public economy: this corpse must carry nothing. Sent by the server for unique
-- NPCs in a world that respawns them — killing a god stays a spectacle, it just is not a
-- payday, and without this an infinite-respawn world mints artifacts forever. Applied by
-- every client in the cell (an event, not a per-player view), so nobody can decline it.
actors.handlers.MP_ActorStripLoot = function(data)
    local obj = actorOf(data)
    if not obj then return end
    pcall(function()
        for _, item in ipairs(types.Actor.inventory(obj):getAll()) do
            if item:isValid() then item:remove() end
        end
    end)
end

actors.handlers.MP_ActorDeath = function(data)
    local obj = actorOf(data)
    if obj and puppetActors[refKeyOf(obj)] then
        pcall(function() obj:sendEvent('MP_Kill', {}) end)
    end
    -- The one we were talking to (quests.lua closes the window, backlog 228).
    if obj and deps.actorDeathFn then pcall(deps.actorDeathFn, obj) end
end

-- The inverse of ActorDeath (#293): the holder's copy came back to life (scripted
-- Resurrect). mp.resurrect(obj) is the engine's own revive; the puppet drops its dead latch.
actors.handlers.MP_ActorRevive = function(data)
    local obj = actorOf(data)
    if not obj then return end
    pcall(mp.resurrect, obj)
    if puppetActors[refKeyOf(obj)] then pcall(function() obj:sendEvent('MP_Revive', {}) end) end
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
-- WorldCellState names every actor recorded dead in this cell. A puppet already here dies
-- now; one puppeted later dies on registration (above). Keyed by refKey, like the relay.
-- In a cell we HOLD the body dies for real (the peer loads vanilla after a restart).
-- The wire names an actor "c:<index>:<contentFile>" or "n:<netId>" (proto/ref.ts); the
-- puppet table is keyed by the local object id (refKeyOf). Resolve first -- looked up raw,
-- the wire key matched nothing and every recorded death was a no-op.
local function objOfWireKey(key)
    local netId = key:match('^n:(%d+)$')
    if netId then return deps.objOfNet and deps.objOfNet(tonumber(netId)) end
    local index, cf = key:match('^c:(%d+):(%d+)$')
    if not index then return nil end
    local contentName = core.contentFiles.list[tonumber(cf) + 1]
    if not contentName then return nil end
    local ok, obj = pcall(function() return world.getObjectByFormId(core.getFormId(contentName, tonumber(index))) end)
    return ok and obj or nil
end

function actors.noteCellDeaths(cellKey, keys)
    for _, wireKey in ipairs(keys or {}) do
        local obj = objOfWireKey(wireKey)
        local okv, valid = pcall(function() return obj and obj:isValid() end)
        if not (okv and valid) then
            -- Not loaded here yet: nothing to key on. The next WorldCellState for the cell
            -- (sent on every entry) says it again once the object exists.
        else
            local key = refKeyOf(obj)
            if held[cellKey] then
                -- We simulate this cell: the body dies for real, in its own Self context
                -- (dynamic stats are Self-gated; testkill.lua is exactly that one write).
                if not types.Actor.isDead(obj) then pcall(function() obj:addScript('scripts/mp/testkill.lua', {}) end) end
            elseif puppetActors[key] then
                pcall(function() obj:sendEvent('MP_Kill', {}) end)
            else
                pendingDeaths[key] = true
            end
        end
    end
end

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

-- Backlog 142: disposition and equipment go out on change only, so a player entering a
-- cell we hold never heard the persuasion that happened before they arrived (and their
-- next persuasion overwrote it). Forget the last-sent values for that cell; the next tick
-- re-sends every actor's current state to the room.
function actors.catchUpCell(cellKey)
    local cell = cellKey and held[cellKey]
    if not cell then return end
    for _, tracked in pairs(cell.actors) do
        tracked.dispVal, tracked.equipFp = nil, nil
    end
end

-- Phase 4C: does ANYONE simulate this cell right now (the peer, in the one-peer model)?
-- Distinct from isHolderOf ("do I"). combat.lua asks this to decide whether a real melee
-- hit is forwarded (nobody simulating: degraded relay) or left to the avatar's own swing.
-- Does ANY cell we know of have a simulator? The first ActorAuthorityInfo of a session says
-- "this world is peer-simulated"; used to keep local runtime spawns off from then on.
function actors.anyHolder()
    return next(held) ~= nil or next(holderOfCell) ~= nil
end

function actors.hasHolder(cellKey)
    return cellKey ~= nil and (held[cellKey] ~= nil or holderOfCell[cellKey] ~= nil)
end

function actors.cellKeyOfObj(obj)
    return cellKeyOf(obj.cell)
end

-- The cells this process holds, resolved (objects.lua polls their doors, #289).
function actors.heldCells()
    local out = {}
    for key in pairs(held) do
        local x, y = key:match('^(-?%d+),(-?%d+)$')
        local ok, c
        if x then ok, c = pcall(world.getExteriorCell, tonumber(x), tonumber(y))
        else ok, c = pcall(world.getCellByName, key) end
        if ok and c then out[#out + 1] = c end
    end
    return out
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

    -- Holder broadcast loop: EVERY frame. The rate is set by the peer's own framerate cap
    -- (settings.cfg, written by the server), which is the only thing that should decide it.
    --
    -- There used to be a BROADCAST_HZ gate here, and it was a rate LIMITER for a 60fps browser
    -- client holding a cell. No client can hold a cell any more — only the sim peer — so the
    -- gate had nothing left to limit, and it actively hurt: a 66.7ms threshold checked on the
    -- peer's 50ms frames only cleared every SECOND frame, so a "15 Hz" stream was really 10 Hz,
    -- and the interpolator's 100ms render delay had no jitter margin left at that spacing.
    -- One knob, on the server, instead of two that alias against each other.
    local byCell = next(held) and actorsByCell() or nil
    for cellKey, cell in pairs(held) do
        broadcastCell(cellKey, cell.epoch, cell, now, byCell[cellKey] or {})
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
        mp.set('authorityHolder', holderId and string.format('%.0f', holderId) or 'none')
        mp.set('isHolder', tostring(held[ownCell] ~= nil))
        mp.set('actorCount', tostring(#cellActors(ownCell)))
        -- Diagnostic: unfiltered active-actor census (distinguishes "filter too strict" from
        -- "content ships no actors"; the clean Example Suite ships none).
        local raw, census = 0, {}
        for _, obj in ipairs(world.activeActors) do
            raw = raw + 1
            local tag = types.Player.objectIsInstance(obj) and 'player'
                or (deps.isMpPuppetFn(obj) and 'mppuppet' or 'npc')
            census[#census + 1] = tag .. '@' .. tostring(cellKeyOf(obj.cell))
        end
        mp.set('activeActorsRaw', tostring(raw))
        mp.set('actorCensus', json.encode(census))
        local puppeted = 0
        for _ in pairs(puppetActors) do puppeted = puppeted + 1 end
        mp.set('puppetedActors', tostring(puppeted))
        mp.set('actorBatchesIn', tostring(batchesIn))
        -- Deterministic cross-client actor probe: world.activeActors is in engine-internal
        -- order, which differs per client, so key by recordId and sort. Scenarios compare
        -- the SAME record on both clients.
        local probe = {}
        for _, obj in ipairs(cellActors(ownCell)) do
            local rec = obj.recordId
            if not probe[rec] then
                local p = obj.position
                -- `guard` so a scenario can find the actor that is supposed to REACT to a
                -- bounty. Class is not otherwise visible from the harness, and "walks toward
                -- you when you are wanted" is only meaningful about a guard.
                local isGuard = false
                pcall(function() isGuard = types.NPC.record(obj).class == 'guard' end)
                -- hp is the HOLDER's view once mirrored (MP_Stats): a corpse the simulator
                -- reloaded alive reads dead here with hp climbing back up (s157).
                local hp = -1
                pcall(function() hp = types.Actor.stats.dynamic.health(obj).current end)
                probe[rec] = { x = p.x, y = p.y, z = p.z, dead = types.Actor.isDead(obj),
                    guard = isGuard, hp = hp }
            end
        end
        mp.set('actorProbe', json.encode(probe))
        if watchKillRecord then
            mp.set('killCountOf',
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
