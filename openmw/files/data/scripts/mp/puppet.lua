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
local function markPuppet(on)
    if not mp.setPuppet then
        if mp.set then mp.set('puppetMark', 'no-binding') end
        return
    end
    local ok, err = pcall(function() mp.setPuppet(self.object, on) end)
    if mp.set then
        mp.set('puppetMark', ok and (on and 'marked' or 'unmarked') or ('failed:' .. tostring(err)))
    end
end

local playerId = nil -- set for remote-player puppets
local actorKey = nil -- set for M4 NPC puppets (refKey the holder addresses)
-- DEGRADED (backlog 328): the peer is gone, this actor's own AI is back on, and the script
-- stays attached with the hit intercept armed, so a swing during the outage cancels exactly
-- as it does with a holder. Degraded mode is cosmetic: without it an outage kill was a
-- permanent per-screen divergence (alive for B, a lootable corpse for A, counted nowhere).
-- degradedKey remembers the address so the first pose after the peer returns re-arms.
local degraded = false
local degradedKey = nil
-- Backlog 310: the last local swing at this puppet; the stats drop it caused plays the feel.
local lastSwingAt, lastSwingPos = 0, nil
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
local prevJump = false
local prevUse = false -- the owner's use bit last pose: its release is one swing to show

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
local function showSwing(release)
    pcall(function()
        local anim = require('openmw.animation')
        if types.Actor.getStance(self) == types.Actor.STANCE.Spell then
            if not release then
                anim.playBlendedAnimation(self, 'spellcast', {
                    priority = anim.PRIORITY.Weapon, startKey = 'self start', stopKey = 'self stop' })
            end
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
        if release then
            anim.playBlendedAnimation(self, group, {
                priority = anim.PRIORITY.Weapon,
                startKey = kind .. ' max attack',
                stopKey = ranged and 'shoot release' or 'chop follow stop',
            })
            core.sound.playSound3d('Weapon Swish', self)
        else
            anim.playBlendedAnimation(self, group, {
                priority = anim.PRIORITY.Weapon,
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
local function forwardMagicHits()
    if not (playerId or actorKey) then return end
    if not mp.takeMagicHits then return end
    local ok, hits = pcall(function() return mp.takeMagicHits(self.object) end)
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
    core.sendGlobalEvent('mpCombatSpellHit', {
        victim = self.object,
        playerId = playerId,
        effects = effects,
        spellId = spellId,
        beneficial = beneficial,
        ignoreReflect = ignoreReflect,
    })
end

local function onUpdate(dt)
    ensureHitHandler()
    forwardMagicHits()
    if dt <= 0 or (not playerId and not actorKey) then return end
    if dead then
        zeroControls()
        return
    end
    local now = core.getRealTime()
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
        return
    end

    -- Arrived, and nothing new is coming: park. (Still approaching on an idle stream falls
    -- through to the steering below -- see the IDLE note above.)
    if idle and dist2d <= STEER_STOP then
        zeroControls()
        stuckSince = nil
        return
    end

    -- HYSTERESIS, not bang-bang at a 4-unit line. This used to be "further than 4 units? full
    -- speed toward it, otherwise stop". At run speed a single frame covers well over 4 units,
    -- so the puppet shot PAST its target, the bearing flipped ~180 degrees, and it sprinted
    -- back — then past again. That is the walk-forward-spin-around-walk-backward players see,
    -- and it never settles because the target keeps advancing into the same overshoot.
    if steering and dist2d <= STEER_STOP then steering = false end
    if not steering and dist2d >= STEER_START then steering = true end

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

    local curYaw = self.rotation:getYaw()
    if steering then
        -- Steer toward the target point (MW yaw: 0 = +Y, clockwise positive).
        self.controls.yawChange = shortestArc(math.atan(dx, dy) - curYaw)
        -- Full speed while there is ground to cover, easing to a walk over the last stretch.
        -- Floored so it always closes the gap rather than creeping forever.
        self.controls.movement = math.max(0.25, math.min(1, dist2d / 96))
    else
        -- Close enough: hold position, face the remote player's actual heading.
        self.controls.movement = 0
        self.controls.yawChange = shortestArc((target.yaw or curYaw) - curYaw)
    end
    -- Look up and down too (avatar.lua applies the input's pitch the same way).
    self.controls.pitchChange = (target.pitch or 0) - self.rotation:getPitch()
    self.controls.sideMovement = 0
    -- Mirror the remote player's run flag, but never while closing the last few units: running
    -- is what turns a small correction into an overshoot.
    local run = bit(target.flags, 0) and steering and dist2d > STEER_START
    if run then runUntil = now + RUN_HOLD_S end
    self.controls.run = run or now < runUntil
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
    local jumpEdge = bit(target.flags, 2)
    self.controls.jump = jumpEdge and not prevJump
    prevJump = jumpEdge
    -- Press is the wind-up, release is the blow: one edge each.
    local using = bit(target.flags, 3)
    if using ~= prevUse then showSwing(not using) end
    prevUse = using
end

return {
    engineHandlers = {
        onInit = function(initData)
            playerId = initData and initData.playerId
            actorKey = initData and initData.actorKey
            self:enableAI(false) -- the pose stream owns this actor, not the AI
            markPuppet(true)
        end,
        onLoad = function(data)
            playerId = data and data.playerId
            actorKey = data and data.actorKey
            self:enableAI(false)
            markPuppet(true)
        end,
        onSave = function()
            return { playerId = playerId, actorKey = actorKey }
        end,
        onUpdate = onUpdate,
    },
    eventHandlers = {
        MP_Pose = function(e)
            -- The peer is back and driving this actor again: re-arm. addScript on a script
            -- that is still attached is a silent no-op (no onInit), so this is the only
            -- place a degraded puppet learns the outage is over.
            if degraded then
                degraded = false
                actorKey = actorKey or degradedKey
                placed = false
                self:enableAI(false)
                markPuppet(true)
            end
            -- Absent tier (a server predating G2, or renderLod = "full") means near: the
            -- fallback must be full fidelity, never a silent degrade.
            tier = e.tier or TIER_NEAR
            interp:push(e)
            -- The LAST pose this puppet was handed, and the tier it came at. With global.lua's
            -- moveRx this pins a movement fault to ONE hop -- never routed, routed but not
            -- pushed, or pushed and not steered -- which is exactly the distinction that took
            -- an engine rebuild to make the first time.
            mp.set('puppetRx', string.format('%.0f@t%d', e.y or 0, tier))
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
                if hpDrop then
                    core.sound.playSound3d('Health Damage', self)
                    if recent and lastSwingPos and I.Combat and I.Combat.spawnBloodEffect then
                        I.Combat.spawnBloodEffect(lastSwingPos)
                    end
                elseif ftDrop and recent then
                    core.sound.playSound3d(math.random(2) == 1 and 'Hand To Hand Hit' or 'Hand To Hand Hit 2', self)
                end
                if hpDrop or ftDrop then lastSwingAt = 0 end
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
                anim.playBlendedAnimation(self, 'spellcast', { priority = anim.PRIORITY.Weapon })
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
            degradedKey = degraded and actorKey or nil
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
