-- M3 shared-world object sync hub (GLOBAL context; wired from scripts/mp/global.lua).
-- See server/PROTOCOL.md §M3. Addressing is a tagged union: {ref=<GameObject>} for
-- content-file objects (the GObject userdata serializes as the 8-byte RefNum via the
-- engine serializer and comes back as a resolvable GObject) or {net=<server netId>} for
-- runtime-spawned objects. Client-generated RefNums of spawned objects NEVER travel.
--
-- Own-echo rule: the server relays cell-scoped INCLUDING the sender, with `byId` — every
-- applier skips bodies whose byId is our own playerId. For our own ObjectPlace echo we
-- additionally KEEP the locally-dropped object and just map netId->it (no despawn/respawn
-- flicker); the mapping is set by ObjectSpawnAck before the Place echo can arrive (FIFO).
local core = require('openmw.core')
local types = require('openmw.types')
local util = require('openmw.util')
local world = require('openmw.world')
local mp = require('openmw.mp')

local json = require('scripts.mp.json')

local objects = {}

-- injected by global.lua at init: { playerFn, ownCellKeyFn, ownIdFn, placeholderItemFn, noticeFn }
local deps = nil

local DROP_DETECT_RANGE = 600 -- only the dropper relays (someone must own the spawn)
local CONTAINER_WATCH_SECONDS = 15 -- native container UI has no close signal; poll window
local CONTAINER_POLL = 0.25
local LOCK_WATCH_SECONDS = 4
local DOOR_READ_DELAY = 0.4 -- door starts turning on activation; read the resulting state
local ECHO_GUARD_SECONDS = 5

local netToObj = {} -- netId -> GameObject
local objIdToNet = {} -- obj.id (string) -> netId
local netSpawned = {} -- obj.id -> true (objects created FROM the network or net-acked)
local pendingSpawns = {} -- tempId -> GameObject (local drop awaiting ObjectSpawnAck)
local tempCounter = 0
local opCounter = 0
local pendingOps = {} -- opId -> {op=, itemId=, n=, key=, obj=}
local recentPickups = {} -- obj.id -> time (belt+braces beside the byId echo skip)
local doorPending = {} -- obj.id -> {obj=, at=}
local lockWatch = {} -- obj.id -> {obj=, locked=, level=, until_=}
local containerWatch = {} -- obj.id -> {obj=, last={id->n}, nextPoll=, until_=}
local containerData = {} -- refKey -> {items={id->n}, seq=number} (server truth mirror)
local lastMirror = 0

-- ---------------------------------------------------------------- addressing helpers

local function netKey(netId)
    return 'n:' .. string.format('%.0f', netId) -- LSER numbers are doubles; never "n:1.0"
end

local function refKeyOfObj(obj)
    local netId = objIdToNet[obj.id]
    if netId then return netKey(netId) end
    return 'o:' .. obj.id -- local-only key (content objects; stable per session)
end

-- Wire address for an object, or nil if it is a client-local dynamic object that has no
-- netId yet (must not travel).
local function addrOf(obj)
    local netId = objIdToNet[obj.id]
    if netId then return { net = netId } end
    if obj.contentFile then return { ref = obj } end
    return nil
end

local function resolveBody(data)
    if data.net then return netToObj[data.net] end
    if data.ref then
        -- LSER 'o' deserialized back into a GObject by the engine serializer.
        local ok, valid = pcall(function() return data.ref:isValid() end)
        if ok and valid then return data.ref end
    end
    return nil
end

-- WorldCellState maps are keyed by refKey strings: "c:<index>:<contentFile>" | "n:<netId>".
local function resolveRefKey(key)
    local netId = key:match('^n:(%d+)$')
    if netId then return netToObj[tonumber(netId)] end
    local index, cf = key:match('^c:(%d+):(%d+)$')
    if index then
        local contentName = core.contentFiles.list[tonumber(cf) + 1]
        if not contentName then return nil end
        local ok, obj = pcall(function()
            return world.getObjectByFormId(core.getFormId(contentName, tonumber(index)))
        end)
        if ok then return obj end
    end
    return nil
end

local function cellKeyOfObj(obj)
    local cell = obj.cell
    if not cell then return deps.ownCellKeyFn() end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

local function sendAddressed(eventName, obj, extra)
    local addr = addrOf(obj)
    if not addr then return false end
    extra = extra or {}
    for k, v in pairs(addr) do extra[k] = v end
    extra.cellKey = extra.cellKey or cellKeyOfObj(obj)
    mp.sendEvent(eventName, extra)
    return true
end

local function isOwnEcho(data)
    return data.byId ~= nil and data.byId == deps.ownIdFn()
end

-- ---------------------------------------------------------------- container helpers

local function snapshotContainer(obj)
    local counts = {}
    local ok = pcall(function()
        for _, item in ipairs(types.Container.content(obj):getAll()) do
            counts[item.recordId] = (counts[item.recordId] or 0) + item.count
        end
    end)
    if not ok then return nil end
    return counts
end

local function countsToItems(counts)
    local items = {}
    local ids = {}
    for id in pairs(counts) do ids[#ids + 1] = id end
    table.sort(ids)
    for _, id in ipairs(ids) do
        if counts[id] > 0 then items[#items + 1] = { id = id, n = counts[id] } end
    end
    return items
end

local function itemsToCounts(items)
    local counts = {}
    for _, entry in ipairs(items or {}) do
        counts[entry.id] = (counts[entry.id] or 0) + entry.n
    end
    return counts
end

-- Force a real local container to the given contents (server truth). Global-context
-- inventory surgery: remove everything, recreate. Coarse but deterministic.
local function setContainerContents(obj, items)
    if not (obj and obj:isValid() and types.Container.objectIsInstance(obj)) then return end
    local content = types.Container.content(obj)
    pcall(function()
        for _, item in ipairs(content:getAll()) do
            item:remove()
        end
        for _, entry in ipairs(items or {}) do
            local okc, created = pcall(function() return world.createObject(entry.id, entry.n) end)
            if okc then created:moveInto(content) end
        end
    end)
    -- Never re-diff a network apply as a local op.
    local watch = containerWatch[obj.id]
    if watch then watch.last = snapshotContainer(obj) or watch.last end
end

local function applyContainerDelta(obj, itemId, dn)
    if not (obj and obj:isValid() and types.Container.objectIsInstance(obj)) then return end
    local content = types.Container.content(obj)
    pcall(function()
        if dn > 0 then
            local okc, created = pcall(function() return world.createObject(itemId, dn) end)
            if okc then created:moveInto(content) end
        elseif dn < 0 then
            local left = -dn
            for _, item in ipairs(content:getAll()) do
                if item.recordId == itemId and left > 0 then
                    local take = math.min(left, item.count)
                    item:remove(take)
                    left = left - take
                end
            end
        end
    end)
    local watch = containerWatch[obj.id]
    if watch then watch.last = snapshotContainer(obj) or watch.last end
end

local function trackContainerData(key, items, seq)
    containerData[key] = { items = itemsToCounts(items), seq = seq or 0 }
end

-- ---------------------------------------------------------------- local signals

-- GLOBAL onActivate: pickups, doors, locks, containers all start here.
function objects.onActivate(object, actor)
    local player = deps.playerFn()
    if not player or actor.id ~= player.id then return end
    local now = core.getRealTime()

    if types.Item.objectIsInstance(object) and types.Item.isCarriable(object) then
        -- Pickup: activation moves the item into the inventory natively; relay the delete.
        if sendAddressed('ObjectDelete', object) then
            recentPickups[object.id] = now
            local netId = objIdToNet[object.id]
            if netId then
                netToObj[netId] = nil
                objIdToNet[object.id] = nil
            end
        end
        return
    end

    if types.Door.objectIsInstance(object) and not types.Door.isTeleport(object) then
        -- Rotating door: state flips over the next frames; read the RESULT shortly after.
        -- (Teleport doors need no sync — each client walks through locally.)
        doorPending[object.id] = { obj = object, at = now + DOOR_READ_DELAY }
    end

    if types.Lockable.objectIsInstance(object) then
        -- Unlock has no event: watch the lock state around the activation window
        -- (lockpick/spell/key resolve within it) and relay the change.
        lockWatch[object.id] = {
            obj = object,
            locked = types.Lockable.isLocked(object),
            until_ = now + LOCK_WATCH_SECONDS,
        }
    end

    if types.Container.objectIsInstance(object) then
        local snapshot = snapshotContainer(object)
        if snapshot and sendAddressed('ContainerOpen', object, { contents = countsToItems(snapshot) }) then
            containerWatch[object.id] = {
                obj = object,
                last = snapshot,
                nextPoll = now + CONTAINER_POLL,
                until_ = now + CONTAINER_WATCH_SECONDS,
            }
        end
    end
end

-- GLOBAL onItemActive: an item object appeared in the world. Content items fire this on
-- cell load (contentFile ~= nil -> ignore) and network spawns are pre-marked — what is
-- left is a runtime item near OUR player = the local player dropped it from inventory.
function objects.onItemActive(item)
    if item.contentFile ~= nil then return end
    if netSpawned[item.id] then return end
    for _, obj in pairs(pendingSpawns) do
        if obj.id == item.id then return end
    end
    local player = deps.playerFn()
    if not player then return end
    local ok, dist = pcall(function() return (item.position - player.position):length() end)
    if not ok or dist > DROP_DETECT_RANGE then return end
    objects.requestSpawn(item)
end

-- Register a locally-created runtime object with the server (drops, test chests). The
-- local object stays; ObjectSpawnAck maps the issued netId onto it. `posOverride` is for
-- objects whose teleport has not landed yet (deferred a frame -> position still NaN).
function objects.requestSpawn(obj, posOverride, cellKeyOverride)
    tempCounter = tempCounter + 1
    pendingSpawns[tempCounter] = obj
    local pos = posOverride or obj.position
    local okYaw, rotZ = pcall(function() return obj.rotation:getYaw() end)
    if not okYaw or rotZ ~= rotZ then rotZ = 0 end -- NaN pre-placement
    mp.sendEvent('ObjectSpawnRequest', {
        tempId = tempCounter,
        recordId = obj.recordId,
        cellKey = cellKeyOverride or cellKeyOfObj(obj),
        x = pos.x,
        y = pos.y,
        z = pos.z,
        rotZ = rotZ,
        count = math.max(obj.count or 1, 1), -- unplaced objects report count 0; server needs >=1
    })
end

-- ---------------------------------------------------------------- network appliers

local handlers = {}

handlers.MP_ObjectSpawnAck = function(data)
    local obj = pendingSpawns[data.tempId]
    pendingSpawns[data.tempId] = nil
    if not (obj and obj:isValid() and data.netId) then return end
    -- Own-Place-echo decision: keep OUR local object as the net object (no flicker);
    -- the Place broadcast that follows finds the netId mapped and skips.
    netToObj[data.netId] = obj
    objIdToNet[obj.id] = data.netId
    netSpawned[obj.id] = true
end

handlers.MP_ObjectPlace = function(data)
    if not data.netId or netToObj[data.netId] then return end -- own echo: already mapped
    local ok, obj = pcall(function() return world.createObject(data.recordId, data.count or 1) end)
    -- Foreign dynamic record ids can COLLIDE with unrelated local dynamic records (each
    -- client numbers its own "$dynamic" records — B's may be a puppet NPC record!): only
    -- accept a resolution that is actually an item; anything else gets the stand-in.
    if ok and not types.Item.objectIsInstance(obj) then
        pcall(function() obj:remove() end)
        ok = false
    end
    if not ok then
        -- Unknown/mismatched record here (per-client dynamic drop, content mismatch).
        local placeholder = deps.placeholderItemFn()
        if not placeholder then return end
        obj = world.createObject(placeholder, data.count or 1)
    end
    local player = deps.playerFn()
    local cellArg = (player and player.cell and not player.cell.isExterior) and player.cell.name or ''
    obj:teleport(cellArg, util.vector3(data.x, data.y, data.z),
        { rotation = util.transform.rotateZ(data.rotZ or 0) })
    netToObj[data.netId] = obj
    objIdToNet[obj.id] = data.netId
    netSpawned[obj.id] = true
end

handlers.MP_ObjectDelete = function(data)
    local obj = resolveBody(data)
    if not obj then return end
    if isOwnEcho(data) or recentPickups[obj.id] then return end
    local netId = objIdToNet[obj.id]
    if netId then
        netToObj[netId] = nil
        objIdToNet[obj.id] = nil
    end
    pcall(function() obj:remove() end)
end

handlers.MP_ObjectMove = function(data)
    if isOwnEcho(data) then return end
    local obj = resolveBody(data)
    if not obj then return end
    local player = deps.playerFn()
    local cellArg = (player and player.cell and not player.cell.isExterior) and player.cell.name or ''
    pcall(function()
        obj:teleport(cellArg, util.vector3(data.x, data.y, data.z),
            { rotation = util.transform.rotateZ(data.rotZ or 0) })
    end)
end

handlers.MP_ObjectLock = function(data)
    if isOwnEcho(data) then return end
    local obj = resolveBody(data)
    if not (obj and types.Lockable.objectIsInstance(obj)) then return end
    -- Mute the lock watcher: a network apply must not bounce back as a local change.
    lockWatch[obj.id] = nil
    if data.lockLevel then
        pcall(function() types.Lockable.lock(obj, data.lockLevel) end)
    else
        pcall(function() types.Lockable.unlock(obj) end)
    end
end

handlers.MP_DoorState = function(data)
    if isOwnEcho(data) then return end
    local obj = resolveBody(data)
    if not (obj and types.Door.objectIsInstance(obj)) then return end
    doorPending[obj.id] = nil -- network wins over a pending local read
    if type(data.open) == 'boolean' and types.Door.isOpen(obj) ~= data.open then
        pcall(function() types.Door.activateDoor(obj, data.open) end)
    end
end

handlers.MP_ContainerState = function(data)
    local obj = resolveBody(data)
    local key = data.net and netKey(data.net) or (obj and refKeyOfObj(obj))
    if key then trackContainerData(key, data.items or {}, data.stateSeq) end
    if obj then setContainerContents(obj, data.items or {}) end
end

handlers.MP_ContainerUpdate = function(data)
    local obj = resolveBody(data)
    local key = data.net and netKey(data.net) or (obj and refKeyOfObj(obj))
    local delta = data.delta or {}
    if key then
        local tracked = containerData[key] or { items = {}, seq = 0 }
        tracked.items[delta.itemId] = math.max(0, (tracked.items[delta.itemId] or 0) + (delta.dn or 0))
        tracked.seq = data.stateSeq or tracked.seq
        containerData[key] = tracked
    end
    -- Our own committed op comes back as an Update too (single apply path server-side);
    -- the native transfer already happened locally — consume instead of double-applying.
    for opId, op in pairs(pendingOps) do
        if op.key == key and op.itemId == delta.itemId
            and ((op.op == 'take' and (delta.dn or 0) < 0) or (op.op == 'put' and (delta.dn or 0) > 0)) then
            pendingOps[opId] = nil
            return
        end
    end
    if obj then applyContainerDelta(obj, delta.itemId, delta.dn or 0) end
end

handlers.MP_ContainerOpResult = function(data)
    local op = pendingOps[data.opId]
    if not op then return end
    if data.ok then
        -- The server sends the Result FIRST, then the Update broadcast: keep the entry so
        -- the Update-consume can recognize our own echo (removing it here made the echo
        -- re-apply physically, which the watch re-diffed into a fresh op — runaway loop).
        op.resolved = true
        return
    end
    pendingOps[data.opId] = nil
    -- Lost the race ("gone"): undo the optimistic local take — the item leaves the player
    -- inventory again, and the container is trued up by the ResyncRequest cell state.
    print('[mp] container op rejected: ' .. tostring(data.reason))
    if op.op == 'take' then
        local player = deps.playerFn()
        if player then
            pcall(function()
                local left = op.n
                for _, item in ipairs(types.Actor.inventory(player):getAll()) do
                    if item.recordId == op.itemId and left > 0 then
                        local take = math.min(left, item.count)
                        item:remove(take)
                        left = left - take
                    end
                end
            end)
        end
    end
    mp.sendEvent('ResyncRequest', { cellKey = deps.ownCellKeyFn() })
end

handlers.MP_WorldCellState = function(data)
    for _, place in ipairs(data.placed or {}) do
        handlers.MP_ObjectPlace(place)
    end
    for _, refKey in ipairs(data.deleted or {}) do
        local obj = resolveRefKey(refKey)
        if obj and obj:isValid() and not recentPickups[obj.id] then
            local netId = objIdToNet[obj.id]
            if netId then
                netToObj[netId] = nil
                objIdToNet[obj.id] = nil
            end
            pcall(function() obj:remove() end)
        end
    end
    for refKey, m in pairs(data.moved or {}) do
        local obj = resolveRefKey(refKey)
        if obj and obj:isValid() then
            local player = deps.playerFn()
            local cellArg = (player and player.cell and not player.cell.isExterior) and player.cell.name or ''
            pcall(function()
                obj:teleport(cellArg, util.vector3(m.x, m.y, m.z),
                    { rotation = util.transform.rotateZ(m.rotZ or 0) })
            end)
        end
    end
    for refKey, lockInfo in pairs(data.locks or {}) do
        local obj = resolveRefKey(refKey)
        if obj and obj:isValid() and types.Lockable.objectIsInstance(obj) then
            lockWatch[obj.id] = nil
            if lockInfo.lockLevel then
                pcall(function() types.Lockable.lock(obj, lockInfo.lockLevel) end)
            else
                pcall(function() types.Lockable.unlock(obj) end)
            end
        end
    end
    for refKey, open in pairs(data.doors or {}) do
        local obj = resolveRefKey(refKey)
        if obj and obj:isValid() and types.Door.objectIsInstance(obj)
            and type(open) == 'boolean' and types.Door.isOpen(obj) ~= open then
            pcall(function() types.Door.activateDoor(obj, open) end)
        end
    end
    for refKey, cont in pairs(data.containers or {}) do
        trackContainerData(refKey, cont.items or {}, cont.stateSeq)
        local obj = resolveRefKey(refKey)
        if obj then setContainerContents(obj, cont.items or {}) end
    end
end

objects.handlers = handlers

-- ---------------------------------------------------------------- tick

function objects.tick(now)
    for id, pending in pairs(doorPending) do
        if now >= pending.at then
            doorPending[id] = nil
            local obj = pending.obj
            if obj:isValid() then
                -- Report the state the door is HEADING to (isOpen is false mid-swing, so
                -- use "not fully closed" as the intent).
                local open = not types.Door.isClosed(obj)
                sendAddressed('DoorState', obj, { open = open })
            end
        end
    end

    for id, watch in pairs(lockWatch) do
        local obj = watch.obj
        if now > watch.until_ or not obj:isValid() then
            lockWatch[id] = nil
        else
            local locked = types.Lockable.isLocked(obj)
            if locked ~= watch.locked then
                watch.locked = locked
                sendAddressed('ObjectLock', obj,
                    { lockLevel = locked and types.Lockable.getLockLevel(obj) or nil })
            end
        end
    end

    for id, watch in pairs(containerWatch) do
        local obj = watch.obj
        if now > watch.until_ or not obj:isValid() then
            containerWatch[id] = nil
        elseif now >= watch.nextPoll then
            watch.nextPoll = now + CONTAINER_POLL
            local current = snapshotContainer(obj)
            if current then
                local seen = {}
                for recId, n in pairs(current) do
                    seen[recId] = true
                    local dn = n - (watch.last[recId] or 0)
                    if dn ~= 0 then objects.sendContainerOp(obj, dn < 0 and 'take' or 'put', recId, math.abs(dn)) end
                end
                for recId, n in pairs(watch.last) do
                    if not seen[recId] and n > 0 then
                        objects.sendContainerOp(obj, 'take', recId, n)
                    end
                end
                watch.last = current
            end
        end
    end

    for id, t in pairs(recentPickups) do
        if now - t > ECHO_GUARD_SECONDS then recentPickups[id] = nil end
    end

    for opId, op in pairs(pendingOps) do
        if op.at and now - op.at > 10 then pendingOps[opId] = nil end
    end

    if now - lastMirror >= 0.5 then
        lastMirror = now
        local netObjs = {}
        for netId, obj in pairs(netToObj) do
            if obj:isValid() then netObjs[tostring(netId)] = obj.recordId end
        end
        mp.testSet('netObjects', json.encode(netObjs))
        local conts = {}
        for key, c in pairs(containerData) do
            conts[key] = c.items
        end
        mp.testSet('containerItems', json.encode(conts))
    end
end

function objects.sendContainerOp(obj, op, itemId, n)
    opCounter = opCounter + 1
    local addr = addrOf(obj)
    if not addr then return nil end
    pendingOps[opCounter] = { op = op, itemId = itemId, n = n, key = refKeyOfObj(obj), obj = obj, at = core.getRealTime() }
    local body = { opId = opCounter, op = op, itemId = itemId, n = n, cellKey = cellKeyOfObj(obj) }
    for k, v in pairs(addr) do body[k] = v end
    mp.sendEvent('ContainerOpRequest', body)
    return opCounter
end

-- Direct-address variant for test commands driving a container we only know by netId.
function objects.sendContainerOpByNet(netId, op, itemId, n, cellKey)
    opCounter = opCounter + 1
    pendingOps[opCounter] = { op = op, itemId = itemId, n = n, key = netKey(netId), obj = netToObj[netId], at = core.getRealTime() }
    mp.sendEvent('ContainerOpRequest',
        { opId = opCounter, op = op, itemId = itemId, n = n, cellKey = cellKey, net = netId })
    return opCounter
end

function objects.netIdOf(obj)
    return objIdToNet[obj.id]
end

function objects.objOfNet(netId)
    return netToObj[netId]
end

function objects.markNetSpawned(obj)
    netSpawned[obj.id] = true
end

function objects.reset()
    netToObj = {}
    objIdToNet = {}
    netSpawned = {}
    pendingSpawns = {}
    pendingOps = {}
    recentPickups = {}
    doorPending = {}
    lockWatch = {}
    containerWatch = {}
    containerData = {}
end

function objects.init(d)
    deps = d
end

return objects
