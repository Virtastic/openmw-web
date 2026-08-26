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
-- BASELINE GATE. Until this is true we do not know what this character IS yet, so the
-- persistent halves of the sync stay silent.
--
-- Between the engine booting and the rejoin record landing, the player object exists and is
-- the raw TEMPLATE: every attribute 30, every skill 5, hand-to-hand 100. The diff loop had no
-- idea that was not the character, so it broadcast it, and the server -- which validates shape
-- and not plausibility -- stored it over the real one. The damage is permanent and
-- self-perpetuating: the next restore faithfully re-applies the template doc, the client
-- reports the template back, and no state anywhere still remembers the character. Seen in the
-- wild as a level-1 Nord Barbarian whose stats reset to a flat 30 across the board on relog,
-- with hand-to-hand pinned at 100.
--
-- Set when EITHER the restore finished (returning character) or chargen completed (new one) --
-- the two ways a character stops being a template. Appearance, equipment and the dynamic bars
-- are deliberately NOT gated: appearance is how the server detects chargen finishing at all,
-- and the bars re-derive themselves every tick.
local baselineReady = false
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
        -- BIRTHSIGN. The engine has always been able to apply one (mp.applyChargen ->
        -- setPlayerBirthsign) and nothing ever sent it, so every rejoin dropped it: the sheet
        -- came back blank and buildPlayer's birthsign block granted nothing. The ABILITIES
        -- survived by accident, because snapSpells captures them as spells -- which is also
        -- why they used to stack on every rejoin. No fallback: a character legitimately may
        -- have no birthsign, and inventing one is worse than carrying none.
        -- WEREWOLF FORM. Unlike a disease -- which is an ESM::Spell in the spell list and so
        -- already rides snapSpells -- lycanthropic FORM is a flag on NpcStats
        -- (NpcStats::isWerewolf), so nothing carried it and a werewolf who relogged came back
        -- human. It rides appearance because that is literally what it is, and because
        -- appearance is relayed to other players: they see the wolf rather than a man running
        -- around with a wolf's stats.
        isWerewolf = (function()
            local ok, v = pcall(function() return NPC.isWerewolf(self) end)
            return (ok and v == true) or nil
        end)(),
        birthsign = (function()
            local ok, v = pcall(function() return types.Player.getBirthSign(self) end)
            if ok and type(v) == 'string' and v ~= '' then return v end
            return nil
        end)(),
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

-- Per-item state the record id cannot express: wear, remaining enchantment charge, and which
-- soul is in a gem. Read through itemData (mwlua/itemdata.cpp exposes condition,
-- enchantmentCharge and soul as read/write properties). nil means "engine default", which is
-- the common case and costs nothing to carry.
local function itemState(item)
    local ok, d = pcall(function() return item.itemData end)
    if not ok or d == nil then return nil end
    local st, any = {}, false
    local okc, c = pcall(function() return d.condition end)
    if okc and type(c) == 'number' then st.condition = c; any = true end
    local oke, e = pcall(function() return d.enchantmentCharge end)
    if oke and type(e) == 'number' then st.charge = e; any = true end
    local oks, sl = pcall(function() return d.soul end)
    if oks and type(sl) == 'string' and sl ~= '' then st.soul = sl; any = true end
    if any then return st end
    return nil
end

local function snapInventory()
    local counts, order = {}, {}
    -- ADDITIVE, and deliberately so. `items` keeps its exact existing shape and arithmetic,
    -- because the restore grants the SHORTFALL between what the doc records and what
    -- countOf() finds -- change how entries aggregate and that subtraction starts duplicating
    -- or destroying real items, which is the worst failure this project has. States travel
    -- ALONGSIDE, keyed by record and positional within it, and are applied best-effort after
    -- the grant. Getting the states wrong costs fidelity; it cannot cost items.
    local states = {}
    for _, item in ipairs(Actor.inventory(self):getAll()) do
        if not counts[item.recordId] then
            order[#order + 1] = item.recordId
        end
        counts[item.recordId] = (counts[item.recordId] or 0) + item.count
        local st = itemState(item)
        if st then
            local bucket = states[item.recordId]
            if not bucket then bucket = {}; states[item.recordId] = bucket end
            bucket[#bucket + 1] = st
        end
    end
    local items = {}
    for _, id in ipairs(order) do
        items[#items + 1] = { id = id, n = counts[id] }
        if #items >= INVENTORY_CAP then break end
    end
    return { items = items, itemStates = states }
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

    if baselineReady and now >= nextAt.progression then
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

    if baselineReady then diffSend('inventory', 'PlayerInventory', snapInventory, now) end

    -- Report COUNT INCREASES as they happen. Only increases: a decrease is a drop, a sale or a
    -- use, and the server learns about those from the snapshot — this exists solely to stop the
    -- server's picture being stale in the direction that matters for conservation.
    if baselineReady and not restoring and now >= nextAt.acquire then
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
-- Called when chargen completes: global.lua sees chargenstate hit -1 and forwards it. The
-- restore path sets the same flag from applyPhase2. Idempotent.
function identity.markBaselineReady()
    baselineReady = true
    mp.testSet('baselineReady', '1')
end

function identity.reset()
    last = {}
    -- nil, NOT {}: the next pass must re-seed the baseline rather than treat the whole restored
    -- inventory as newly acquired.
    acqCounts = nil
    nextAt = { appearance = 0, equipment = 0, dynamic = 0, progression = 0, inventory = 0, acquire = 0 }
    wasDead = false
    restoring = false
    pendingPhase2 = nil
    -- SHUT THE GATE AGAIN. reset() runs every tick while we are not Joined -- a disconnect, a
    -- reconnect, a world hop -- and leaving baselineReady true across that reopens the exact
    -- hole it exists to close: the engine is the raw template again until the new world's
    -- record lands, and an open gate broadcasts that template over the real character. It is
    -- reopened by the same two events as the first time: applyPhase2 for a returning character,
    -- MP_ChargenDone for a brand new one.
    baselineReady = false
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
            -- Applied by the same call that applies race and class; the binding resolves it
            -- against the birthsign store and skips an id this content does not define.
            birthsign = record.appearance.birthsign,
            -- The name the player chose, restored with the rest of the look. Without it a
            -- restored character keeps the engine default ("player"), which is what the save
            -- screen shows. The doc's appearance name is authoritative; the boot fragment is
            -- the fallback for a session whose record has not arrived yet.
            name = record.appearance.name or (mp.getName and mp.getName()) or nil,
        })
    end
    -- Form is restored with the rest of the look, not in phase 2: applyChargen rebuilds the
    -- player record, and setting the form before that would be undone by it.
    if record.appearance and record.appearance.isWerewolf == true then
        pcall(function() NPC.setWerewolf(self, true) end)
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
            -- ...and purge what those spells ALREADY APPLIED. Clearing the spell list does not
            -- remove its effects, and activeSpells:remove() refuses anything non-temporary, so a
            -- constant-effect ability could not be taken off from script at all. Every rebuild
            -- therefore layered another copy of the birthsign ability on the last: a Lady's Favor
            -- character (Fortify Endurance 25 + Fortify Personality 25) was reported at +175 on
            -- both attributes and +225 minutes later -- 7 copies, then 9. The engine re-applies
            -- each ability on the next update, guarded by isSpellActive, so after this the count
            -- is exactly one and cannot climb.
            if mp.clearActiveSpells then pcall(mp.clearActiveSpells) end
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
    --
    -- PROTECTED, because everything below reaches into the engine and `restoring` gates the
    -- whole broadcast loop. These seven calls used to sit unguarded between the pcall above and
    -- the reset below, so ONE throw in any of them left `restoring` stuck true and
    -- `baselineReady` never set -- and identity.tick early-returns on `restoring`. The client
    -- would silently stop broadcasting EVERYTHING for the rest of the session: appearance,
    -- equipment, stats, inventory, the lot. No error surfaced, and the player looks frozen and
    -- empty to everyone else while their own screen is fine.
    local okSeed, seedErr = pcall(function()
        last.equipment = fingerprint(snapEquipment())
        last.dynamic = fingerprint(snapDynamic())
        local prog = snapProgression()
        last.progression = fingerprint(prog.attributes)
        last.skills = fingerprint(prog.skills)
        last.level = prog.level
        last.spells = snapSpells()
        last.inventory = fingerprint(snapInventory())
    end)
    if not okSeed then
        -- A half-seeded cache is survivable: the next diff tick re-reads and sends whatever
        -- disagrees. A stuck `restoring` is not, so the reset below happens either way.
        print('[mp] restore: diff cache seeding failed: ' .. tostring(seedErr))
    end
    restoring = false
    baselineReady = true -- the doc IS the character now; the diffs may speak again
    mp.testSet('baselineReady', '1')
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
    -- Same self-silencing shape for the CLASS. The restore sets the class from
    -- record.appearance.class and then writes record.stats.attributes over the rebuilt
    -- character as `.base`. The class bonus baked into those saved bases is whatever class was
    -- current when they were CAPTURED, and it is never reconciled against the class now shown --
    -- so the two can disagree and nothing checks. A live report was exactly that: a sheet
    -- reading Acrobat (favoured Agility+Endurance) whose bases carried the +10 pair on
    -- Strength+Agility instead, which only Crusader and Archer produce. If the engine's class
    -- and the doc's class disagree, say so rather than let the sheet quietly lie.
    if record.appearance and record.appearance.class then
        local okC, live = pcall(function() return NPC.record(self).class end)
        if okC and live and live ~= '' and live ~= record.appearance.class then
            print(string.format('[mp] CLASS MISMATCH AFTER RESTORE: doc=%s engine=%s',
                tostring(record.appearance.class), tostring(live)))
        end
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
