-- M2 identity sync (PLAYER context; required by scripts/mp/player.lua).
-- Broadcasts the local player's identity to the server on timed diffs (PROTOCOL.md M2):
--   PlayerAppearance   1 s poll of the own NPC record (also detects chargen completion —
--                      there is no engine handler for it, the record simply changes)
--   PlayerEquipment    0.5 s diff, full slot->recordId snapshot
--   PlayerStatsDynamic 0.25 s diff of hp/mp/ft current+base, instant on the death edge
--   PlayerAttributes/PlayerSkills/PlayerLevel  1 s diff (server-side persistence only)
--   PlayerSpellbook    add/remove diff (1 s)
--   PlayerInventory    2 s diff, {items={{id,n},...}} capped at 512 entries
--   PlayerItemAcquired 0.25 s, {id,n} per count INCREASE — closes the drop-conservation race
--   PlayerDeath        once when isDead(self) edges true
-- Also applies the rejoin-restore record (MP_ApplyRecord from global.lua) and seeds the
-- diff caches from the applied state so restoring can never loop back into a broadcast.
local core = require('openmw.core')
local self = require('openmw.self')
local types = require('openmw.types')
local mp = require('openmw.mp')

local json = require('scripts.mp.json')

local Actor = types.Actor
local NPC = types.NPC

local INTERVALS = { appearance = 1.0, equipment = 0.5, dynamic = 0.25, progression = 1.0, inventory = 2.0 }
local INVENTORY_CAP = 512
-- ACQUISITION REPORTING, and why it is a separate faster pass rather than a smaller INTERVAL.
--
-- The full PlayerInventory snapshot is a 2 s diff, and the server used to judge "can this player
-- drop that?" against it. A player who picks something up and drops it immediately outruns their
-- own declaration, so the server has not yet been told they hold it — ordinary play that looked
-- exactly like dropping something you never had. Conservation enforcement was written on that
-- stale picture once and had to be backed out.
--
-- So increases are reported the moment they are seen, while the full snapshot stays on its slow
-- cadence: the expensive part is the snapshot's SIZE (up to 512 entries every time), not noticing
-- that one count went up. Derived from the inventory itself rather than from hooks on each
-- acquisition path, which is what makes it complete by construction — pickup, container, barter,
-- alchemy, quest reward and anything a mod invents all land here identically.
local ACQUIRE_INTERVAL = 0.25

local identity = {}

local last = { appearance = nil, equipment = nil, dynamic = nil, progression = nil, spells = nil, inventory = nil }
local nextAt = { appearance = 0, equipment = 0, dynamic = 0, progression = 0, inventory = 0, acquire = 0 }
-- recordId -> count, as of the last acquisition pass. Separate from `last.inventory` because
-- that one only advances on the slow cadence, and comparing against it would re-report the same
-- gain every 0.25 s until the snapshot caught up.
local acqCounts = nil
local wasDead = false
local restoring = false -- suppress broadcasts while the rejoin record is being applied
local pendingPhase2 = nil -- rejoin record awaiting the post-chargen stats pass
local phase2At = 0

local ATTRIBUTES = { 'strength', 'intelligence', 'willpower', 'agility', 'speed', 'endurance', 'personality', 'luck' }

local function skillIds()
    local ids = {}
    for _, rec in ipairs(core.stats.Skill.records) do
        ids[#ids + 1] = rec.id
    end
    table.sort(ids)
    return ids
end

-- --- snapshot builders -------------------------------------------------------------------

local function snapAppearance()
    local rec = NPC.record(self)
    -- The server refuses appearance with empty fields (playerstate.ts handleAppearance),
    -- and a template-based player record can have empty head/hair pre-chargen — borrow the
    -- demo villager's parts so the broadcast is always valid (puppets fall back anyway).
    local fallback = NPC.records['villager_00']
    local function orFallback(v, key)
        if v and v ~= '' then return v end
        return fallback and fallback[key] or 'none'
    end
    return {
        race = orFallback(rec.race, 'race'),
        head = orFallback(rec.head, 'head'),
        hair = orFallback(rec.hair, 'hair'),
        isMale = rec.isMale == true,
        class = orFallback(rec.class, 'class'),
        -- The name the player typed in Morrowind's own character creation, read from their
        -- NPC record — i.e. out of the character itself. mp.getName() is the SESSION name,
        -- which before chargen is the slot's placeholder label ("New character"), and sending
        -- that made the server store "New character" as the character's name and the tile
        -- screen show it forever. Fall back to the session name only while the record has no
        -- name yet (pre-chargen), so a slot always has something to display.
        name = (rec.name ~= nil and rec.name ~= '') and rec.name or mp.getName(),
    }
end

local function snapEquipment()
    local slots = {}
    for slot, item in pairs(Actor.getEquipment(self)) do
        slots[slot] = item.recordId
    end
    return { slots = slots }
end

local function snapDynamic()
    local d = Actor.stats.dynamic
    local function stat(s)
        return { c = math.floor(s.current + 0.5), b = math.floor(s.base + 0.5) }
    end
    return { hp = stat(d.health(self)), mp = stat(d.magicka(self)), ft = stat(d.fatigue(self)) }
end

local function snapProgression()
    local attributes, skills = {}, {}
    for _, id in ipairs(ATTRIBUTES) do
        attributes[id] = Actor.stats.attributes[id](self).base
    end
    for _, id in ipairs(skillIds()) do
        skills[id] = NPC.stats.skills[id](self).base
    end
    return { attributes = attributes, skills = skills, level = Actor.stats.level(self).current }
end

local function snapSpells()
    local set = {}
    for _, spell in pairs(Actor.spells(self)) do
        set[spell.id] = true
    end
    return set
end

local function snapInventory()
    local counts, order = {}, {}
    for _, item in ipairs(Actor.inventory(self):getAll()) do
        if not counts[item.recordId] then
            order[#order + 1] = item.recordId
        end
        counts[item.recordId] = (counts[item.recordId] or 0) + item.count
    end
    local items = {}
    for _, id in ipairs(order) do
        items[#items + 1] = { id = id, n = counts[id] }
        if #items >= INVENTORY_CAP then break end
    end
    return { items = items }
end

-- Stable stringify for change detection (json.encode key order is pairs-order, so sort).
local function fingerprint(v)
    if type(v) ~= 'table' then return tostring(v) end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do
        local raw = v[k]
        if raw == nil then raw = v[tonumber(k)] end
        parts[#parts + 1] = k .. '=' .. fingerprint(raw)
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

-- --- broadcast tick ----------------------------------------------------------------------

-- `sender` overrides the default direct send: M7 routes PlayerEquipment through the global
-- script so player-made record ids can be mapped to their server recordNetId first (the
-- registry is global-only — world.createRecord is).
local function diffSend(kind, eventName, snapFn, now, sender)
    if now < nextAt[kind] then return end
    nextAt[kind] = now + INTERVALS[kind]
    local snap = snapFn()
    local fp = fingerprint(snap)
    if fp ~= last[kind] then
        last[kind] = fp
        ;(sender or mp.sendEvent)(eventName, snap)
        return snap
    end
end

function identity.tick(now)
    if restoring then return end

    diffSend('appearance', 'PlayerAppearance', snapAppearance, now)
    local eq = diffSend('equipment', 'PlayerEquipment', snapEquipment, now, function(_, snap)
        core.sendGlobalEvent('mpEquipmentOut', snap)
    end)
    if eq then
        local ids = {}
        for _, id in pairs(eq.slots) do ids[#ids + 1] = id end
        table.sort(ids)
        mp.testSet('equippedIds', table.concat(ids, ','))
    end

    local dead = Actor.isDead(self)
    if dead and not wasDead then
        -- Death edge: dynamic snapshot NOW (hp 0) + PlayerDeath, ahead of any timer.
        last.dynamic = fingerprint(snapDynamic())
        mp.sendEvent('PlayerStatsDynamic', snapDynamic())
        mp.sendEvent('PlayerDeath', {})
    end
    wasDead = dead

    if now >= nextAt.dynamic then
        nextAt.dynamic = now + INTERVALS.dynamic
        local dyn = snapDynamic()
        mp.testSet('hp', tostring(dyn.hp.c)) -- mirror unconditionally (diff may be seeded)
        local fp = fingerprint(dyn)
        if fp ~= last.dynamic then
            last.dynamic = fp
            mp.sendEvent('PlayerStatsDynamic', dyn)
        end
    end

    if now >= nextAt.progression then
        nextAt.progression = now + INTERVALS.progression
        local prog = snapProgression()
        -- Server contract (playerstate.ts parseNumberMap): the body IS the flat map.
        local fp = fingerprint(prog.attributes)
        if fp ~= last.progression then
            last.progression = fp
            mp.sendEvent('PlayerAttributes', prog.attributes)
        end
        local sfp = fingerprint(prog.skills)
        if sfp ~= last.skills then
            last.skills = sfp
            mp.sendEvent('PlayerSkills', prog.skills)
        end
        if prog.level ~= last.level then
            last.level = prog.level
            mp.sendEvent('PlayerLevel', { level = prog.level })
        end
        -- Spellbook add/remove diff on the same 1 s cadence.
        local spells = snapSpells()
        if last.spells then
            local add, remove = {}, {}
            for id in pairs(spells) do
                if not last.spells[id] then add[#add + 1] = id end
            end
            for id in pairs(last.spells) do
                if not spells[id] then remove[#remove + 1] = id end
            end
            if #add > 0 or #remove > 0 then
                -- Routed through global for the same reason equipment is (mpEquipmentOut):
                -- toNet lives in the global-only record registry, and a raw local dynamic id
                -- on the wire is the bug M7 exists to close.
                core.sendGlobalEvent('mpSpellbookOut', { add = add, remove = remove })
            end
        else
            local add = {}
            for id in pairs(spells) do add[#add + 1] = id end
            table.sort(add)
            if #add > 0 then core.sendGlobalEvent('mpSpellbookOut', { add = add, remove = {} }) end
        end
        last.spells = spells
    end

    diffSend('inventory', 'PlayerInventory', snapInventory, now)

    -- Report COUNT INCREASES as they happen. Only increases: a decrease is a drop, a sale or a
    -- use, and the server learns about those from the snapshot — this exists solely to stop the
    -- server's picture being stale in the direction that matters for conservation.
    if not restoring and now >= nextAt.acquire then
        nextAt.acquire = now + ACQUIRE_INTERVAL
        local counts = {}
        for _, item in ipairs(Actor.inventory(self):getAll()) do
            counts[item.recordId] = (counts[item.recordId] or 0) + item.count
        end
        -- The FIRST pass only seeds the baseline. Reporting everything a character already owns
        -- as freshly acquired would credit their whole inventory twice over — once here and
        -- again in the snapshot — and on a rejoin-restore that is the entire restored doc.
        if acqCounts ~= nil then
            for id, n in pairs(counts) do
                local before = acqCounts[id] or 0
                if n > before then
                    mp.sendEvent('PlayerItemAcquired', { id = id, n = n - before })
                end
            end
        end
        acqCounts = counts
    end
end

-- Rejoin: session ended -> everything must be re-sent on the next join (unless restored).
function identity.reset()
    last = {}
    -- nil, NOT {}: the next pass must re-seed the baseline rather than treat the whole restored
    -- inventory as newly acquired.
    acqCounts = nil
    nextAt = { appearance = 0, equipment = 0, dynamic = 0, progression = 0, inventory = 0, acquire = 0 }
    wasDead = false
    restoring = false
    pendingPhase2 = nil
end

-- --- rejoin restore ----------------------------------------------------------------------

local pendingEquipment = nil
local equipRetryUntil = 0

-- Equipment can only be applied once the granted items exist in the inventory (the global
-- script's createObject+moveInto lands a frame or more later) — retry briefly.
local function tryApplyEquipment(now)
    if not pendingEquipment then return end
    local have = {}
    for _, item in ipairs(Actor.inventory(self):getAll()) do
        have[item.recordId] = true
    end
    local ready = true
    for _, id in pairs(pendingEquipment) do
        if not have[id] then ready = false end
    end
    if ready or now > equipRetryUntil then
        local ok, err = pcall(Actor.setEquipment, self, pendingEquipment)
        if not ok then print('[mp] restore equipment failed: ' .. tostring(err)) end
        last.equipment = fingerprint(snapEquipment())
        pendingEquipment = nil
    end
end

-- Phase 1 (chargen) must fully land before phase 2 (stats): applyChargen is deferred to
-- synchronizedUpdate and its buildPlayer() RECALCULATES dynamic stats — writing hp first
-- would be clobbered a frame later. So: chargen now, stats after a short settle delay.
function identity.applyRecord(record)
    restoring = true
    if record.appearance then
        pcall(mp.applyChargen, {
            race = record.appearance.race,
            head = record.appearance.head,
            hair = record.appearance.hair,
            isMale = record.appearance.isMale,
            class = record.appearance.class,
            -- The name the player chose, restored with the rest of the look. Without it a
            -- restored character keeps the engine default ("player"), which is what the save
            -- screen shows. The doc's appearance name is authoritative; the boot fragment is
            -- the fallback for a session whose record has not arrived yet.
            name = record.appearance.name or (mp.getName and mp.getName()) or nil,
        })
    end
    pendingPhase2 = record
    phase2At = core.getRealTime() + 0.5
end

local function applyPhase2(record)
    local ok, err = pcall(function()
        local stats = record.stats or {}
        if stats.level then Actor.stats.level(self).current = stats.level end
        for id, v in pairs(stats.attributes or {}) do
            local stat = Actor.stats.attributes[id]
            if stat then stat(self).base = v end
        end
        for id, v in pairs(stats.skills or {}) do
            local stat = NPC.stats.skills[id]
            if stat then stat(self).base = v end
        end
        local dyn = stats.dynamic
        if dyn then
            local d = Actor.stats.dynamic
            if dyn.hp then d.health(self).base = dyn.hp.b; d.health(self).current = dyn.hp.c end
            if dyn.mp then d.magicka(self).base = dyn.mp.b; d.magicka(self).current = dyn.mp.c end
            if dyn.ft then d.fatigue(self).base = dyn.ft.b; d.fatigue(self).current = dyn.ft.c end
        end
        if record.spells and next(record.spells) ~= nil then
            local spells = Actor.spells(self)
            -- CLEAR FIRST. applyChargen ran half a second ago and buildPlayer() granted this
            -- character its RACE powers, birthsign powers and autocalc spells. Adding the saved
            -- set on top UNIONS the two, so anything the character used to have -- a power from
            -- the race this slot was before it was rebuilt -- survives a race it no longer is.
            -- The diff cannot clean it up either: broadcasts are suppressed while `restoring`,
            -- and last.spells is re-seeded from the union below, so the stale power never shows
            -- up as a removal and is cemented into the server doc instead. The saved set already
            -- contains everything chargen grants (snapSpells captures the lot), so replacing
            -- rather than merging loses nothing. Guarded on a non-empty set: a record with no
            -- spells must not wipe the powers chargen just granted.
            -- pcall'd like every other call here: if the binding is ever absent this must
            -- degrade to the old union, not abort the rest of phase 2 (equipment included).
            pcall(function() spells:clear() end)
            for _, id in pairs(record.spells) do
                pcall(function() spells:add(id) end)
            end
        end
        if record.equipment then
            -- Server doc shape: flat slot->recordId map (persist/playerstore.ts). Items are
            -- granted by global.lua (createObject+moveInto); equip once they land.
            local slots = {}
            for slot, id in pairs(record.equipment) do
                slots[tonumber(slot) or slot] = id
            end
            pendingEquipment = slots
            equipRetryUntil = core.getRealTime() + 5
        end
    end)
    if not ok then print('[mp] restore failed: ' .. tostring(err)) end
    -- Seed every diff cache from the just-applied state: the first broadcast tick after a
    -- restore must see "no change" (server already holds this snapshot). Appearance is the
    -- exception — peers need the relay — so its cache stays empty.
    last.equipment = fingerprint(snapEquipment())
    last.dynamic = fingerprint(snapDynamic())
    local prog = snapProgression()
    last.progression = fingerprint(prog.attributes)
    last.skills = fingerprint(prog.skills)
    last.level = prog.level
    last.spells = snapSpells()
    last.inventory = fingerprint(snapInventory())
    restoring = false
    -- SELF-SILENCING DIAGNOSTIC. Everything the restore writes is `.base`; a freshly restored
    -- character should therefore carry no attribute MODIFIER at all. A live report showed a
    -- level-1 Redguard whose Endurance and Personality both held an IDENTICAL offset (+175, then
    -- +225 a few minutes later) while the other six attributes sat exactly on base+class bonus.
    -- An identical offset on two attributes, growing in lockstep, is the signature of a stacking
    -- Fortify effect, not a wrong base -- and nothing in the MP layer writes a modifier anywhere,
    -- so the source is engine- or data-side. This prints nothing for a healthy character and
    -- names the attributes and the amount when it is not, which is what the next live session
    -- needs to settle it. Do not delete until that report comes back clean.
    local drift = {}
    for _, id in ipairs(ATTRIBUTES) do
        local okA, st = pcall(function() return Actor.stats.attributes[id](self) end)
        if okA and st then
            local off = (st.modifier or 0) - (st.damage or 0)
            if off ~= 0 then
                drift[#drift + 1] = string.format('%s%+g(base %g)', id, off, st.base or 0)
            end
        end
    end
    if #drift > 0 then
        print('[mp] ATTRIBUTE MODIFIER PRESENT AFTER RESTORE: ' .. table.concat(drift, ' '))
    end
    print('[mp] rejoin restore applied')
    mp.testSet('restored', '1')
end

function identity.equipRetryTick(now)
    if pendingPhase2 and now >= phase2At then
        local record = pendingPhase2
        pendingPhase2 = nil
        applyPhase2(record)
    end
    tryApplyEquipment(now)
end

return identity
