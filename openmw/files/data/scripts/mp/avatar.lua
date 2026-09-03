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
        if ok and aid and avatarObjIds[aid] then return false end
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
    self.controls.jump = false
    self.controls.use = 0
    -- Drop the modifiers too, or a coasting avatar keeps its sneak posture (and stealth)
    -- after the owner's input stops, and a stale jump edge swallows the first jump on resume.
    self.controls.run = false
    self.controls.sneak = false
    prevJump = false
end

return {
    engineHandlers = {
        onActive = function()
            self:enableAI(false)
            registerHitVeto()
        end,
        onUpdate = function()
            -- I.Combat comes from the builtin combat script on this body; if it was not up
            -- at onActive, register on a later tick rather than losing the veto (puppet.lua
            -- learned the same lesson).
            if not hitHandlerRegistered then registerHitVeto() end
            local now = core.getRealTime()
            if not input or now - inputAt > INPUT_HOLD_S then
                stop()
                return
            end
            self.controls.movement = input.move or 0
            self.controls.sideMovement = input.side or 0
            local curYaw = self.rotation:getYaw()
            self.controls.yawChange = shortestArc((input.yaw or curYaw) - curYaw)
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
        end,
    },
    eventHandlers = {
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
            core.sendGlobalEvent('mpAvatarDetached', { obj = self.object })
        end,
    },
}
