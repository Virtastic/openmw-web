-- Puppet (M1 players + M4 shared NPCs): controls-driven remote actor.
-- Attached by global.lua via obj:addScript('scripts/mp/puppet.lua', {playerId=<u16>}) for
-- remote PLAYERS, or {actorKey=<refKey>} for cell NPCs when this client is NOT the cell's
-- authority holder. Consumes MP_Pose events (routed per-puppet from MP_MoveBatch /
-- ActorMoveBatch) into an interpolation buffer and STEERS toward the 100 ms-delayed target
-- through self.controls — the engine's own movement solver drives animation/collision, so
-- puppets walk/run/jump like real actors instead of gliding between set positions. On
-- divergence it asks global.lua for a teleport via mpSnapRequest.
local core = require('openmw.core')
local rxMirrorAt = 0 -- the puppetRx debug mirror, rate-limited
local self = require('openmw.self')
local types = require('openmw.types')
local I = require('openmw.interfaces')
-- openmw.mp is available in LOCAL scripts too (luabindings.cpp registers it for every context);
-- puppet.lua needs it only for setPuppet, which is why it was not imported before.
local mp = require('openmw.mp')

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
-- Near tier 256, not 128: on a lossy link any stall >= 350 ms at run speed crossed 128 and
-- the puppet teleported at every 1 s cooldown (#211).
local SNAP_BY_TIER = { [0] = 256, [1] = 1024, [2] = 2048 }
local SNAP_COOLDOWN_BY_TIER = { [0] = 1.0, [1] = 2.0, [2] = 3.0 }
local SNAP_DISTANCE = 256 -- near-tier divergence before asking for a teleport (legacy name)
local RUN_HOLD_S = 0.3 -- keep the run flag this long after the target stops advancing (#211: anim popping per burst)
local runUntil = 0
local STUCK_SECONDS = 0.7 -- commanded to move but no progress this long -> snap
-- WEDGED, NOT FROZEN. "No progress" used to mean "moved under 1 unit", and a body that is
-- swimming (it bobs) or scraping along a ledge moves a few units every frame without ever
-- arriving: a friend's copy ran in place at a shoreline 130-250 u from where they really
-- stood, for 20 s, under the 256 u snap and exempt from the far-gap snap (players are), while
-- their own screen had them at the mudcrab (two-browser capture, 2026-10-19). Judged over a
-- window instead: steering more than WEDGE_GAP off and covering under WEDGE_MIN_MOVE in
-- WEDGE_S (a steered puppet that far off runs at well over 150 u/s), or -- the target standing
-- -- not closing the gap by WEDGE_MIN_CLOSE in that time. Either is a body that cannot get
-- there by walking; it is put there. (Player puppets: NPCs and creatures have the far-gap snap.)
local WEDGE_GAP = 48
local WEDGE_S = 1.0
local WEDGE_MIN_MOVE = 24
local WEDGE_MIN_CLOSE = 16
local wedgeAt, wedgePos, wedgeGap = nil, nil, nil
local wedgeSeen = nil -- last frame the check ran: a skipped frame (parked, far tier, snapped) restarts the window
-- A GAP THAT WILL NOT CLOSE IS A SNAP, moving or not (s120/s157 #175-#179: a fighting NPC's puppet sat
-- 260 u from the peer's real NPC, under the 256 u distance snap, swaying enough that the stuck detector
-- (which only sees a body that does not move) never fired; the player swung at where they saw her and
-- the peer's blows landed on air). Beyond FAR_GAP for FAR_SNAP_S straight -> ask for the position.
local FAR_GAP = 128
local FAR_SNAP_S = 2.0
local farSince = nil
local IDLE_TIMEOUT = 1.0 -- no snapshots this long -> stand still
local SNAP_COOLDOWN = 1.0 -- let a requested teleport land before asking again

-- TELL THE ENGINE THIS ACTOR'S DAMAGE IS NOT OURS TO APPLY.
--
-- Melee already routes correctly because the engine hands damage application to Lua (the `Hit`
-- event) and onHitIntercept below cancels it. MAGIC does not: mwmechanics/spelleffects.cpp
-- applies harmful effects itself in C++, and its only Lua notification is queued and returns
-- void, so nothing could veto it. Spell damage therefore never travelled — the caster's client
-- damaged its own puppet copy and the owner never heard, so the health bar flickered and
-- reverted on the next stats push.
--
-- mp.setPuppet marks this actor in a registry the damage site queries synchronously
-- (mwmp/puppets.hpp). Marked, the engine skips its local application and records the effect for
-- global.lua to forward to whoever owns the actor.
local playerId = nil -- set for remote-player puppets (declared here: markPuppet reads it)
local function markPuppet(on)
    if not mp.setPuppet then
        if mp.set then mp.set('puppetMark', 'no-binding') end
        return
    end
    local ok, err = pcall(function() mp.setPuppet(self.object, on) end)
    -- A PLAYER's body, not an NPC's (backlog 342): the crime/witness/sneak exemptions ask the
    -- registry rather than guessing from "no content file". setPuppet(false) unmarks both.
    if ok and on and playerId ~= nil and mp.setPlayerPuppet then
        pcall(function() mp.setPlayerPuppet(self.object, true) end)
    end
    if mp.set then
        mp.set('puppetMark', ok and (on and 'marked' or 'unmarked') or ('failed:' .. tostring(err)))
    end
end

local actorKey = nil -- set for M4 NPC puppets (refKey the holder addresses)
-- DEGRADED (backlog 328): the peer is gone, this actor's own AI is back on, and the script
-- stays attached with the hit intercept armed, so a swing during the outage cancels exactly
-- as it does with a holder. Degraded mode is cosmetic: without it an outage kill was a
-- permanent per-screen divergence (alive for B, a lootable corpse for A, counted nowhere).
-- degradedKey remembers the address so the first pose after the peer returns re-arms.
local degraded = false
local degradedKey = nil
-- Backlog 310: the last local swing at this puppet; the stats drop it caused plays the feel.
local lastSwingAt, lastSwingPos, lastPunchSoundAt = 0, nil, 0
local SWING_FEEL_WINDOW_S = 1.0
local interp = Interp.new()
local lastSnapReq = 0
-- Steering hysteresis. STEER_START must stay comfortably above the distance a puppet can
-- cover in one frame at run speed, or stopping and starting chatter across the boundary and
-- the actor jitters on the spot.
local STEER_STOP = 4    -- within this, hold position and just face the right way
local STEER_START = 24  -- must have drifted this far before steering resumes
local steering = false
local stuckSince = nil
-- Has this puppet been PUT on its authoritative position yet, as opposed to having walked
-- toward it? Until the peer took this cell the engine's own AI was driving this actor, so at
-- attach it stands wherever that left it — anywhere up to the tier's snap threshold (128
-- units near) away from where the server says it is. Steering that gap instead of closing it
-- is what players see as an NPC twitching on the spot for a second before it "starts
-- working": the steer/hold boundary is 4 units, and a target that keeps moving pushes the
-- actor back and forth across it. The first target after attach therefore TELEPORTS, at any
-- distance; every later correction keeps the existing distance and cooldown rules.
local placed = false
local lastProgressPos = nil
-- EVERY JUMP THE RENDER TIME PASSED, not the one sample a frame lands on. A jump rides ONE pose
-- (bit 2, ~66 ms of render time); read off the target once a frame, a client under 15 fps (9%
-- of prod telemetry windows, 2026-10) stepped over it and the friend never left the ground.
-- Each sample is marked once render time has passed it, NOT compared with the last scanned time:
-- interp.lua stamps a sample after a pause at last.t + mean (pulled toward arrival), which can be
-- BEHIND what was already scanned -- a friend who stood still for 0.3 s and jumped never left
-- the ground.
local jumpPrimed = false -- the first scan only marks: history is not played late
-- The use bit's edges AS RECEIVED, latched until a frame plays them (s171). A creature's bite
-- holds the bit for ONE peer frame (50 ms); read off the render-delayed target once per client
-- frame, that pulse fell between frames on any client under 20 fps and the rat bit the player
-- to death standing idle. Every pose is seen here, so no edge is lost to the frame rate.
local rxUse, pressLatch, releaseLatch = false, false, false

-- A SWING YOU CAN SEE. The pose stream carries the owner's use bit, and nothing here drew a
-- swing: a friend fighting beside you stood with the weapon out and the enemy took damage
-- from a statue. Setting controls.use would run this engine's real hit chain -- and land a
-- blow on the LOCAL player, who the peer is already hitting on the owner's behalf -- so this
-- is animation only, the same way MP_CastFx mirrors a cast. The group follows the weapon
-- in the right hand; hand-to-hand when there is none.
local SWING_GROUP_OF_TYPE = {
    ShortBladeOneHand = 'weapononehand', LongBladeOneHand = 'weapononehand',
    BluntOneHand = 'weapononehand', AxeOneHand = 'weapononehand',
    LongBladeTwoHand = 'weapontwohand', BluntTwoClose = 'weapontwohand', AxeTwoHand = 'weapontwohand',
    BluntTwoWide = 'weapontwowide', SpearTwoWide = 'weapontwowide',
    MarksmanBow = 'bowandarrow', MarksmanCrossbow = 'crossbow', MarksmanThrown = 'throwweapon',
}
-- Two halves, on the two edges of the owner's use bit: the wind-up on the PRESS (held at
-- 'min attack' until released), the blow on the RELEASE. Played as one clip on release the
-- wind-up began after the enemy had already taken the damage. In the spell stance the hands
-- glow instead of a weapon swinging (MP_CastFx adds the sound and the casting vfx).
-- `full`: press and release landed in one frame (a creature's bite always does): the whole blow.
-- PLAYBLENDED, NOT PLAYBLENDEDANIMATION. openmw.animation binds `playBlended(self, group, opts)`
-- (mwlua/animationbindings.cpp); playBlendedAnimation is the I.AnimationController wrapper's
-- name, and on the package it is nil. Every call here threw inside its pcall: no swing, bite,
-- cast pose or flinch ever played on a puppet, and the swish/blood after them never ran.
-- WHAT A FRIEND'S SWING LOOKS LIKE ON THIS SCREEN, measured. The clients could not report their
-- animation, so every fight scenario checked the use bit and the damage and none checked the
-- picture: the launch video (2026-10-20) shows a friend's sword held overhead through a whole
-- fight, the wind-up never followed by the blow, with every scenario green. One console line a
-- fixed time after each half: the group played, what the right arm is running and how far in,
-- and where the wind-up stops -- a blow that played is past that point, then back to idle.
local swingGroup, swingKind = nil, 'chop'
local swingProbes = {}
-- THE BLOW IS TWO SECTIONS, NOT ONE RANGE. A weapon group keeps chop, slash and thrust one after
-- another, and each attack's three follow-throughs (large, medium, small) back to back: in
-- WeaponOneHand, Chop Max Attack 316.333, Chop Hit 316.733, then Large/Medium/Small Follow
-- 316.8-317.933 (xbase_anim.kf). Played as one range to Small Follow Stop, a friend's blow ran 1.6 s
-- through all three recoveries (s194, Jenkins #254). The engine strikes to the hit, then jumps to
-- one follow section (character.cpp); so does this: the follow is queued for when the strike ends.
local followAt, followGroup = nil, nil
local function probeSwing(label)
    pcall(function()
        local anim = require('openmw.animation')
        local active = anim.getActiveGroup(self, anim.BONE_GROUP.RightArm)
        local t = active and anim.getCurrentTime(self, active)
        local stop = swingGroup and anim.getTextKeyTime(self, swingGroup .. ': ' .. swingKind .. ' min attack')
        print(string.format('[mp] swing probe %s group=%s active=%s time=%s windupStop=%s', label,
            tostring(swingGroup), tostring(active), t and string.format('%.3f', t) or 'nil',
            stop and string.format('%.3f', stop) or 'nil'))
    end)
end
-- A RUNNING GROUP IS NOT RESTARTED BY PLAYING IT AGAIN. Animation::play on a group already in its
-- state map only updates the priority and returns (mwrender/animation.cpp): the wind-up, held at
-- 'chop min attack' (autoDisable = false), kept the group alive, so the blow asked for the same
-- group, the engine kept the wind-up, and a friend's sword stayed raised through a whole fight
-- (launch video 2026-10-20). The engine's own attacks disable the group before each section
-- (character.cpp); so does every swing here.
-- ONE STEP ABOVE THE ENGINE'S OWN WEAPON STATE, NEVER EQUAL TO IT. A biped's weapon animations
-- (draw, idle1h & co, its own attacks) run at Weapon on the upper body and WeaponLowerBody on the
-- legs (character.cpp priorityWeapon), and Animation::play ERASES every other group of an equal
-- priority: at that pair the swing deleted the character's weapon idle until the engine next
-- refreshed it. At Block on the arms and torso the swing shows over the idle and leaves it in
-- place; the legs stay at WeaponLowerBody, under the walk (s120). (The frozen half-turn after a
-- blow was the yaw steering, YAW_DEADBAND.)
local function swingPriority(anim)
    local P, G = anim.PRIORITY, anim.BONE_GROUP
    local up = P.Block or P.Weapon
    return { [G.LowerBody] = P.WeaponLowerBody, [G.Torso] = up, [G.LeftArm] = up, [G.RightArm] = up }
end
local function playFresh(anim, group, opts)
    pcall(anim.cancel, self, group)
    anim.playBlended(self, group, opts)
end
local function showSwing(release, full)
    pcall(function()
        local anim = require('openmw.animation')
        -- THE LEGS STAY THE WALK'S (s120). An all-groups Weapon clip owns the lower body, and an
        -- NPC's movement comes from its legs' animation: a puppet showing its owner's swings stood
        -- still ~90% of a fight while the real NPC strafed on, 150-250 u away. The engine plays
        -- a biped's attack at WeaponLowerBody on the legs (character.cpp); so do we.
        local pri = swingPriority(anim)
        if types.Actor.getStance(self) == types.Actor.STANCE.Spell then
            if not release or full then
                playFresh(anim, 'spellcast', {
                    priority = pri, startKey = 'self start', stopKey = 'self stop' })
            end
            return
        end
        -- A creature has no weapon group: it bites with attack1..3 (keys 'start' / 'max
        -- attack' / 'stop', no chop/slash prefix). Any of the three it has, at random, as the
        -- holder's engine picks (#288).
        if types.Creature.objectIsInstance(self) then
            local groups = {}
            for i = 1, 3 do if anim.hasGroup(self, 'attack' .. i) then groups[#groups + 1] = 'attack' .. i end end
            if #groups == 0 then return end
            -- THE WHOLE BITE ON THE PRESS (s171). A creature's use bit is up for ONE peer frame:
            -- its AI never holds an attack, so the release follows 50 ms later. Played as two
            -- halves, the lunge (start -> max attack) was cut after a frame by the recovery
            -- (max attack -> stop), and all a player saw of a rat's bite was it flinching back.
            -- The peer's creature starts its whole attack on the press too.
            if release and not full then return end
            local group = groups[math.random(#groups)]
            playFresh(anim, group, { priority = anim.PRIORITY.Weapon, startKey = 'start', stopKey = 'stop' })
            return
        end
        local group = 'handtohand'
        local weapon = types.Actor.getEquipment(self, types.Actor.EQUIPMENT_SLOT.CarriedRight)
        if weapon and types.Weapon.objectIsInstance(weapon) then
            local rec = types.Weapon.record(weapon)
            for name, t in pairs(types.Weapon.TYPE) do
                if rec and rec.type == t and SWING_GROUP_OF_TYPE[name] then group = SWING_GROUP_OF_TYPE[name] end
            end
        end
        local ranged = group == 'bowandarrow' or group == 'crossbow' or group == 'throwweapon'
        local kind = ranged and 'shoot' or 'chop'
        swingGroup, swingKind = group, kind
        if release then
            local startKey = kind .. (full and ' start' or ' max attack')
            if ranged then
                playFresh(anim, group, { priority = pri, startKey = startKey, stopKey = 'shoot release' })
            else
                playFresh(anim, group, { priority = pri, startKey = startKey, stopKey = 'chop hit' })
                -- The follow section once the strike has run, timed off the group's own keys.
                local a = anim.getTextKeyTime and anim.getTextKeyTime(self, group .. ': ' .. startKey)
                local b = anim.getTextKeyTime and anim.getTextKeyTime(self, group .. ': chop hit')
                followAt = core.getRealTime() + ((a and b and b > a) and (b - a) or (full and 0.8 or 0.4))
                followGroup = group
            end
            core.sound.playSound3d('Weapon Swish', self)
        else
            followAt = nil -- a new wind-up: the last blow's recovery is not played over it
            playFresh(anim, group, {
                priority = pri,
                startKey = kind .. ' start',
                stopKey = kind .. ' min attack',
                autoDisable = false, -- hold the wind-up until the release plays the blow
            })
        end
    end)
end
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

local function requestSnap(target, why, force)
    local now = core.getRealTime()
    -- `force` skips the cooldown for the first placement only (see placed, below): there is
    -- no previous teleport to let land, and losing this one to a cooldown left over from a
    -- past life of this script is exactly the case we cannot afford to miss.
    if not force and now - lastSnapReq < (SNAP_COOLDOWN_BY_TIER[tier] or SNAP_COOLDOWN) then return end
    lastSnapReq = now
    -- obj: WHICH body is asking (480). The id alone named whichever body global.lua
    -- currently tracks for this player, and that is not always this one: a despawn while a
    -- teleport is in flight cannot remove the body (count 0), so this script lived on, its
    -- stale target 16k units away, and every snap it asked for was applied to the successor.
    core.sendGlobalEvent('mpSnapRequest',
        { id = playerId, actorKey = actorKey, obj = self.object, x = target.x, y = target.y, z = target.z, yaw = target.yaw, why = why })
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
    if attack.mpTest then
        print(string.format('[mp] puppet intercept: %s key=%s pid=%s', tostring(self.object.recordId),
            tostring(actorKey), tostring(playerId)))
    end
    if degraded then return false end -- nobody simulates: the swing cancels, lands nowhere
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
        mpTest = attack.mpTest == true, -- Phase 4C: test-hook hits always ride the relay
    })
    -- THE FEEL OF THE BLOW is NOT this roll's to give (backlog 310): the local swing and the
    -- avatar's on the peer are independent rolls, so a hit sound here was a coin flip against
    -- what actually landed, and a bare-handed hit (fatigue only) played 'miss'. Remember the
    -- swing; the MP_Stats drop that follows plays the sound (and the blood, at this position).
    lastSwingAt = core.getRealTime()
    lastSwingPos = attack.hitPos
    -- ...EXCEPT A PUNCH, WHICH THIS ENGINE HAS ALREADY VOICED. getHandToHandDamage (combat.cpp)
    -- plays 'Hand To Hand Hit' before the hit reaches this handler, so the fatigue drop's punch
    -- below played it a second time: every bare-handed blow sounded twice (prod 2026-10-23).
    if not weapon and attack.successful and attack.damage and attack.damage.fatigue then lastPunchSoundAt = lastSwingAt end
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

-- SPELL DAMAGE THE ENGINE HANDED BACK TO US.
--
-- Marked as a puppet, the C++ damage site skips its local application and parks the effect
-- (mwmp/puppets.hpp). Drain ours each frame and forward on the same route melee takes — the
-- global script owns the socket, so it sends. Without this, spell damage simply vanished:
-- applied to our local copy, never told to the owner, reverted on the next stats push.
local PASSIVE = {}
local SPELL_TYPE = (core.magic and core.magic.SPELL_TYPE) or {}
for _, k in ipairs({ 'Ability', 'Disease', 'Blight', 'Curse' }) do
    local v = SPELL_TYPE[k]
    if v ~= nil then PASSIVE[v] = true end
end
local function passiveSpell(id)
    if type(id) ~= 'string' or id == '' then return false end
    local ok, rec = pcall(function() return core.magic.spells.records[id] end)
    return ok and rec ~= nil and PASSIVE[rec.type] == true
end

local function forwardMagicHits()
    if not (playerId or actorKey) then return end
    if not mp.takeMagicHits then return end
    local ok, hits = pcall(mp.takeMagicHits, self.object) -- no closure a frame (#159 s177)
    if not ok then
        if mp.set then mp.set('magicFwd', 'take-failed:' .. tostring(hits)) end
        return
    end
    if not hits or #hits == 0 then return end
    if mp.set then mp.set('magicFwd', 'drained:' .. tostring(#hits)) end
    -- Per hit: the record's effect INDEX (the owner applies only the effects that hit, not
    -- the whole record -- backlog 250) and its own beneficial word. The cast as a whole is
    -- beneficial only when EVERY hit is: an OR let one Restore ride a Fire Damage past the
    -- PvP veto (backlog 249). combat.lua drops the harmful indexes under PvP off.
    local effects, spellId, beneficial, ignoreReflect = {}, nil, true, false
    for _, h in ipairs(hits) do
        -- THE ACTOR'S OWN SPELLS ARE NOT HITS. An ability, disease, blight or curse is applied
        -- to the puppet when it loads (a racial Resist Fire, a diseased kagouti's Yellow Tick)
        -- and parks here like a cast -- prod 2026-10-14: every one forwarded, every one refused
        -- "spell not known to the caster". Nobody casts those at anyone.
        if not passiveSpell(h.spellId) then
            local one = { id = tostring(h.effectId), magnitude = h.magnitude or 0, duration = 0,
                beneficial = h.beneficial == true }
            if type(h.index) == 'number' and h.index >= 0 then one.index = h.index end
            effects[#effects + 1] = one
            spellId = spellId or (h.spellId ~= '' and h.spellId or nil)
            -- A helper's heal on a friend: forwarded like damage, but it must cross the PvP veto
            -- (which stops harm, not help) and apply as a restore on the owner's avatar.
            if h.beneficial ~= true then beneficial = false end
            -- A reflection landing on the caster's puppet: the owner applies it without rolling
            -- Reflect again, or two Reflect-wearers volley one spell forever (backlog 254).
            if h.reflected == true then ignoreReflect = true end
        end
    end
    if #effects == 0 then return end
    core.sendGlobalEvent('mpCombatSpellHit', {
        victim = self.object,
        playerId = playerId,
        effects = effects,
        spellId = spellId,
        beneficial = beneficial,
        ignoreReflect = ignoreReflect,
    })
end

-- THE TARGET'S OWN SPEED, PLUS THE GAP (s171). Proportional-only (dist / 96) made a puppet trail
-- by 96 u x (its speed / its top speed) before it moved at full pace: a charging creature's
-- puppet sat 110-150 u behind the peer's and crept the last stretch at a quarter walk -- "they
-- move slowly towards me". Feed the target's velocity forward and close what is left in CATCHUP_S.
-- The catch-up never covers more than the gap in one frame (s117): divided by max(CATCHUP_S, dt),
-- or a 200 ms hitch stepped 1.3x the gap, overshot, and a companion circled its stopped target.
local CATCHUP_S = 0.15
-- A PUPPET MAY RUN A LITTLE FASTER THAN ITS OWNER, or a gap on a running target is never closed:
-- capped at 1 x run speed it kept every stall, start and turn it lost until the owner stopped
-- (s172 #161: 91 u behind at p50 while the wire was 14). The engine honours up to this factor
-- for puppets only (character.cpp).
local PUPPET_MAX_SPEED = 1.25
local YAW_DEADBAND = 0.02 -- rad, ~1.1 degrees: below it a puppet is facing, not turning

local function onUpdate(dt)
    ensureHitHandler()
    forwardMagicHits()
    if dt <= 0 or (not playerId and not actorKey) then return end
    if dead then
        zeroControls()
        pressLatch, releaseLatch = false, false
        return
    end
    -- The swing first: nothing below (a snap, a far tier, a parked puppet) may swallow it.
    local now = core.getRealTime()
    if pressLatch or releaseLatch then
        showSwing(releaseLatch, pressLatch and releaseLatch)
        if releaseLatch then
            swingProbes = { { at = now + 0.25, label = 'blow+0.25' }, { at = now + 1.5, label = 'blow+1.5' } }
        else
            swingProbes = { { at = now + 0.4, label = 'windup+0.4' } }
        end
        pressLatch, releaseLatch = false, false
    end
    if followAt and now >= followAt then
        followAt = nil
        pcall(function()
            local anim = require('openmw.animation')
            -- SMALL follow: the sections exist as small/medium/large only (character.cpp picks one
            -- by attack strength); a size-less key is in no retail weapon group (s172).
            playFresh(anim, followGroup, {
                priority = swingPriority(anim),
                startKey = 'chop small follow start', stopKey = 'chop small follow stop' })
        end)
    end
    while swingProbes[1] and now >= swingProbes[1].at do probeSwing(table.remove(swingProbes, 1).label) end
    equipTick(now)
    -- IDLE MEANS "NOTHING NEW TO CHASE", NOT "STOP WHERE YOU STAND".
    --
    -- The server only relays a pose when it CHANGES, so a player who stops walking stops
    -- generating updates. The puppet is always behind by RENDER_DELAY plus whatever of the
    -- approach it has not walked off yet -- so parking it the moment the stream goes quiet
    -- abandons it wherever it happened to be, permanently, until that player moves again.
    --
    -- Measured (s69, with the peer killed so the stream is purely the walker's own): the
    -- walker moved 102 units, the puppet received the final pose correctly, walked 17 of
    -- those units, and stopped 85 short. It reads as "the world froze" and it is really
    -- "the puppet gave up mid-stride". The same shortfall happens in ordinary play at the
    -- end of every walk; a live peer just hides it by streaming continuously.
    --
    -- So: an idle stream still lets the puppet FINISH closing on the newest pose it has,
    -- and parks it once it arrives. Walking off into nowhere is not a risk -- the target is
    -- fixed once the stream stops -- and a puppet wedged on geometry is still rescued by the
    -- stuck detector below.
    local newest = interp:newestTime()
    if not newest then
        zeroControls()
        stuckSince = nil
        return
    end
    local idle = now - newest > IDLE_TIMEOUT
    local target = interp:target(now)
    if not target then
        zeroControls()
        return
    end
    -- Scanned before any early return, so a jump passed while parked, snapped or far-tiered is
    -- dropped (as it always was), never played late.
    local rt, jumped = now - interp:delay(), false
    for _, s in ipairs(interp.buf) do
        if not s.jumpSeen and s.t <= rt then
            s.jumpSeen = true
            if jumpPrimed and bit(s.flags, 2) then jumped = true end
        end
    end
    jumpPrimed = true

    local pos = self.position
    local dx, dy = target.x - pos.x, target.y - pos.y
    local dz = target.z - pos.z
    local dist2d = math.sqrt(dx * dx + dy * dy)
    local dist3d = math.sqrt(dx * dx + dy * dy + dz * dz)

    -- First placement after attach: teleport onto the authoritative position rather than
    -- walking to it. Distance-independent on purpose — the common case is a SMALL gap, which
    -- is precisely the one the distance rule below would let through to the steering code.
    if not placed then
        placed = true
        requestSnap(target, 'attach', true)
        zeroControls()
        return
    end

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
        farSince = nil
        return
    end

    -- Arrived, and nothing new is coming: park. (Still approaching on an idle stream falls
    -- through to the steering below -- see the IDLE note above.)
    if idle and dist2d <= STEER_STOP then
        zeroControls()
        stuckSince = nil
        farSince = nil
        return
    end

    -- HYSTERESIS, not bang-bang at a 4-unit line. This used to be "further than 4 units? full
    -- speed toward it, otherwise stop". At run speed a single frame covers well over 4 units,
    -- so the puppet shot PAST its target, the bearing flipped ~180 degrees, and it sprinted
    -- back — then past again. That is the walk-forward-spin-around-walk-backward players see,
    -- and it never settles because the target keeps advancing into the same overshoot.
    -- ...BUT A MOVING TARGET IS KEPT PACE WITH, not caught and dropped: with a speed margin the
    -- copy reached STEER_STOP, stopped, and waited for the owner to open STEER_START again --
    -- a stop-start every ~170 ms at a walk, 14 u behind on average, and a visible stutter (s172
    -- #172: a friend 75 u behind at p50 while the wire was 27). Standing targets keep the
    -- hysteresis, so the overshoot-and-spin it cured stays cured.
    local tgtV = interp:speed(now)
    if steering and dist2d <= STEER_STOP and tgtV < 20 then steering = false end
    if not steering and (dist2d >= STEER_START or (tgtV >= 20 and dist2d > STEER_STOP)) then steering = true end

    if actorKey ~= nil and dist2d > FAR_GAP then -- NPC/creature puppets only: a friend on a slow link legitimately trails farther, and a pop there is worse than the lag (s172 #180: 5 snaps)
        farSince = farSince or now
        if now - farSince > FAR_SNAP_S then
            print(string.format('[mp] puppet far-gap snap: %.0f u off for %.1f s (%s)', dist2d, now - farSince, tostring(actorKey or playerId)))
            requestSnap(target, 'far')
            farSince = nil
        end
    else
        farSince = nil
    end

    -- Stuck: steering toward a moving target without progressing (wedged on geometry). Only
    -- meaningful while we are actually STEERING — with hysteresis a puppet legitimately holds
    -- still anywhere below STEER_START, and counting that as "wedged" fires a teleport at a
    -- puppet that is behaving exactly as intended.
    if steering and dist2d > 16 then
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

    -- Wedged (see WEDGE_GAP): the window restarts whenever the body is not steering a real gap.
    if wedgeSeen and now - wedgeSeen > 0.25 then wedgeAt = nil end
    wedgeSeen = now
    -- PLAYERS: NPC and creature puppets have the far-gap snap above (128 u for 2 s); a friend's
    -- copy is exempt from it, and that exemption is exactly where a wedged body was left alone.
    if actorKey == nil and steering and dist2d > WEDGE_GAP then
        if not wedgeAt then
            wedgeAt, wedgePos, wedgeGap = now, pos, dist2d
        elseif now - wedgeAt >= WEDGE_S then
            local moved = (pos - wedgePos):length()
            local closed = wedgeGap - dist2d
            if moved < WEDGE_MIN_MOVE or (tgtV < 20 and closed < WEDGE_MIN_CLOSE) then
                print(string.format('[mp] puppet wedged: %.0f u off, moved %.0f u, closed %.0f u in %.1f s (%s)',
                    dist2d, moved, closed, now - wedgeAt, tostring(actorKey or playerId)))
                requestSnap(target, 'wedged')
            end
            wedgeAt, wedgePos, wedgeGap = now, pos, dist2d
        end
    else
        wedgeAt, wedgePos, wedgeGap = nil, nil, nil
    end

    local curYaw = self.rotation:getYaw()
    -- Mirror the remote actor's run flag while steering. The speed below is a fraction of the
    -- top speed this picks, so a run no longer overshoots a small correction (it used to be
    -- withheld inside STEER_START, which left a charging creature's puppet walking).
    -- ...and a puppet left well behind runs to catch up: a walk that cannot close the gap ends
    -- in the far-gap teleport (s190).
    local run = (bit(target.flags, 0) and (steering or tgtV >= 20)) or (steering and dist2d > 48)
    if run then runUntil = now + RUN_HOLD_S end
    self.controls.run = run or now < runUntil
    -- AHEAD OF A WALKING TARGET: DO NOT TURN AROUND. Steering at the target point from in front
    -- of it means a bearing ~180 degrees off the way the NPC is walking: the puppet spun round,
    -- stood (movement is zero past 60 degrees), the target passed, it spun back -- NPCs "doing
    -- 180s as they walk" (prod 2026-10-14, positions 1-3 u off the whole time). Keep facing the
    -- direction of travel and drop to half pace until the target catches up. Within FAR_GAP
    -- only: further out the far-gap snap owns it.
    local vx, vy = interp:velocity(now)
    -- FACE WHAT THE SERVER FACES; MOVE WHERE IT MOVES. A body only goes forward along its own
    -- heading, so following a target used to mean TURNING toward where it was going: walking NPCs
    -- spun round or snapped their heads side to side (prod 2026-10-15), and a creature backing off
    -- or side-stepping in a fight turned its back on the player, then turned round to strike.
    -- Now the heading is always the server's, and the movement -- forward, back, sideways -- is
    -- split along that body to follow the target's own velocity plus closing the gap over
    -- CATCHUP_S. The split uses the heading the body HAS this frame: that is the one the engine
    -- moves it along (character.cpp). Out of steering (close and standing still) only the
    -- target's own velocity is followed, so a slow shuffle is still mirrored.
    -- A HAIR OF TURN IS A TURN. A biped is in its turn state for ANY non-zero rotation and plays
    -- the turn clip at a speed proportional to it (character.cpp effectiveRotation, turnSpeed):
    -- facing the server's heading to the last rounding error, every puppet that had turned stood
    -- frozen mid-turn afterwards -- a friend's arm on turnleft1h at a fixed time 1.5 s after a blow
    -- (s194, Jenkins #256), the 2026-10-21 re-shoot's "half-turned" pose. Under YAW_DEADBAND the
    -- body is facing: no turn, so the stance's idle plays.
    local yawErr = shortestArc((target.yaw or curYaw) - curYaw)
    self.controls.yawChange = math.abs(yawErr) < YAW_DEADBAND and 0 or yawErr
    -- A CREATURE'S TOP SPEED IS ITS MAX SPEED. getRunSpeed is a creature's WALK speed, but a flier
    -- or a swimmer moves at its fly or swim speed (creature.cpp getMaxSpeed): the controls asked a
    -- slaughterfish for the wrong fraction, and it overshot and oscillated round its path.
    local speedOf = self.controls.run and types.Actor.getRunSpeed or types.Actor.getWalkSpeed
    if types.Actor.getMaxSpeed and types.Creature and types.Creature.objectIsInstance(self) then speedOf = types.Actor.getMaxSpeed end
    local okT, top = pcall(speedOf, self)
    if not okT or type(top) ~= 'number' or top <= 0 then top = 150 end
    local cx, cy = vx, vy
    if steering then cx, cy = vx + dx / math.max(CATCHUP_S, dt or 0), vy + dy / math.max(CATCHUP_S, dt or 0) end
    local fwd, side = Interp.bodyControls(cx, cy, curYaw, top, PUPPET_MAX_SPEED)
    -- A puppet that only needs to creep less than a step stands; the hysteresis above decides
    -- when it steers again.
    if not steering and tgtV < 20 then fwd, side = 0, 0 end
    self.controls.movement = fwd
    self.controls.sideMovement = side
    -- Look up and down too (avatar.lua applies the input's pitch the same way).
    self.controls.pitchChange = (target.pitch or 0) - self.rotation:getPitch()
    self.controls.sneak = bit(target.flags, 1)
    -- Posture: a friend with a sword out looks like it. Purely visual here -- the puppet never
    -- swings (its controls.use stays 0); the peer's avatar does the hitting.
    local want = bit(target.flags, 4) and types.Actor.STANCE.Weapon
        or (bit(target.flags, 5) and types.Actor.STANCE.Spell or types.Actor.STANCE.Nothing)
    if types.Actor.getStance(self) ~= want then
        -- The engine refuses the spell stance on a body with nothing selected to cast, and a
        -- puppet knows no spells: a friend readying magic stood at ease on every other screen
        -- (s145). Any spell will do -- the puppet never casts; the pose is the point.
        if want == types.Actor.STANCE.Spell and not types.Actor.getSelectedSpell(self) then
            pcall(function()
                for _, rec in ipairs(core.magic.spells.records) do
                    if rec.type == core.magic.SPELL_TYPE.Spell then
                        types.Actor.spells(self):add(rec.id)
                        types.Actor.setSelectedSpell(self, rec.id)
                        break
                    end
                end
            end)
        end
        pcall(function() types.Actor.setStance(self, want) end)
    end
    self.controls.jump = jumped
end

return {
    engineHandlers = {
        onInit = function(initData)
            playerId = initData and initData.playerId
            actorKey = initData and initData.actorKey
            self:enableAI(false) -- the pose stream owns this actor, not the AI
            markPuppet(true)
        end,
        -- NOT ONLY A SAVE GAME. The engine unloads an INACTIVE object's scripts a few hundred
        -- frames after its cell goes out of view (ScriptTracker::unloadInactiveScripts) and
        -- reloads them through onSave/onLoad. A degraded puppet in the exterior a player had
        -- left came back with no key and its AI switched off: the next pose did not re-arm it,
        -- and it stood 200-500 u from the peer's NPC with no snap until the session ended
        -- (prod ar5tbvgs, Pelagiad, after a door hop between two interiors).
        onLoad = function(data)
            playerId = data and data.playerId
            actorKey = data and data.actorKey
            degradedKey = data and data.degradedKey
            degraded = degradedKey ~= nil
            if not (playerId or actorKey) then return end -- not a live puppet: its AI stays as MP_Detach left it
            self:enableAI(false)
            markPuppet(true)
        end,
        onSave = function()
            return { playerId = playerId, actorKey = actorKey, degradedKey = degraded and degradedKey or nil }
        end,
        onUpdate = onUpdate,
    },
    eventHandlers = {
        MP_Pose = function(e)
            -- The peer is back and driving this actor again: re-arm. addScript on a script
            -- that is still attached is a silent no-op (no onInit), so this is the only
            -- place a degraded puppet learns the outage is over.
            -- ...or a cell-border detach whose new cell's first pose came before the script was
            -- removed (global.lua mpPuppetDetached then keeps it): drive it again.
            if degraded or (actorKey == nil and playerId == nil and e.actorKey ~= nil) then
                degraded = false
                actorKey = actorKey or degradedKey or e.actorKey
                placed = false
                self:enableAI(false)
                markPuppet(true)
            end
            -- Absent tier (a server predating G2, or renderLod = "full") means near: the
            -- fallback must be full fidelity, never a silent degrade.
            tier = e.tier or TIER_NEAR
            -- A TELEPORT IS NOT A PATH. A friend who respawns or takes a door within the cell
            -- jumps thousands of units between two poses; interpolated, the render-delayed target
            -- swept the line between them, the distance snap put the body on a point of it, and
            -- the 1 s snap cooldown left it standing there. Start the buffer over at the new spot.
            local last = interp.buf[#interp.buf]
            local far = SNAP_BY_TIER[tier] or SNAP_DISTANCE
            if last and e.x and ((e.x - last.x) ^ 2 + (e.y - last.y) ^ 2 + (e.z - last.z) ^ 2) > far * far then
                interp:clear()
            end
            interp:push(e)
            local u = bit(e.flags, 3)
            if u and not rxUse then pressLatch = true end
            if rxUse and not u then releaseLatch = true end
            rxUse = u
            -- The LAST pose this puppet was handed, and the tier it came at. With global.lua's
            -- moveRx this pins a movement fault to ONE hop -- never routed, routed but not
            -- pushed, or pushed and not steered -- which is exactly the distinction that took
            -- an engine rebuild to make the first time.
            -- Twice a second, not per pose: a call out to the page on every pose of every
            -- puppet was ~18 a frame with a crowd of 20 (#159 s177), for one debug key.
            local nowRx = core.getRealTime()
            if nowRx - rxMirrorAt >= 0.5 then
                rxMirrorAt = nowRx
                mp.set('puppetRx', string.format('%.0f@t%d', e.y or 0, tier))
            end
        end,
        -- M2: full slot->recordId snapshot (items already granted by global.lua).
        MP_Equip = function(data)
            local slots = {}
            for slot, id in pairs(data.slots or {}) do
                slots[tonumber(slot) or slot] = id
            end
            pendingEquip = slots
            -- 30 s, not 3: the granted item lands in the inventory a frame after MP_Equip, and a
            -- client whose frames run 3-10 s apart under load (a full sweep) passed the deadline
            -- before it existed -- setEquipment then ran without it and the slot was dropped
            -- for good (s148: the friend's torch, #120/#127; never in isolation).
            equipRetryUntil = core.getRealTime() + 30
        end,
        -- M2/M4: mirror the remote actor's dynamic stats (health bar, death pose).
        MP_Stats = function(data)
            local d = types.Actor.stats.dynamic
            -- `stat` is nil when this object is no longer a live actor -- a puppet caught
            -- mid-despawn still receives events already in flight. Indexing it threw, and a
            -- throwing handler takes its WHOLE subsystem down: this puppet's health bar and
            -- death pose stop updating for the rest of the session, long after the despawn
            -- that caused it. Seen during a peer outage, where puppets churn.
            local function apply(stat, v)
                local before = stat and stat.current
                if stat and v then
                    stat.base = v.b
                    stat.current = v.c
                end
                return before ~= nil and v and v.c ~= nil and v.c < before
            end
            local hpDrop = apply(d.health(self), data.hp)
            apply(d.magicka(self), data.mp)
            local ftDrop = apply(d.fatigue(self), data.ft)
            -- THE FEEL OF THE BLOW (backlog 310): the bar drop is what actually landed on the
            -- holder, so this is where the sound belongs. Health down = a hit (blood at the
            -- last local swing's position if it was recent; a drop from elsewhere has no
            -- position, so no blood). Fatigue-only down after a recent local swing = a punch
            -- (combat.cpp getHandToHandDamage's sounds). Nothing plays 'miss': no engine
            -- knows a miss for certain, and running drains fatigue too, hence the window.
            pcall(function()
                local recent = core.getRealTime() - lastSwingAt <= SWING_FEEL_WINDOW_S
                -- ...and the FLINCH (s171). The holder's actor plays its hit reaction on a landed
                -- blow; the puppet only changed a number, so a landed hit looked like a miss to the
                -- player who landed it. A PUNCH TOO: hand-to-hand lands on fatigue, the engine
                -- flinches the victim for it all the same (Creature/Npc::onHit), and unarmed fights
                -- showed no hit at all (prod 2026-10-16). Not on the killing blow (death plays) nor
                -- the knockout (fatigue gone: the engine drops the body itself).
                local function flinch()
                    if (data.hp and (data.hp.c or 0) <= 0) or (data.ft and (data.ft.c or 0) <= 0) then return end
                    local anim = require('openmw.animation')
                    local hits = {}
                    for i = 1, 5 do if anim.hasGroup(self, 'hit' .. i) then hits[#hits + 1] = 'hit' .. i end end
                    if #hits > 0 then anim.playBlended(self, hits[math.random(#hits)], { priority = anim.PRIORITY.Hit }) end
                end
                if hpDrop then
                    core.sound.playSound3d('Health Damage', self)
                    flinch()
                    if recent and lastSwingPos and I.Combat and I.Combat.spawnBloodEffect then
                        I.Combat.spawnBloodEffect(lastSwingPos)
                    end
                elseif ftDrop and recent then
                    if core.getRealTime() - lastPunchSoundAt > SWING_FEEL_WINDOW_S then
                        core.sound.playSound3d(math.random(2) == 1 and 'Hand To Hand Hit' or 'Hand To Hand Hit 2', self)
                    end
                    flinch()
                end
                if hpDrop or ftDrop then lastSwingAt = 0; lastPunchSoundAt = 0 end
            end)
            -- Speed is the one attribute the body needs: on the template's Speed a fast
            -- friend's puppet fell 128 units behind and teleported (backlog 134).
            if data.speed then
                pcall(function()
                    local sp = types.Actor.stats.attributes.speed(self)
                    if sp.base ~= data.speed then sp.base = data.speed end
                end)
            end
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
        MP_CastFx = function(data)
            local anim = require('openmw.animation')
            pcall(function()
                anim.playBlended(self, 'spellcast', { priority = anim.PRIORITY.Weapon })
            end)
            -- The school's cast sound and the effect's casting glow, as the caster's own
            -- engine played them. Best effort: a spell this client has no record for is silent.
            pcall(function()
                local spell = core.magic.spells.records[data and data.spellId]
                local eff = spell and spell.effects[1] and spell.effects[1].effect
                if not eff then return end
                local skill = core.stats.Skill.records[eff.school]
                local snd = skill and skill.school and skill.school.castSound
                core.sound.playSound3d((snd and snd ~= '' and snd) or (eff.school .. ' cast'), self)
                local static = types.Static.record(eff.castStatic ~= '' and eff.castStatic or 'VFX_DefaultCast')
                if static and static.model then
                    anim.addVfx(self, static.model, { vfxId = eff.id, particleTextureOverride = eff.particle })
                end
            end)
        end,
        -- The holder stopped driving this actor: it left the cell, changed cell, or (with
        -- data.degraded) the peer is gone and nobody simulates it. Re-enable AI (the
        -- mDisableAI control persists after removeScript, so it must be cleared here) and
        -- stop driving. Only the sim peer ever holds a cell, so there is no handoff to a
        -- client here -- a detach is loss or departure. Degraded keeps the script (and the
        -- hit intercept) attached; the other cases have global.lua remove it right after.
        MP_Detach = function(data)
            degraded = data and data.degraded == true
            -- A second outage before any pose re-armed it must not forget the address.
            degradedKey = degraded and (actorKey or degradedKey) or nil
            actorKey = nil
            playerId = nil
            dead = false
            zeroControls()
            self:enableAI(true)
            -- No longer somebody else's actor: the engine may apply magic damage to it again.
            markPuppet(false)
            if degraded then return end
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
