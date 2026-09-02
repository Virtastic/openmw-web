-- M5 combat hub (GLOBAL context; wired from scripts/mp/global.lua).
-- See server/PROTOCOL.md §M5. Authority model (TES3MP-equivalent): the ATTACKER's client
-- detects the hit, the VICTIM's owner applies it. Raw PRE-mitigation damage travels; armor,
-- difficulty, resistances and sounds are applied exactly once on the victim by the engine's
-- own untouched combat pipeline (files/data-mw/scripts/omw/combat/local.lua).
--
-- Outbound: puppet.lua registers an I.Combat onHit handler on every puppet (remote players
-- and remote-authority NPCs). Because handlers run last-registered-first
-- (openmw_aux.util.callEventHandlers iterates in reverse) and our script attaches at
-- runtime, ours runs FIRST and returns false — cancelling all local damage — after
-- forwarding the raw attack here.
-- Inbound: we re-emit the stock `Hit` local event on the real victim, so the builtin
-- pipeline runs verbatim for our own player and for actors under our authority.
local core = require('openmw.core')
local types = require('openmw.types')
local util = require('openmw.util')
local mp = require('openmw.mp')
local threat = require('scripts.mp.threat')

local combat = {}

-- injected by global.lua: {playerFn, ownIdFn, puppetObjOf, epochOf, isHolderOf,
--                          cellKeyOfObj, isPvpEnabled}
local deps = nil

local lastHitTaken = nil -- diagnostic mirror for the scenarios

-- --------------------------------------------------------------- outbound

-- Raw attack forwarded from a puppet's onHit handler (see puppet.lua). `data.victim` is the
-- puppet object itself (a GameObject serializes as its RefNum through the event, so we get a
-- resolvable object back here).
function combat.onPuppetHit(data)
    -- Phase 4C: WHEN THE PEER SIMULATES, THE AVATAR'S OWN SWING COMPUTES MELEE. The owner's
    -- use bit rides the input tier; the peer's engine swings the avatar and resolves the hit
    -- against the actors it holds -- armor, difficulty, hit chance and all, with no client
    -- assertion in the loop. So a REAL swing here is cancel-only: puppet.lua already
    -- returned false to stop the local ghost damage, and forwarding it as well would land
    -- the blow twice. The relay survives for two callers: degraded mode (nobody simulating
    -- the cell: forward as before, victim-applies for players, held/dropped for actors) and
    -- the test hooks (mpTest), which keep s51/s58 policing the relay machinery itself.
    if not data.mpTest and deps.hasHolder then
        local cellKey = data.victim and data.victim:isValid() and deps.cellKeyOfObj(data.victim) or nil
        if not cellKey and deps.ownCellKeyFn then cellKey = deps.ownCellKeyFn() end
        if deps.hasHolder(cellKey) then return end
    end
    local target
    if data.playerId then
        -- Player victim. PvP off: cancel silently — the server drops these anyway, but
        -- suppressing locally keeps the attacker's client honest (no ghost damage).
        if not deps.isPvpEnabled() then return end
        target = { playerId = data.playerId }
    elseif data.victim and data.victim:isValid() then
        -- Actor victim: owned by that cell's authority holder. The server guards actor
        -- targets with (cellKey, epoch) exactly like the Actor* family.
        local cellKey = deps.cellKeyOfObj(data.victim)
        if not cellKey then
            -- Nothing to address the target with. Rare, and genuinely undeliverable.
            print('[mp] combat: victim has no cell, hit not forwarded')
            return
        end
        -- THE EPOCH IS OPTIONAL ON THE WIRE, AND THIS USED TO REFUSE TO SEND WITHOUT ONE.
        --
        -- server/src/core/combat.ts only validates the epoch `if (target.epoch !== undefined)`
        -- and proves presence by proximity instead, precisely because "the attacker is usually
        -- a NON-holder, and until it has seen an ActorAuthorityInfo/Grant for that cell it has
        -- no legal epoch to quote". The server was relaxed for that case; this side never was,
        -- so it dropped the hit itself on a condition the server had stopped caring about.
        --
        -- That is not a lost message, it is a lost SWING. puppet.lua's onHit interceptor has
        -- already returned false and cancelled the entire local damage chain by the time we get
        -- here, so refusing to forward means the attack does nothing at all: no damage, no
        -- miss, no sound, no blood — the player swings through the target and the game says
        -- nothing. Send it and let the server decide; it is the one holding the authority
        -- table, and quoting a stale epoch is the only thing it actually needs protecting from.
        local epoch = deps.epochOf(cellKey)
        target = { ref = data.victim, cellKey = cellKey }
        if epoch then target.epoch = epoch end
    else
        return
    end

    local body = {
        target = target,
        damage = data.damage or {},
        strength = data.strength or 0,
        sourceType = data.sourceType or 'Unspecified',
        successful = data.successful == true,
    }
    -- Optional descriptive fields (the server only sanity-checks them).
    if data.weaponId then body.weaponId = data.weaponId end
    if data.ammoId then body.ammoId = data.ammoId end
    if data.hitPos then body.hitPos = data.hitPos end
    mp.sendEvent('CombatHit', body)
end

-- Spell damage forwarded from a puppet (see puppet.lua forwardMagicHits). Same addressing
-- rules as onPuppetHit: a player victim needs PvP on, an actor victim is addressed by cell.
-- The server has always implemented CombatSpellHit; until now no client ever sent one.
function combat.onPuppetSpellHit(data)
    local function note(why) pcall(function() mp.testSet('spellFwd', why) end) end
    local effects = data.effects or {}
    if #effects == 0 then note('no-effects') return end
    local target
    if data.playerId then
        if not deps.isPvpEnabled() then note('pvp-off') return end
        target = { playerId = data.playerId }
    elseif data.victim and data.victim:isValid() then
        local cellKey = deps.cellKeyOfObj(data.victim)
        if not cellKey then note('no-cell') return end
        target = { ref = data.victim, cellKey = cellKey }
        local epoch = deps.epochOf(cellKey)
        if epoch then target.epoch = epoch end
    else
        note('no-victim')
        return
    end
    note('sending')
    mp.sendEvent('CombatSpellHit', {
        target = target,
        effects = effects,
        -- The OWNER applies the spell record by id, so this must be the spell, not the effect.
        -- Without it MP_CombatSpellHit looks up nil and silently applies nothing.
        spellId = data.spellId or effects[1].id,
        casterId = deps.ownIdFn() or 0,
    })
end

-- --------------------------------------------------------------- inbound

-- Rebuild the engine's AttackInfo from the wire body. `weapon` is deliberately absent: the
-- wire carries a record id but the field wants a live GameObject, and it only affects
-- sound/skill flavour — armor, difficulty and damage are unaffected.
local function attackInfoFrom(data)
    local info = {
        damage = data.damage or {},
        strength = data.strength or 0,
        successful = data.successful ~= false,
        sourceType = data.sourceType or 'Unspecified',
    }
    if data.ammoId then info.ammo = data.ammoId end
    if data.hitPos then
        info.hitPos = util.vector3(data.hitPos.x, data.hitPos.y, data.hitPos.z)
    end
    -- Attribution: trust the SERVER-stamped attackerId, never a client-supplied one.
    -- Passing the attacker's local puppet lets the builtin pipeline do blood/sounds.
    if data.attackerId then
        local attacker = deps.puppetObjOf(data.attackerId)
        if attacker and attacker:isValid() then info.attacker = attacker end
    end
    return info
end

-- The victim object this client is responsible for, or nil if the message is not ours to
-- apply (defensive: the server already routes to the right owner).
local function resolveVictim(data)
    local target = data.target or {}
    if target.playerId then
        -- Phase 4B: on the SIM PEER a player victim is their AVATAR body -- the server
        -- routes PvP hits here whenever the victim is driving the input tier, because the
        -- victim's own stat assertions are ignored while the peer's bar reports are fresh
        -- (4A one-writer rule): damage applied on the victim's client would silently vanish.
        -- Applied to the avatar it lands once, and travels back as AvatarStatsBatch.
        if mp.isSystem and mp.isSystem() then
            local obj = deps.puppetObjOf(target.playerId)
            return (obj and obj:isValid()) and obj or nil
        end
        return target.playerId == deps.ownIdFn() and deps.playerFn() or nil
    end
    local obj = target.ref
    if obj and obj:isValid() and deps.isHolderOf(deps.cellKeyOfObj(obj)) then
        return obj
    end
    return nil
end

combat.handlers = {}

-- Phase 4: every hit an actor takes credits the DEALER's threat, which is the only way a
-- summoner or a damage-over-time caster is visible to the AI at all — in vanilla their pet
-- does the hitting and they are ignored entirely.
local function creditThreat(data)
    local ref = data.ref
    local ok, valid = pcall(function() return ref and ref:isValid() end)
    if not (ok and valid) then return end
    local dmg = (data.damage and data.damage.health) or 0
    if dmg > 0 and data.byId then threat.addDamage('o:' .. ref.id, data.byId, dmg) end
end

combat.handlers.MP_CombatHit = function(data)
    creditThreat(data)
    local victim = resolveVictim(data)
    if not victim then return end
    local info = attackInfoFrom(data)
    -- Re-emit the STOCK Hit event: scripts/omw/combat/interface.lua turns it into
    -- I.Combat.onHit, which runs the untouched armor/difficulty/sound chain exactly once.
    victim:sendEvent('Hit', info)
    -- LSER numbers arrive as doubles, so tostring() would render "40.0" — format as an
    -- integer so scenarios can compare against the value they sent.
    lastHitTaken = { health = (info.damage or {}).health or 0, by = data.attackerId }
    mp.testSet('lastHitTaken', string.format('%.0f', lastHitTaken.health))
end

combat.handlers.MP_CombatSpellHit = function(data)
    local victim = resolveVictim(data)
    if not victim then return end
    -- activeSpells:add wants INDEXES into the spell record's own effect list, while the wire
    -- carries rolled {id, magnitude, duration} triples. We therefore apply the spell record
    -- with all of its effects and let the victim roll magnitudes locally — same spell, same
    -- duration semantics, magnitudes re-rolled within the record's range.
    local ok, err = pcall(function()
        local spell = core.magic.spells.records[data.spellId]
        if not spell then return end
        -- ZERO-BASED. activeSpells:add indexes the spell record's own effect list from 0
        -- (`Actor.activeSpells(self):add({id = 'chameleon', effects = { 0 }})` in the API docs),
        -- while Lua's own list is 1-based. Building 1..n threw
        -- `vector::_M_range_check: __n (which is 1) >= this->size() (which is 1)` on every
        -- single application — so even a forwarded spell hit applied nothing. Never caught
        -- because no client had ever sent a CombatSpellHit for this to receive.
        local indexes = {}
        for i = 1, #spell.effects do indexes[i] = i - 1 end
        types.Actor.activeSpells(victim):add({
            id = data.spellId,
            effects = indexes,
            caster = deps.puppetObjOf(data.attackerId),
            ignoreResistances = false,
        })
    end)
    if not ok then print('[mp] combat: spell apply failed: ' .. tostring(err)) end
end

-- Cosmetic only: mirror the caster's animation on their puppet.
combat.handlers.MP_CombatCast = function(data)
    local caster = data.casterId and deps.puppetObjOf(data.casterId)
    if caster and caster:isValid() then
        pcall(function() caster:sendEvent('MP_CastFx', { spellId = data.spellId }) end)
    end
end

-- Cosmetic only, and deliberately NOT implemented: spawning a mirrored projectile costs a
-- world object per shot for a visual that is already implied by the cast animation and the
-- resulting CombatHit. Recorded here so the message is knowingly ignored rather than lost.
combat.handlers.MP_CombatProjectile = function() end

function combat.init(d)
    deps = d
end

return combat
