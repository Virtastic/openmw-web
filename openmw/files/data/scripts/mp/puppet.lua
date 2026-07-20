-- Remote-player puppet (M1): controls-driven avatar of another player.
-- Attached by global.lua via obj:addScript('scripts/mp/puppet.lua', {playerId=<u16>}).
-- Consumes MP_Pose events (routed per-puppet from MP_MoveBatch) into an interpolation
-- buffer and STEERS toward the 100 ms-delayed target through self.controls — the engine's
-- own movement solver drives animation/collision, so puppets walk/run/jump like real
-- actors instead of gliding between set positions. When steering diverges (blocked by
-- geometry, big warp) it asks global.lua for a teleport via the mpSnapRequest event.
local core = require('openmw.core')
local self = require('openmw.self')
local types = require('openmw.types')

local Interp = require('scripts.mp.interp')

local SNAP_DISTANCE = 128 -- units of divergence before asking for a teleport
local STUCK_SECONDS = 0.7 -- commanded to move but no progress this long -> snap
local IDLE_TIMEOUT = 1.0 -- no snapshots this long -> stand still
local SNAP_COOLDOWN = 1.0 -- let a requested teleport land before asking again

local playerId = nil
local interp = Interp.new()
local lastSnapReq = 0
local stuckSince = nil
local lastProgressPos = nil
local prevJump = false
local pendingEquip = nil -- M2: slot map waiting for granted items to land in the inventory
local equipRetryUntil = 0

local function zeroControls()
    self.controls.movement = 0
    self.controls.sideMovement = 0
    self.controls.yawChange = 0
    self.controls.jump = false
end

local function shortestArc(a)
    while a > math.pi do a = a - 2 * math.pi end
    while a < -math.pi do a = a + 2 * math.pi end
    return a
end

local function bit(flags, n) -- flags arrive as LSER doubles; pure-arithmetic bit test
    return math.floor((flags or 0) / 2 ^ n) % 2 >= 1
end

local function requestSnap(target, why)
    local now = core.getRealTime()
    if now - lastSnapReq < SNAP_COOLDOWN then return end
    lastSnapReq = now
    core.sendGlobalEvent('mpSnapRequest', { id = playerId, x = target.x, y = target.y, z = target.z, why = why })
end

-- M2: setEquipment only works once the items granted by global.lua exist in our inventory
-- (createObject+moveInto lands a frame or more later) — retry briefly, then best-effort.
local function equipTick(now)
    if not pendingEquip then return end
    local have = {}
    for _, item in ipairs(types.Actor.inventory(self):getAll()) do
        have[item.recordId] = true
    end
    local ready = true
    for _, id in pairs(pendingEquip) do
        if not have[id] then ready = false end
    end
    if ready or now > equipRetryUntil then
        local ok, err = pcall(types.Actor.setEquipment, self, pendingEquip)
        if not ok then print('[mp] puppet equip failed: ' .. tostring(err)) end
        pendingEquip = nil
    end
end

local function onUpdate(dt)
    if dt <= 0 or not playerId then return end
    local now = core.getRealTime()
    equipTick(now)
    local newest = interp:newestTime()
    if not newest or now - newest > IDLE_TIMEOUT then
        zeroControls()
        stuckSince = nil
        return
    end
    local target = interp:target(now)
    if not target then
        zeroControls()
        return
    end

    local pos = self.position
    local dx, dy = target.x - pos.x, target.y - pos.y
    local dz = target.z - pos.z
    local dist2d = math.sqrt(dx * dx + dy * dy)
    local dist3d = math.sqrt(dx * dx + dy * dy + dz * dz)

    if dist3d > SNAP_DISTANCE then
        requestSnap(target, 'distance')
        zeroControls()
        return
    end

    -- Stuck: steering toward a moving target without progressing (wedged on geometry).
    if dist2d > 16 then
        if lastProgressPos and (pos - lastProgressPos):length() < 1 then
            stuckSince = stuckSince or now
            if now - stuckSince > STUCK_SECONDS then
                requestSnap(target, 'stuck')
                stuckSince = nil
            end
        else
            stuckSince = nil
            lastProgressPos = pos
        end
    else
        stuckSince = nil
        lastProgressPos = pos
    end

    local curYaw = self.rotation:getYaw()
    if dist2d > 4 then
        -- Steer toward the target point (MW yaw: 0 = +Y, clockwise positive).
        self.controls.yawChange = shortestArc(math.atan(dx, dy) - curYaw)
        self.controls.movement = 1
    else
        -- Close enough: hold position, face the remote player's actual heading.
        self.controls.movement = 0
        self.controls.yawChange = shortestArc((target.yaw or curYaw) - curYaw)
    end
    self.controls.sideMovement = 0
    self.controls.run = bit(target.flags, 0)
    self.controls.sneak = bit(target.flags, 1)
    local jumpEdge = bit(target.flags, 2)
    self.controls.jump = jumpEdge and not prevJump
    prevJump = jumpEdge
end

return {
    engineHandlers = {
        onInit = function(initData)
            playerId = initData and initData.playerId
            self:enableAI(false) -- the pose stream owns this actor, not the AI
        end,
        onLoad = function(data)
            playerId = data and data.playerId
            self:enableAI(false)
        end,
        onSave = function()
            return { playerId = playerId }
        end,
        onUpdate = onUpdate,
    },
    eventHandlers = {
        MP_Pose = function(e)
            interp:push(e)
        end,
        -- M2: full slot->recordId snapshot (items already granted by global.lua).
        MP_Equip = function(data)
            local slots = {}
            for slot, id in pairs(data.slots or {}) do
                slots[tonumber(slot) or slot] = id
            end
            pendingEquip = slots
            equipRetryUntil = core.getRealTime() + 3
        end,
        -- M2: mirror the remote player's dynamic stats (health bar, death pose).
        MP_Stats = function(data)
            local d = types.Actor.stats.dynamic
            local function apply(stat, v)
                if v then
                    stat.base = v.b
                    stat.current = v.c
                end
            end
            apply(d.health(self), data.hp)
            apply(d.magicka(self), data.mp)
            apply(d.fatigue(self), data.ft)
        end,
    },
}
