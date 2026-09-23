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
local util = require('openmw.util')

-- PvP POLICY, pushed by global.lua (mpAvatarPolicy) on spawn and whenever it changes.
-- The peer resolves avatar-vs-avatar melee NATIVELY, so with pvp off the server's
-- allowPlayerHit veto never runs -- a pvp-off world would still let players kill each other
-- on the peer. avatarObjIds is the set of bodies that ARE avatars, so an NPC's blow (PvE)
-- is untouched: only player-on-player damage is vetoed.
local pvpEnabled = false
local avatarObjIds = {}

local input = nil -- latest {seq, move, side, yaw, pitch, flags}
local inputAt = 0
local appliedSeqSent = nil -- the newest input seq this body has put into its controls
-- WHERE THIS BODY STOOD WHEN THE SEQ ARRIVED, not where it stands a frame or two later. The
-- peer steps at 20 fps and the owner sends at 30 Hz, so a pose stamped "seq N" already held
-- up to 1.5 frames (up to 75 ms) of N's movement that the owner's ring entry for N does not:
-- 0-12 units of phantom divergence on every running sample, corrected as if it were real.
-- Backed off by the frames N has run plus half a frame for when inside a frame it arrived.
local frameNo, appliedFrame, lastPos, stepVel = 0, 0, nil, nil
local FRAME_STEP_MAX = 200 -- a per-frame move beyond this is a teleport, not a velocity
-- The owner's simulated time not yet spent (see the timed branch in onUpdate). Capped so a burst
-- after a stall cannot owe the avatar seconds of running; the correction absorbs the rest.
local timed, budget, budgetAtRead = false, 0, 0
local BUDGET_MAX = 0.25
local frameDt, spendPrev, lastSpend = 0, 0, 0
-- 1.0, not 0.35: a TCP retransmit stall (300 ms RTO, seconds on a Wi-Fi roam) must not stop
-- the avatar while the owner keeps running -- the burst collapses to the newest input and the
-- owner is snapped back by v x stall (#205).
local INPUT_HOLD_S = 1.0 -- coast to a stop when the stream stops
local USE_HOLD_S = 2.0 -- ...but keep a held attack/draw this long (see the hold branch)

local prevJump = false
-- EDGES ARE LATCHED UNTIL CONSUMED. The owner sends ~30 Hz, this engine ticks at 20 Hz: the
-- second input of a tick overwrote the first and one jump in three (or a short use click)
-- never reached the avatar while observers, who latch, saw it (#198).
local jumpLatch, useLatch = false, false
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

-- THE TANK'S PROGRESSION (backlog 307). I.SkillProgression is a PLAYER script, so a hit on
-- this NPC body's armour (omw/combat/local.lua applyArmor) or a block (combat.cpp) counted
-- for nobody. Only the armour/block family is forwarded -- the owner's own client already
-- claims weapon, spell and movement uses -- to the owner's I.SkillProgression via the server
-- (AvatarSkillUse -> SelfSkillUse, player.lua). Block arrives through the engine's
-- _onSkillUse; armour through the I.MPAvatar interface local.lua calls when it finds no
-- SkillProgression on the body.
local SKILL_USE_FORWARDED = { block = true, lightarmor = true, mediumarmor = true, heavyarmor = true, unarmored = true }
-- Fall probe (backlog 341, s147 diagnostic): isOnGround takes an LObject, so the read has to
-- happen here. The airborne top is tracked; the landing goes to global.lua, which prints.
local fallTop = nil
local function fallProbe()
    local okg, onGround = pcall(types.Actor.isOnGround, self)
    if not okg then return end
    local z = self.position.z
    if not onGround then
        if fallTop == nil or z > fallTop then fallTop = z end
    elseif fallTop ~= nil then
        core.sendGlobalEvent('mpAvatarLanded', { obj = self.object, top = fallTop, z = z })
        fallTop = nil
    end
end

local function forwardSkillUse(skillid, useType)
    if not SKILL_USE_FORWARDED[skillid] then return end
    core.sendGlobalEvent('mpAvatarSkillUse', { obj = self.object, skill = skillid, useType = useType or 0 })
end

return {
    interfaceName = 'MPAvatar',
    interface = { version = 1, skillUsed = forwardSkillUse },
    engineHandlers = {
        _onSkillUse = forwardSkillUse,
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
        onUpdate = function(dt)
            frameNo = frameNo + 1
            frameDt = dt or 0
            lastSpend, spendPrev = spendPrev, 0
            do
                local pos = self.position
                local step = lastPos and (pos - lastPos) or nil
                stepVel = (step and step:length() <= FRAME_STEP_MAX) and step or nil
                lastPos = pos
            end
            equipTick(core.getRealTime())
            fallProbe()
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
                budget = 0
                stop()
                if keepUse then self.controls.use = 1 end
                return
            end
            -- MOVE FOR AS LONG AS THE OWNER DID. A timed input (simMs > 0) funds `budget` with the
            -- seconds its owner actually simulated; each frame spends up to its own dt of it, and
            -- the axes scale by the share it could fund. A hitch on the owner's side (their
            -- engine caps a frame at 200 ms) therefore costs the avatar the same movement, where
            -- it used to walk the whole wall-clock hitch and yank the owner forward after it.
            local frac = 1
            if timed then
                local dtNow = frameDt or 0
                local use = math.min(budget, dtNow)
                budgetAtRead = budget -- what the position below does not yet contain
                frac = dtNow > 0 and use / dtNow or 0
                budget = budget - use
                spendPrev = use
            end
            self.controls.movement = (input.move or 0) * frac
            self.controls.sideMovement = (input.side or 0) * frac
            local curYaw = self.rotation:getYaw()
            self.controls.yawChange = shortestArc((input.yaw or curYaw) - curYaw)
            -- PITCH TOO. The input has always carried it (radians, same scale as the pose) and
            -- the avatar never applied it, so it aimed level: an arrow at a cliff-top archer, or
            -- a swing at a rat underfoot, went out flat no matter where the owner was looking.
            local curPitch = self.rotation:getPitch()
            self.controls.pitchChange = (input.pitch or curPitch) - curPitch
            self.controls.run = bit(input.flags, 0)
            self.controls.sneak = bit(input.flags, 1)
            local jump = jumpLatch or bit(input.flags, 2)
            jumpLatch = false
            self.controls.jump = jump and not prevJump
            prevJump = jump
            -- THE SEQ THIS BODY HAS ACTUALLY APPLIED. The pose stream used to be stamped with the
            -- newest input the global script had RECEIVED, but that input only reaches these
            -- controls a frame later (a local event) and moves the body a frame after that, so
            -- every pose claimed ~100-150 ms of input it did not contain. The owner's client
            -- compares a pose with where it stood when that seq left (player.lua posAt), so the
            -- false claim was a correction on every start, stop and turn: constant micro
            -- rubber-banding. Reported once per new seq; global.lua stamps the stream with it.
            if input.seq and input.id then
                if input.seq ~= appliedSeqSent then
                    appliedSeqSent = input.seq
                    appliedFrame = frameNo
                end
                -- Every frame, the (seq, pose) PAIR: the position read here is last frame's
                -- physics, which holds (frameNo - appliedFrame) frames of this seq.
                local pos = self.position
                local at
                if timed then
                    -- EXACT, not estimated: the owner stood at ring[seq] after all the time up to
                    -- and including this seq; the body is budgetAtRead of that time short of it.
                    -- Carried forward at the speed the last frame's spend produced (xy only:
                    -- gravity runs on the peer's clock, not the owner's).
                    local vxy = (stepVel and lastSpend > 0) and (stepVel / lastSpend) or util.vector3(0, 0, 0)
                    at = pos + util.vector3(vxy.x, vxy.y, 0) * budgetAtRead
                else
                    local v = stepVel or util.vector3(0, 0, 0)
                    at = pos - v * ((frameNo - appliedFrame) + 0.5)
                end
                core.sendGlobalEvent('mpAvatarApplied', { obj = self.object, id = input.id, seq = input.seq,
                    x = at.x, y = at.y, z = at.z })
            end
            -- Phase 4C: THE AVATAR SWINGS. The owner's use bit drives the attack control, and
            -- this engine computes the hit natively against the actors it simulates. Safe
            -- now because combat.lua no longer forwards a real swing while the peer holds
            -- the cell -- so a blow lands exactly once, here.
            self.controls.use = (useLatch or bit(input.flags, 3)) and 1 or 0
            -- ...BUT NOT WHILE STAGGERED (backlog 309). A body in hit recovery or on the floor
            -- cannot start a swing, so a latch consumed there was a tap lost for good. Hold it
            -- until the body can act; mp.isKnockedDown covers hit recovery too.
            if not (mp.isKnockedDown and mp.isKnockedDown(self.object)) then useLatch = false end
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
                    local base = name:match('^(.-)_damage$') -- identity.lua snapProgression
                    local a = types.Actor.stats.attributes[base or name]
                    if a and base then a(self).damage = v
                    elseif a then a(self).base = v end
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
            timed = (tonumber(data.simMs) or 0) > 0
            if timed then budget = math.min(budget + data.simMs / 1000, BUDGET_MAX) end
            if bit(data.flags, 2) then jumpLatch = true end
            if bit(data.flags, 3) then useLatch = true end
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
