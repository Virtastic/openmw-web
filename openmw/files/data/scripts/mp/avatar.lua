-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- Phase 3: PEER-side avatar driver. Attached (on the sim peer only) to the body that
-- embodies a connected player, in place of puppet.lua: where a puppet STEERS toward poses
-- the owner's client reported, an avatar is driven by the player's raw INPUT — the peer's
-- physics and animation produce the authoritative pose, which global.lua streams back
-- (mp.sendAvatarMoveBatch) for the server to fan out.
--
-- Input arrives as mpAvatarInput events routed by global.lua from MP_PlayerInput. Between
-- frames the LAST input holds (a 30 Hz stream against a 20 fps sim means roughly one or two
-- per frame); if the stream stops (owner lagging or gone) the avatar coasts to a stop
-- rather than running into a wall forever.
--
-- Like puppet.lua: AI off while attached, and DETACH IS ASYNCHRONOUS BY CONTRACT — the
-- global script removes this script only via the mpAvatarDetached hop, after enableAI(true)
-- has run here, or mDisableAI wedges on and the actor freezes for good.

local self = require('openmw.self')
local types = require('openmw.types')
local core = require('openmw.core')
local I = require('openmw.interfaces')
local mp = require('openmw.mp')

-- PvP POLICY, pushed by global.lua (mpAvatarPolicy) on spawn and whenever it changes.
-- The peer resolves avatar-vs-avatar melee NATIVELY, so with pvp off the server's
-- allowPlayerHit veto never runs -- a pvp-off world would still let players kill each other
-- on the peer. avatarObjIds is the set of bodies that ARE avatars, so an NPC's blow (PvE)
-- is untouched: only player-on-player damage is vetoed.
local pvpEnabled = false
local avatarObjIds = {}

local input = nil -- latest {seq, move, side, yaw, pitch, flags}
local inputAt = 0
local INPUT_HOLD_S = 0.35 -- coast to a stop when the stream stops
local USE_HOLD_S = 2.0 -- ...but keep a held attack/draw this long (see the hold branch)

local prevJump = false
local hitHandlerRegistered = false

-- Veto player-on-player damage while pvp is off: the peer resolves avatar-vs-avatar melee
-- natively, so the server's allowPlayerHit veto never sees it. An NPC's blow is untouched --
-- only bodies in avatarObjIds (other players' avatars) are vetoed.
local function registerHitVeto()
    if hitHandlerRegistered or not I.Combat then return end
    hitHandlerRegistered = true
    I.Combat.addOnHitHandler(function(attack)
        if pvpEnabled then return end
        local a = attack.attacker
        local ok, aid = pcall(function() return a and a.id end)
        if not (ok and aid) then return end
        if avatarObjIds[aid] then return false end
        -- A SUMMON IS ITS SUMMONER'S HAND. The peer summons for every player now, and a
        -- summon attacks what its master engages: with pvp off another player's scamp could
        -- bite this avatar when the player could not. The engine records who summoned what.
        if mp.summonerOf then
            local okm, master = pcall(mp.summonerOf, a)
            local okid, mid = pcall(function() return master and master.id end)
            if okm and okid and mid and avatarObjIds[mid] then return false end
        end
    end)
end

local function bit(flags, n)
    return math.floor((flags or 0) / (2 ^ n)) % 2 == 1
end

local function shortestArc(a)
    while a > math.pi do a = a - 2 * math.pi end
    while a < -math.pi do a = a + 2 * math.pi end
    return a
end

local function stop()
    self.controls.movement = 0
    self.controls.sideMovement = 0
    self.controls.yawChange = 0
    self.controls.pitchChange = 0
    self.controls.jump = false
    self.controls.use = 0
    -- Drop the modifiers too, or a coasting avatar keeps its sneak posture (and stealth)
    -- after the owner's input stops, and a stale jump edge swallows the first jump on resume.
    self.controls.run = false
    self.controls.sneak = false
    prevJump = false
end

-- THE AVATAR'S HANDS. global.lua pushes equipment as an MP_Equip event on the body, and the
-- handler lived only in puppet.lua -- which the peer never attaches (an avatar carries this
-- script INSTEAD, so the two cannot fight over controls). So no avatar ever equipped anything:
-- the inventory reconciled, the weapon sat in the pack, and every melee the peer computed for
-- a player was a bare-handed one; a bow could not be drawn at all (s138). setEquipment is
-- Self-gated, so this is the only place it can land. Same retry as puppet.lua: the granted
-- items land a frame or more after the event.
local pendingEquip = nil
local equipRetryUntil = 0
local function equipTick(now)
    if not pendingEquip then return end
    local have = {}
    for _, item in ipairs(types.Actor.inventory(self):getAll()) do have[item.recordId] = true end
    local ready = true
    for _, id in pairs(pendingEquip) do
        if not have[id] then ready = false end
    end
    if ready or now > equipRetryUntil then
        -- BY OBJECT, THE LARGEST STACK. A record id equips the first matching stack, and the
        -- pack can hold two of the same record: the single item the equipment push fabricated
        -- before the inventory doc arrived, and the real stack the doc granted beside it. A
        -- quiver bound to the lone arrow loosed one shot and the avatar stood there with the
        -- other twenty-three in the pack.
        local best = {}
        for _, item in ipairs(types.Actor.inventory(self):getAll()) do
            local b = best[item.recordId]
            if not b or (item.count or 1) > (b.count or 1) then best[item.recordId] = item end
        end
        local slots = {}
        for slot, id in pairs(pendingEquip) do slots[slot] = best[id] or id end
        local ok, err = pcall(types.Actor.setEquipment, self, slots)
        if not ok then print('[mp] avatar equip failed: ' .. tostring(err)) end
        pendingEquip = nil
    end
end

return {
    engineHandlers = {
        onActive = function()
            self:enableAI(false)
            registerHitVeto()
            -- TELL THE ENGINE THIS BODY IS A PLAYER. Engine code that reacts to "the player"
            -- calls getPlayer(), which on the sim peer is its own idle dummy -- so nothing in
            -- the world reacted to a real person. Crime pursuit was the visible case: rob a
            -- shop in front of a guard and be ignored, because the guard checked a bounty
            -- belonging to nobody. See mwmp/puppets.hpp.
            if mp.setAvatar then mp.setAvatar(self.object, true) end
        end,
        onUpdate = function()
            equipTick(core.getRealTime())
            -- I.Combat comes from the builtin combat script on this body; if it was not up
            -- at onActive, register on a later tick rather than losing the veto (puppet.lua
            -- learned the same lesson).
            if not hitHandlerRegistered then registerHitVeto() end
            local now = core.getRealTime()
            if not input or now - inputAt > INPUT_HOLD_S then
                -- THE DRAW SURVIVES A SLOW STREAM. Motion coasts to a stop when frames lapse,
                -- but the use bit used to drop with it -- and a client at a few fps (a big
                -- scene, a loading hitch, a headless test) sends frames further apart than
                -- the hold, so every bow the avatar drew was released the instant the stream
                -- stuttered: a minimum-strength shot for 2 damage no matter how long the
                -- owner held the button (measured 1.6 per arrow from a long bow). A bow held
                -- a moment longer harms nothing; keep it for a bounded while.
                local keepUse = input and bit(input.flags, 3) and now - inputAt <= USE_HOLD_S
                stop()
                if keepUse then self.controls.use = 1 end
                return
            end
            self.controls.movement = input.move or 0
            self.controls.sideMovement = input.side or 0
            local curYaw = self.rotation:getYaw()
            self.controls.yawChange = shortestArc((input.yaw or curYaw) - curYaw)
            -- PITCH TOO. The input has always carried it (radians, same scale as the pose) and
            -- the avatar never applied it, so it aimed level: an arrow at a cliff-top archer, or
            -- a swing at a rat underfoot, went out flat no matter where the owner was looking.
            local curPitch = self.rotation:getPitch()
            self.controls.pitchChange = (input.pitch or curPitch) - curPitch
            self.controls.run = bit(input.flags, 0)
            self.controls.sneak = bit(input.flags, 1)
            local jump = bit(input.flags, 2)
            self.controls.jump = jump and not prevJump
            prevJump = jump
            -- Phase 4C: THE AVATAR SWINGS. The owner's use bit drives the attack control, and
            -- this engine computes the hit natively against the actors it simulates. Safe
            -- now because combat.lua no longer forwards a real swing while the peer holds
            -- the cell -- so a blow lands exactly once, here.
            self.controls.use = bit(input.flags, 3) and 1 or 0
            -- THE OWNER'S STANCE, OR THE USE BIT IS INERT: an attack only starts from a drawn
            -- weapon (character.cpp, UpperBodyState::WeaponEquipped). Spell stance maps to
            -- Nothing on purpose -- the avatar must never cast; the owner's client casts and
            -- forwards the hit (combat.lua onPuppetSpellHit), and a casting avatar would land it
            -- twice. So while the owner readies magic the avatar simply stands down.
            local want = bit(input.flags, 4) and types.Actor.STANCE.Weapon or types.Actor.STANCE.Nothing
            if types.Actor.getStance(self) ~= want then
                pcall(function() types.Actor.setStance(self, want) end)
            end
        end,
    },
    eventHandlers = {
        -- The owner's character, applied to this body: the doc on spawn (global.lua
        -- applyAvatarDoc), a client heal or spend later (MP_AvatarRestore). Stat setters
        -- are Self-gated in mwlua/stats.cpp, so this is the only place they can land.
        mpAvatarStats = function(stats)
            if type(stats) ~= 'table' then return end
            local okL, errL = pcall(function()
                if stats.level then types.Actor.stats.level(self).current = stats.level end
                for name, v in pairs(stats.attributes or {}) do
                    local a = types.Actor.stats.attributes[name]
                    if a then a(self).base = v end
                end
                if types.NPC.objectIsInstance(self) then
                    for name, v in pairs(stats.skills or {}) do
                        local s = types.NPC.stats.skills[name]
                        if s then s(self).base = v end
                    end
                end
                local map = { hp = 'health', mp = 'magicka', ft = 'fatigue' }
                for k, statName in pairs(map) do
                    local d = stats.dynamic and stats.dynamic[k]
                    if d then
                        local stat = types.Actor.stats.dynamic[statName](self)
                        if d.b then stat.base = d.b end
                        if d.c then stat.current = d.c end
                    end
                end
            end)
            if not okL then print('[mp] avatar stats apply failed: ' .. tostring(errL)) end
        end,
        MP_Equip = function(data)
            local slots = {}
            for slot, id in pairs(data.slots or {}) do slots[tonumber(slot) or slot] = id end
            pendingEquip = slots
            equipRetryUntil = core.getRealTime() + 3
        end,
        mpAvatarPolicy = function(data)
            if data.pvp ~= nil then pvpEnabled = data.pvp == true end
            if type(data.avatarObjIds) == 'table' then avatarObjIds = data.avatarObjIds end
        end,
        mpAvatarInput = function(data)
            -- Stale-drop on the input's own seq: UDP-like reordering cannot happen on one
            -- socket, but the server may resend and the hold logic wants monotonicity.
            if input and data.seq and input.seq and data.seq <= input.seq then return end
            input = data
            inputAt = core.getRealTime()
        end,
        -- Same three-step contract as puppet.lua: re-enable AI HERE, then ask the global
        -- script to remove this script. Removing it synchronously from global would leave
        -- mDisableAI latched.
        mpAvatarDetach = function()
            stop()
            self:enableAI(true)
            if mp.setAvatar then mp.setAvatar(self.object, false) end
            core.sendGlobalEvent('mpAvatarDetached', { obj = self.object })
        end,
    },
}
