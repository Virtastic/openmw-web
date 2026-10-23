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
local placed = false -- the WoW model: global.lua stands this body on its owner's poses (mpAvatarPolicy)
-- A PLACED BODY PAYS FOR ITS OWNER'S MOVEMENT. The engine charges fatigue for running, swimming,
-- sneaking (mwmechanics/character.cpp) and jumping (mwphysics/physicssystem.cpp) only to a body
-- that moves itself, and a placed one never does -- so the avatar's bar stayed full, and the 4 Hz
-- report (player.lua MP_SelfStats) refilled the owner's every time a jump or a sprint spent it
-- (prod 2026-10-23, 1.6.6). The same formulas, on the owner's input; fatigue stays the peer's,
-- where combat reads it. One table, not more locals.
local placedFatigue = {}
-- THE OWNER'S SWING, NOT JUST ITS BUTTON. A blow's strength is how long the body was wound up
-- when the use control let go (character.cpp), and a press that arrives while this body is still
-- in the last swing's follow-through starts the wind-up late: the owner's release then landed a
-- frame or two into it. Prod 2026-10-15..23: most avatar blows went out at strength 0 (16:00 on
-- the 23rd, 84 of 155) whatever the owner held. So a press is kept until this body actually winds
-- up, and the wind-up runs as long as the owner held the button (a tap stays a tap), capped.
local strike = { down = false, pressAt = 0, holdS = 0, pending = false, windupAt = nil, deadline = 0 }
strike.MAX_HOLD_S, strike.START_WAIT_S = 1.5, 2.0
function strike.input(useBit, now)
    if useBit and not strike.down then
        strike.down, strike.pressAt, strike.pending, strike.windupAt = true, now, true, nil
        strike.deadline = now + strike.START_WAIT_S
    elseif not useBit and strike.down then
        strike.down = false
        strike.holdS = math.min(strike.MAX_HOLD_S, now - strike.pressAt)
    end
end
-- `want` is what the raw input says this frame; returns whether use stays held.
function strike.hold(want, body, now)
    if not strike.pending then return want end
    if body == 'windup' and not strike.windupAt then strike.windupAt = now end
    if strike.down then return true end
    if not strike.windupAt then
        if now < strike.deadline then return true end -- not started yet: keep pressing
    elseif now - strike.windupAt < strike.holdS then
        return true -- wind up as long as the owner did
    end
    strike.pending = false
    return want
end
function placedFatigue.spend(loss)
    if not (loss and loss > 0) then return end
    pcall(function()
        local f = types.Actor.stats.dynamic.fatigue(self)
        -- the engine's setCurrent(cur - loss, cur < 0): a bar at or above zero stops at zero
        if f.current >= 0 then f.current = math.max(0, f.current - loss) end
    end)
end
function placedFatigue.encumbrance()
    local ok, e, c = pcall(function() return types.Actor.getEncumbrance(self), types.Actor.getCapacity(self) end)
    if not ok or not e or not c then return 0, false end
    return (c > 0 and e / c or 1), e > c -- getNormalizedEncumbrance; over capacity spends nothing
end
function placedFatigue.move(dt, move, side, run, sneak)
    local speed = math.min(1, math.sqrt((move or 0) ^ 2 + (side or 0) ^ 2))
    if speed <= 0 or not (dt and dt > 0) then return end
    local enc, over = placedFatigue.encumbrance()
    if over then return end
    local G = core.getGMST
    local okw, swim = pcall(types.Actor.isSwimming, self)
    local loss = 0
    if sneak then loss = G('fFatigueSneakBase') + enc * G('fFatigueSneakMult')
    elseif okw and swim then
        loss = run and (G('fFatigueSwimRunBase') + enc * G('fFatigueSwimRunMult'))
            or (G('fFatigueSwimWalkBase') + enc * G('fFatigueSwimWalkMult'))
    elseif run then loss = G('fFatigueRunBase') + enc * G('fFatigueRunMult') end
    placedFatigue.spend(loss * dt * speed)
end
function placedFatigue.jump()
    local enc = placedFatigue.encumbrance()
    placedFatigue.spend(core.getGMST('fFatigueJumpBase') + enc * core.getGMST('fFatigueJumpMult'))
end
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
local timed = false
local segs = {} -- {t = seconds left, d = the controls for them}, played in order
local SEGS_MAX_S = 0.5 -- a 200 ms hitch plus a burst behind it; beyond that the correction absorbs it
local SEGS_LAG_S = 0.1 -- queued beyond this, a standing segment is skipped rather than waited out
local lastDone = nil -- seq of the newest input whose time has been played in full
local prevTimed = nil -- the controls the NEXT input's time was spent under (see mpAvatarInput)
local sinceDone = util.vector3(0, 0, 0)
local frameDt, spendPrev, tailPrev, doneInPrev = 0, 0, 0, false
-- OWED: time this body kept moving under the newest input while the queue was dry, paid back
-- out of the next segments. A dry queue used to LOSE the rest of the frame, the time came in
-- later anyway, and during a continuous run the queue only grew until the cap dropped real
-- movement (s172 #159: the pose ~0.6 s behind, the owner corrected up to 100 u). Bounded: a
-- stop that arrives late overshoots by at most OWED_MAX_S of movement (0.25 overshot a stop by
-- 20 u in the replay; 0.15 keeps every pose within 8 u of the owner's ring and still cuts the
-- bursty-link lag from 0.44 s to 0.29 s).
local owed, OWED_MAX_S, owedDonePrev = 0, 0.15, 0
local motionSaidAt = nil -- the once-a-second motion line
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
-- A TIMED JUMP GOES WITH ITS SEGMENT, NOT WITH ITS ARRIVAL. It used to fire the frame the input
-- landed, i.e. ahead of the queued movement, from wherever the body was then -- and if that body
-- was still in the air from the previous hop (it lands when ITS physics says, not the owner's),
-- the engine ignored the jump outright. Hopping rock to rock the owner made each jump, the avatar
-- walked off the rock and fell (prod 2026-10-16: "fell 60" while the owner stood on the rocks),
-- and the owner was dragged back down: rubber-banding. Now the jump is due when its segment
-- starts playing and waits up to JUMP_HOLD_S for the body to be on the ground (or swimming);
-- past that it fires anyway.
-- 1.5 s, not 0.6: a chained hop keeps the body airborne longer than 0.6 s (the arc plus the
-- drop onto a lower rock), so the hold ran out mid-air, the engine ignored the jump, and the
-- avatar missed a hop the owner made (s191, Jenkins #232: 13 take-offs, 12 landings, a 263 u
-- self snap). Matches player.lua's HOP_S, the longest the owner treats as a hop.
local jumpDue, segJumpPrev = nil, false
local JUMP_HOLD_S = 1.5
local useWasOn, useProbeAt = false, nil
local useOnSince, useHeldSaidAt = nil, nil
local ownerSlots = {} -- slot -> record the owner holds there (MP_Equip); see rebindAmmo
local lastPushSaid = 'none' -- the last MP_Equip's slots, for the press probe
local function pressProbe(when)
    pcall(function()
        local ft = types.Actor.stats.dynamic.fatigue(self)
        local w = types.Actor.getEquipment(self, types.Actor.EQUIPMENT_SLOT.CarriedRight)
        -- attacking (the engine's copy of controls.use) must read FALSE at a press on a live body:
        -- the press is logged after a frame whose use was 0. TRUE at every press means the engine
        -- stopped applying this body's controls (#161 s118). body=none with a weapon drawn means
        -- the actor is not in the engine's actor list at all.
        local hp = types.Actor.stats.dynamic.health(self)
        -- THE QUIVER (s138: one arrow ever lands, then 40 releases loose nothing): what is
        -- equipped in the ammo slot, and how many of that record the pack holds in all.
        local am = types.Actor.getEquipment(self, types.Actor.EQUIPMENT_SLOT.Ammunition)
        local want = ownerSlots[types.Actor.EQUIPMENT_SLOT.Ammunition]
        local amTotal = (am or want) and types.Actor.inventory(self):countOf(am and am.recordId or want) or 0
        print(string.format('[mp] avatar use %s: attacking=%s body=%s dead=%s hp=%.0f staggered=%s stance=%s fatigue=%.0f/%.0f weapon=%s ammo=%s x%s of %s',
            when, tostring(mp.isAttacking and mp.isAttacking(self.object)), tostring(mp.upperBody and mp.upperBody(self.object)),
            tostring(types.Actor.isDead(self)), hp.current, tostring(mp.isKnockedDown and mp.isKnockedDown(self.object)),
            tostring(types.Actor.getStance(self)), ft.current, ft.base, w and w.recordId or 'none',
            am and am.recordId or 'none', am and tostring(am.count) or '0', tostring(amTotal))
            .. ' owner=' .. tostring(want) .. ' push=' .. lastPushSaid .. ' pack=' .. (function()
                local out = {}
                for _, it in ipairs(types.Actor.inventory(self):getAll()) do
                    if types.Weapon.objectIsInstance(it) then
                        local t = types.Weapon.record(it).type
                        if t == types.Weapon.TYPE.Arrow or t == types.Weapon.TYPE.Bolt then out[#out + 1] = it.recordId .. 'x' .. tostring(it.count) end
                    end
                end
                return #out > 0 and table.concat(out, ',') or 'no-ammo'
            end)())
    end)
end
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
-- THE QUIVER REFILLS ITSELF ON A PLAYER, NOT ON THIS BODY. The owner's copy only aims, so its
-- arrows never run down and the doc keeps granting the full count; this body spends its equipped
-- stack, the slot empties, and the reconciler's refill lands as a NEW stack nothing equips. The
-- engine re-equips ammo for the player character only, so an archer loosed one stack and then
-- dry-fired for good (s138: 41 releases, one arrow ever flew; probe: ammo=none at every press).
-- Thrown weapons are the same story in the right hand: the dart stack IS the weapon.
local ammoCheckAt = 0
local function rebindAmmo(now)
    if now < ammoCheckAt or next(ownerSlots) == nil then return end
    ammoCheckAt = now + 0.5
    pcall(function()
        local eq, changed = nil, false
        for slot, rid in pairs(ownerSlots) do
            local cur = types.Actor.getEquipment(self, slot)
            if not (cur and (cur.count or 0) > 0) then
                local best = nil
                for _, item in ipairs(types.Actor.inventory(self):getAll()) do
                    if item.recordId == rid and (not best or (item.count or 1) > (best.count or 1)) then best = item end
                end
                if best then
                    if not eq then eq = {}; for s, it in pairs(types.Actor.getEquipment(self)) do eq[s] = it end end
                    eq[slot] = best; changed = true
                end
            end
        end
        if changed then types.Actor.setEquipment(self, eq) end
    end)
end
local function equipTick(now)
    rebindAmmo(now)
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
            do
                local pos = self.position
                local step = lastPos and (pos - lastPos) or nil
                stepVel = (step and step:length() <= FRAME_STEP_MAX) and step or nil
                lastPos = pos
                -- How far the body has moved since the owner's last fully played input ended:
                -- last frame's step, split at the moment that input finished if it finished then.
                if not stepVel then
                    sinceDone = util.vector3(0, 0, 0) -- a teleport: the ring restarts there too
                elseif doneInPrev and spendPrev > 0 then
                    sinceDone = stepVel * ((tailPrev + owedDonePrev) / spendPrev)
                else
                    sinceDone = sinceDone + stepVel
                end
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
                segs, spendPrev, doneInPrev, owed, jumpDue = {}, 0, false, 0, nil
                stop()
                if keepUse then self.controls.use = 1 end
                return
            end
            -- MOVE FOR AS LONG AS THE OWNER DID, WITH WHAT THE OWNER DID THEN. A timed input
            -- (simMs > 0) is a SEGMENT: the seconds its owner actually simulated, and the controls
            -- for them. Each frame plays up to its own dt of the queue in order, the axes weighted
            -- by time. A hitch on the owner's side (their engine caps a frame at 200 ms of
            -- simulated time) therefore costs the avatar exactly the movement it cost the owner --
            -- it used to walk the whole wall-clock hitch and yank the owner forward after it.
            local ctl = input
            local moveAxis, sideAxis = input.move or 0, input.side or 0
            -- The pose read this frame is LAST frame's physics: pair it with the input that had
            -- finished by then, not with whatever this frame's spend finishes.
            local doneAtRead = lastDone
            if timed then
                local left, mSum, sSum, tail, done, owedDone = frameDt, 0, 0, 0, false, 0
                -- THE QUEUE ONLY EVER GREW. Each frame spends its own dt, so one peer hitch or a
                -- late burst of input was lag for every observer for good (s172 #158: the pose
                -- 1.15 s behind, the owner corrected 117 u). Time the owner spent STANDING moves
                -- nothing, so it is the lag that can be dropped: skipped, the body catches up.
                local backlog = 0
                for _, sg in ipairs(segs) do backlog = backlog + sg.t end
                while #segs > 1 and backlog > SEGS_LAG_S and (segs[1].d.move or 0) == 0 and (segs[1].d.side or 0) == 0 do
                    local s = table.remove(segs, 1)
                    backlog, ctl, lastDone, done = backlog - s.t, s.d, s.d.seq, true
                    if bit(s.d.flags, 2) then jumpDue = jumpDue or now end
                end
                while left > 0 and #segs > 0 do
                    local s = segs[1]
                    if not s.started then
                        s.started = true
                        -- the rising edge only: a key held over several inputs is one jump
                        local j = bit(s.d.flags, 2)
                        if j and not segJumpPrev then jumpDue = jumpDue or now end
                        segJumpPrev = j
                    end
                    local use = math.min(s.t, left)
                    mSum, sSum = mSum + (s.d.move or 0) * use, sSum + (s.d.side or 0) * use
                    left, s.t, ctl = left - use, s.t - use, s.d
                    if s.t <= 1e-6 then
                        table.remove(segs, 1)
                        lastDone, done, tail, owedDone = s.d.seq, true, 0, owed
                    else
                        tail = tail + use
                    end
                end
                -- Dry before the frame is spent: keep going under the newest input's controls (they
                -- are the next segment's) and owe the time.
                if left > 0 and owed < OWED_MAX_S and ((input.move or 0) ~= 0 or (input.side or 0) ~= 0) then
                    local e = math.min(left, OWED_MAX_S - owed)
                    mSum, sSum = mSum + (input.move or 0) * e, sSum + (input.side or 0) * e
                    left, owed, tail = left - e, owed + e, tail + e
                end
                moveAxis = frameDt > 0 and mSum / frameDt or 0
                sideAxis = frameDt > 0 and sSum / frameDt or 0
                spendPrev, tailPrev, doneInPrev, owedDonePrev = frameDt - left, tail, done, owedDone
            end
            -- ONCE A SECOND while the owner moves: what this body did with it (#167 s172: one leg
            -- with the avatar nearly a run speed short of its owner). Speed, run flag, backlog,
            -- owed: blocked, walking, or queued.
            if (input.move or 0) ~= 0 or (input.side or 0) ~= 0 then
                local nowS = core.getRealTime()
                if nowS - (motionSaidAt or 0) >= 1 then
                    motionSaidAt = nowS
                    local q = 0
                    for _, sg in ipairs(segs) do q = q + sg.t end
                    pcall(function()
                        print(string.format('[mp] avatar motion: speed=%.0f axis=%.2f run=%s backlog=%.2f owed=%.2f seq=%s',
                            stepVel and frameDt > 0 and stepVel:length() / frameDt or -1, moveAxis, tostring(bit(ctl.flags, 0)), q, owed, tostring(input.seq)))
                    end)
                end
            end
            -- PLACED, NOT WALKED (the WoW model): global.lua stands this body on every pose its
            -- owner's game sent, so the inputs only aim, swing and ready. Walking it as well would
            -- fight the placement and re-open the disagreement the placement removes.
            if placed then
                placedFatigue.move(frameDt, moveAxis, sideAxis, bit(ctl.flags, 0), bit(ctl.flags, 1))
                moveAxis, sideAxis = 0, 0
            end
            self.controls.movement = moveAxis
            self.controls.sideMovement = sideAxis
            local curYaw = self.rotation:getYaw()
            self.controls.yawChange = shortestArc((ctl.yaw or curYaw) - curYaw)
            -- PITCH TOO. The input has always carried it (radians, same scale as the pose) and
            -- the avatar never applied it, so it aimed level: an arrow at a cliff-top archer, or
            -- a swing at a rat underfoot, went out flat no matter where the owner was looking.
            local curPitch = self.rotation:getPitch()
            self.controls.pitchChange = (ctl.pitch or curPitch) - curPitch
            self.controls.run = bit(ctl.flags, 0)
            self.controls.sneak = bit(ctl.flags, 1)
            if placed then
                if jumpDue or jumpLatch then placedFatigue.jump() end -- a jump the owner's engine made
                self.controls.jump = false -- the owner's jump arrives as poses
                jumpDue, jumpLatch = nil, false
            elseif timed then
                local okg, onGround = pcall(types.Actor.isOnGround, self)
                local okw, swimming = pcall(types.Actor.isSwimming, self)
                local fire = jumpDue ~= nil and ((okg and onGround) or (okw and swimming) or now - jumpDue >= JUMP_HOLD_S)
                self.controls.jump = fire
                if fire then jumpDue = nil end
                jumpLatch, prevJump = false, false
            else
                local jump = jumpLatch or bit(input.flags, 2)
                jumpLatch = false
                self.controls.jump = jump and not prevJump
                prevJump = jump
            end
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
                local seq, at = input.seq, nil
                if timed then
                    -- EXACT: where this body stood when the owner's last fully played input ended
                    -- -- which is where the owner stood when that input's successor left
                    -- (player.lua ring[seq]).
                    seq = doneAtRead
                    at = pos - sinceDone
                else
                    local v = stepVel or util.vector3(0, 0, 0)
                    at = pos - v * ((frameNo - appliedFrame) + 0.5)
                end
                if seq then
                    core.sendGlobalEvent('mpAvatarApplied', { obj = self.object, id = input.id, seq = seq,
                        x = at.x, y = at.y, z = at.z })
                end
            end
            -- Phase 4C: THE AVATAR SWINGS. The owner's use bit drives the attack control, and
            -- this engine computes the hit natively against the actors it simulates. Safe
            -- now because combat.lua no longer forwards a real swing while the peer holds
            -- the cell -- so a blow lands exactly once, here.
            local body = mp.upperBody and mp.upperBody(self.object)
            self.controls.use = strike.hold(useLatch or bit(input.flags, 3), body, core.getRealTime()) and 1 or 0
            -- WHAT THE BODY WAS DOING WHEN THE PRESS CAME, and a moment later (#159 s157: every
            -- press reached the controls, 1 of 113 swings reached the hit test). On each rising
            -- edge of use, and once ~0.3 s after it: attacking, staggered, stance, fatigue, weapon.
            local useNow = self.controls.use == 1
            if useNow and not useWasOn then useProbeAt = core.getRealTime() + 0.3; useOnSince = core.getRealTime(); pressProbe('press') end
            if useProbeAt and core.getRealTime() >= useProbeAt then useProbeAt = nil; pressProbe('+0.3s') end
            -- THE FALLING EDGE, and a use held past 3 s (#178: NPC hp froze after ~10 landed blows;
            -- was the swing released, or held for good behind a latch while hit recovery kept the
            -- body 'knocked down'?). The release is what lands the blow.
            if useWasOn and not useNow then pressProbe('release') end
            if useNow and useOnSince and core.getRealTime() - useOnSince > 3 and core.getRealTime() - (useHeldSaidAt or 0) >= 1 then
                useHeldSaidAt = core.getRealTime()
                pressProbe('held ' .. string.format('%.0fs latch=%s bit=%s', core.getRealTime() - useOnSince, tostring(useLatch), tostring(bit(input.flags, 3))))
            end
            useWasOn = useNow
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
                        -- A restore carries its change (`g`, playerstate.ts): added to what the
                        -- body holds NOW, so a bite or a report in between is not undone (s165).
                        if d.g then stat.current = math.max(0, math.min(stat.base, stat.current + d.g))
                        elseif d.c then stat.current = d.c end
                    end
                end
            end)
            if not okL then print('[mp] avatar stats apply failed: ' .. tostring(errL)) end
        end,
        MP_Equip = function(data)
            local slots = {}
            for slot, id in pairs(data.slots or {}) do slots[tonumber(slot) or slot] = id end
            pendingEquip = slots
            local said = {}
            for s, id in pairs(slots) do said[#said + 1] = tostring(s) .. '=' .. tostring(id) end
            lastPushSaid = table.concat(said, ';')
            print('[mp] avatar equip push: ' .. lastPushSaid)
            -- What the owner holds in the slots this body can spend empty (rebindAmmo).
            ownerSlots = {}
            for _, s in ipairs({ types.Actor.EQUIPMENT_SLOT.Ammunition, types.Actor.EQUIPMENT_SLOT.CarriedRight }) do
                if type(slots[s]) == 'string' then ownerSlots[s] = slots[s] end
            end
            equipRetryUntil = core.getRealTime() + 3
        end,
        mpAvatarPolicy = function(data)
            if data.pvp ~= nil then pvpEnabled = data.pvp == true end
            if data.placed ~= nil then placed = data.placed == true end
            if type(data.avatarObjIds) == 'table' then avatarObjIds = data.avatarObjIds end
        end,
        mpAvatarInput = function(data)
            -- Stale-drop on the input's own seq: UDP-like reordering cannot happen on one
            -- socket, but the server may resend and the hold logic wants monotonicity.
            if input and data.seq and input.seq and data.seq <= input.seq then return end
            input = data
            inputAt = core.getRealTime()
            timed = (tonumber(data.simMs) or 0) > 0
            if timed then
                -- Input N carries the time the owner simulated since input N-1 left, and that time
                -- ran under N-1's controls (the owner records ring[N] before N's controls act). So
                -- the segment is N's time with N-1's controls; played out, the body is at ring[N].
                local ctl = prevTimed or { move = 0, side = 0, yaw = data.yaw, pitch = data.pitch, flags = 0 }
                segs[#segs + 1] = { t = data.simMs / 1000, d = { seq = data.seq, move = ctl.move, side = ctl.side,
                    yaw = ctl.yaw, pitch = ctl.pitch, flags = ctl.flags } }
                prevTimed = data
                -- Time already moved ahead of the queue pays this segment down first.
                local sg = segs[#segs]
                local pay = math.min(owed, sg.t)
                sg.t, owed = sg.t - pay, owed - pay
                local total = 0
                for _, sg in ipairs(segs) do total = total + sg.t end
                while total > SEGS_MAX_S and #segs > 1 do
                    total = total - segs[1].t
                    lastDone = segs[1].d.seq
                    if not segs[1].started and bit(segs[1].d.flags, 2) then jumpDue = jumpDue or core.getRealTime() end
                    table.remove(segs, 1)
                end
            end
            if bit(data.flags, 2) and not timed then jumpLatch = true end
            if bit(data.flags, 3) then useLatch = true end
            strike.input(bit(data.flags, 3), core.getRealTime())
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
