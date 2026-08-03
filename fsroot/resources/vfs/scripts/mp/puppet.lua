-- Puppet (M1 players + M4 shared NPCs): controls-driven remote actor.
-- Attached by global.lua via obj:addScript('scripts/mp/puppet.lua', {playerId=<u16>}) for
-- remote PLAYERS, or {actorKey=<refKey>} for cell NPCs when this client is NOT the cell's
-- authority holder. Consumes MP_Pose events (routed per-puppet from MP_MoveBatch /
-- ActorMoveBatch) into an interpolation buffer and STEERS toward the 100 ms-delayed target
-- through self.controls — the engine's own movement solver drives animation/collision, so
-- puppets walk/run/jump like real actors instead of gliding between set positions. On
-- divergence it asks global.lua for a teleport via mpSnapRequest.
local core = require('openmw.core')
local self = require('openmw.self')
local types = require('openmw.types')
local I = require('openmw.interfaces')

local Interp = require('scripts.mp.interp')

-- G2 render LOD. tier arrives stamped on each MP_Pose by global.lua (which knows where the
-- local player is); 0 = near, 1 = mid, 2 = far.
--
-- NEAR is the full-fidelity path: steer through self.controls so the engine's own movement
-- solver produces real walk/run animation, collision and footing.
--
-- MID and FAR stop driving controls entirely and reposition instead. This is the whole
-- saving: an actor that is never commanded to move stands in an idle animation and does no
-- per-frame movement solve, whereas a steered one runs the character controller, blends
-- locomotion animation and sweeps physics every single frame. What it costs is smooth
-- motion for that avatar — which is why the thresholds widen with distance, where a
-- reposition covers fewer pixels and reads as normal movement.
local TIER_NEAR, TIER_MID = 0, 1
-- Units of divergence tolerated before asking for a teleport, and the minimum gap between
-- teleports, per tier.
--
-- These are wide on purpose, and the reason is counter-intuitive enough to record: a
-- REPOSITION IS MORE EXPENSIVE THAN STEERING. A mid tier tuned to teleport about once a
-- second measured WORSE than doing nothing clever at all, because ~30 actors/second were
-- being re-placed in the world. The saving comes from repositioning RARELY, not from
-- skipping the character controller, so a tighter threshold does not buy accuracy: it buys
-- a slower client.
--
-- The absolute figures that observation was first made against were taken on a contended
-- box and were an order of magnitude too high; see server/README.md for the corrected
-- idle-box numbers (0.177 ms/avatar fully simulated vs 0.086 ms with the cap). The ORDERING
-- held up on re-measurement — frequent repositioning is still the expensive path — which is
-- why these thresholds stay wide.
local SNAP_BY_TIER = { [0] = 128, [1] = 1024, [2] = 2048 }
local SNAP_COOLDOWN_BY_TIER = { [0] = 1.0, [1] = 2.0, [2] = 3.0 }
local SNAP_DISTANCE = 128 -- near-tier divergence before asking for a teleport (legacy name)
local STUCK_SECONDS = 0.7 -- commanded to move but no progress this long -> snap
local IDLE_TIMEOUT = 1.0 -- no snapshots this long -> stand still
local SNAP_COOLDOWN = 1.0 -- let a requested teleport land before asking again

local playerId = nil -- set for remote-player puppets
local actorKey = nil -- set for M4 NPC puppets (refKey the holder addresses)
local interp = Interp.new()
local lastSnapReq = 0
local stuckSince = nil
local lastProgressPos = nil
local prevJump = false
local tier = TIER_NEAR -- last tier stamped on a pose; near until told otherwise
local dead = false
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
    if now - lastSnapReq < (SNAP_COOLDOWN_BY_TIER[tier] or SNAP_COOLDOWN) then return end
    lastSnapReq = now
    core.sendGlobalEvent('mpSnapRequest',
        { id = playerId, actorKey = actorKey, x = target.x, y = target.y, z = target.z, why = why })
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

-- M5: intercept every hit landed on this puppet. Handlers run last-registered-first
-- (openmw_aux.util.callEventHandlers iterates in reverse) and this script attaches at
-- RUNTIME, after the builtin combat script — so this runs FIRST, forwards the raw
-- PRE-mitigation damage to the victim's owner, and returns false to cancel the entire local
-- chain. Nothing is applied here: armor/difficulty/sounds belong to the owner's engine.
local function onHitIntercept(attack)
    if not playerId and not actorKey then return end -- not a live puppet: let the engine be
    local weapon = attack.weapon
    core.sendGlobalEvent('mpCombatHit', {
        victim = self.object,
        playerId = playerId,
        damage = attack.damage,
        strength = attack.strength,
        sourceType = attack.sourceType,
        successful = attack.successful,
        weaponId = weapon and weapon.recordId or nil,
        ammoId = attack.ammo,
        hitPos = attack.hitPos and { x = attack.hitPos.x, y = attack.hitPos.y, z = attack.hitPos.z } or nil,
    })
    return false -- cancel local damage; the owner applies it
end

-- I.Combat comes from the builtin combat script, which is already attached to any actor we
-- puppet (it attaches at object load, we attach later) — but never assume: if the interface
-- is not up yet, register on the next tick instead of erroring out at load.
local hitHandlerRegistered = false
local function ensureHitHandler()
    if hitHandlerRegistered or not I.Combat then return end
    I.Combat.addOnHitHandler(onHitIntercept)
    hitHandlerRegistered = true
end
ensureHitHandler()

local function onUpdate(dt)
    ensureHitHandler()
    if dt <= 0 or (not playerId and not actorKey) then return end
    if dead then
        zeroControls()
        return
    end
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

    if dist3d > (SNAP_BY_TIER[tier] or SNAP_DISTANCE) then
        requestSnap(target, 'distance')
        zeroControls()
        return
    end

    -- Beyond the near tier: never touch controls again. Returning here is the entire point
    -- of the tier — the reposition above is the only movement a distant avatar gets, and
    -- skipping the steering below is what stops the engine simulating it every frame.
    if tier ~= TIER_NEAR then
        zeroControls()
        -- The stuck detector only means something for an actor we are steering; leaving it
        -- armed across a tier change makes a promoted puppet fire a bogus snap immediately.
        stuckSince = nil
        lastProgressPos = nil
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
            actorKey = initData and initData.actorKey
            self:enableAI(false) -- the pose stream owns this actor, not the AI
        end,
        onLoad = function(data)
            playerId = data and data.playerId
            actorKey = data and data.actorKey
            self:enableAI(false)
        end,
        onSave = function()
            return { playerId = playerId, actorKey = actorKey }
        end,
        onUpdate = onUpdate,
    },
    eventHandlers = {
        MP_Pose = function(e)
            -- Absent tier (a server predating G2, or renderLod = "full") means near: the
            -- fallback must be full fidelity, never a silent degrade.
            tier = e.tier or TIER_NEAR
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
        -- M2/M4: mirror the remote actor's dynamic stats (health bar, death pose).
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
        -- M4: authoritative death from the holder. Zero health so the engine plays the
        -- death animation locally; puppet steering stops.
        MP_Kill = function()
            dead = true
            zeroControls()
            pcall(function() types.Actor.stats.dynamic.health(self).current = 0 end)
        end,
        MP_Revive = function()
            dead = false
        end,
        -- M5 cosmetic: mirror a remote caster's spell animation (best effort — a missing
        -- animation group must never break the puppet).
        MP_CastFx = function()
            pcall(function()
                local anim = require('openmw.animation')
                anim.playBlendedAnimation(self, 'spellcast', { priority = anim.PRIORITY.Weapon })
            end)
        end,
        -- M4 handoff: this client became the cell's authority holder. Re-enable AI (the
        -- mDisableAI control persists after removeScript, so it must be cleared here) and
        -- stop driving; global.lua removes the script right after.
        MP_Detach = function()
            actorKey = nil
            playerId = nil
            dead = false
            zeroControls()
            self:enableAI(true)
            -- Ask the GLOBAL script to remove us, now that AI is back on. `removeScript` is
            -- bound on GObject only (objectbindings.cpp) — it does not exist on a local
            -- script's `self`, so the previous `self:removeScript(...)` here threw and the
            -- pcall around it swallowed the failure: the script was NEVER removed on
            -- handoff, despite the comment claiming it was.
            --
            -- The global script still must not remove it directly on MP_Detach: sendEvent
            -- lands next frame while removeScript takes effect at once, so doing it there
            -- destroyed this script before it re-enabled AI, freezing the cell's NPCs. The
            -- extra event hop preserves that ordering — AI is on before removal is handled.
            core.sendGlobalEvent('mpPuppetDetached', { obj = self.object })
        end,
    },
}
