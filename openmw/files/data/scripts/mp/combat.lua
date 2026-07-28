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
        local epoch = deps.epochOf(cellKey)
        if not cellKey or not epoch then
            -- No live epoch for that cell (we are not the holder and the server has not
            -- told us the epoch): the server would drop this. See the M5 note in the report.
            print('[mp] combat: no epoch for ' .. tostring(cellKey) .. ', hit not forwarded')
            return
        end
        target = { ref = data.victim, cellKey = cellKey, epoch = epoch }
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
        local indexes = {}
        for i = 1, #spell.effects do indexes[i] = i end
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
