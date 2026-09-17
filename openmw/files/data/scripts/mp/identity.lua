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
local I = require('openmw.interfaces')

local json = require('scripts.mp.json')

local Actor = types.Actor
local NPC = types.NPC

-- active 0.1, not 0.5: movement effects (Levitate, Slowfall, Water Walking, Fortify
-- Acrobatics) must reach and leave the avatar within a tick, or the owner hangs after the
-- expiry and dips on the cast while the peer catches up (#201).
local INTERVALS = { appearance = 1.0, equipment = 0.5, dynamic = 0.25, progression = 1.0, inventory = 2.0, active = 0.1 }
local INVENTORY_CAP = 4096 -- the server's MAX_INVENTORY; 512 silently dropped a collector's later record ids from every declaration and restore
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

local last = { appearance = nil, equipment = nil, dynamic = nil, progression = nil, spells = nil, inventory = nil, active = nil }
local nextAt = { appearance = 0, equipment = 0, dynamic = 0, progression = 0, inventory = 0, acquire = 0, active = 0 }
-- recordId -> count, as of the last acquisition pass. Separate from `last.inventory` because
-- that one only advances on the slow cadence, and comparing against it would re-report the same
-- gain every 0.25 s until the snapshot caught up.
-- Acquisition baseline (count per record id) lives in `last.acquired` so a StateRefused can forget it (#400).
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
        -- A CUSTOM CLASS is a record this engine minted at character creation (Generated:0x<n>);
        -- the next engine has no such record, so the class name, favoured attributes and
        -- major/minor skills -- everything level-ups are counted against -- were lost on every
        -- relog and the character wore the boot template's class. Carry the spec; the restore
        -- rebuilds the record from it (mp.applyChargen).
        classSpec = (function()
            local id = rec.class
            if type(id) ~= 'string' or id:sub(1, 10) ~= 'Generated:' then return nil end
            local ok, spec = pcall(function()
                local c = types.NPC.classes.record(id)
                if not c then return nil end
                local function list(t) local out = {} for i, v in ipairs(t) do out[i] = v end return out end
                return { name = c.name, description = c.description or '', specialization = c.specialization,
                    attributes = list(c.attributes), majorSkills = list(c.majorSkills), minorSkills = list(c.minorSkills) }
            end)
            return ok and spec or nil
        end)(),
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
        -- VAMPIRE FACE. The head swap reads the Vampirism effect on the body, and a puppet never
        -- had it: the disease spell rides the spellbook, which reaches the AVATAR only, never the
        -- other players' puppets (backlog 154). Carry the id of the spell that grants it so
        -- spawnPuppet can add that one spell to the puppet. nil when human.
        vampireSpell = (function()
            local found
            pcall(function()
                for _, spell in pairs(Actor.spells(self)) do
                    for _, e in ipairs(spell.effects or {}) do
                        if e.id == 'vampirism' then found = spell.id return end
                    end
                end
            end)
            return found
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

-- WHAT THE CLIENT HEALED, MEASURED PER FRAME. While the peer's avatar rules our bars
-- (player.lua MP_SelfStats writes them ~4 Hz), a potion, resting or a self-cast restore
-- raises the LOCAL bar between two reports and the next report puts it straight back --
-- so the 4 Hz diff below rarely saw the raise at all, and the server never heard of it
-- (measured: sethp to full, peer-reported bars stayed down; a potion healed a fraction).
-- The heal is still real: it is the sum of the per-frame increases, which no report can
-- take away. Accumulated here, claimed on top of the peer's last word at the next diff.
-- Magicka is the same story in BOTH directions: the avatar never casts, so a cast's cost is
-- a local drop the next report refills (casting was free half the time), and a restore
-- potion is a local rise it takes away. Health claims gains only (damage is the peer's);
-- magicka claims the net local change. Fatigue is NOT tracked: both engines regenerate it,
-- so claiming our regen on top of the avatar's would double the recovery rate.
local tracked = {
    hp = { stat = 'health', gainsOnly = true },
    mp = { stat = 'magicka', gainsOnly = false },
}
for _, t in pairs(tracked) do t.peer = nil; t.prev = nil; t.delta = 0; t.baseSaid = nil end
local peerBarsAt = nil -- when the peer last reported; past PEER_RULES_S our own bars rule again
local PEER_RULES_S = 5 -- server/src/core/players.ts INPUT_DRIVING_MS, the same predicate
local trackLocalChange -- defined below; the report handler needs it first
function identity.notePeerBars(hp, mpv, ft)
    peerBarsAt = core.getRealTime()
    -- BANK THE LOCAL CHANGE BEFORE THE REPORT OVERWRITES IT. The per-frame measurement runs
    -- in onUpdate; a heal and a report landing in the same frame BEFORE that -- a rest, a
    -- potion, then the 4 Hz report -- had the report's write (and its prev) erase the raise
    -- before it was ever measured. Deterministically so for a rest (s150: 8 hours healed
    -- nothing that stuck). Measure now, then let the report set the baseline.
    if trackLocalChange then trackLocalChange() end
    local v = { hp = hp, mp = mpv, ft = ft }
    for k, t in pairs(tracked) do
        if v[k] ~= nil then
            t.peer = v[k]
            t.prev = v[k] -- a report's own write is neither a local gain nor a loss
        end
    end
end
-- A gain this engine PRODUCED and reported itself (mp.restHours returns what the rest
-- healed): banked into the next claim without a read, because the read is what the peer
-- report races (notePeerBars above, backlog 460). prev moves with it so the per-frame
-- tracker does not count the same raise twice when it does get to see it.
function identity.bankGain(gains)
    for k, t in pairs(tracked) do
        local d = tonumber(gains[k])
        if d and (d > 0 or not t.gainsOnly) then
            t.delta = t.delta + d
            if t.prev then t.prev = t.prev + d end
        end
    end
end
trackLocalChange = function()
    for _, t in pairs(tracked) do
        local ok, cur = pcall(function() return Actor.stats.dynamic[t.stat](self).current end)
        if ok and cur and t.prev then
            local d = cur - t.prev
            if d > 0 or not t.gainsOnly then t.delta = t.delta + d end
        end
        if ok and cur then t.prev = cur end
    end
end

local function snapProgression()
    local attributes, skills = {}, {}
    for _, id in ipairs(ATTRIBUTES) do
        local st = Actor.stats.attributes[id](self)
        attributes[id] = st.base
        -- DAMAGE RIDES ALONG, as "<id>_damage" in the same map (no new wire shape): a Damage
        -- Attribute that outlives its spell, and the Restore that heals it, are facts about
        -- the character the avatar and the next login must carry, and .base alone lost them.
        local dmg = st.damage or 0
        if dmg ~= 0 then attributes[id .. '_damage'] = dmg end
    end
    for _, id in ipairs(skillIds()) do
        skills[id] = NPC.stats.skills[id](self).base
    end
    -- The Mark spell's spot (backlog 155): NpcStats only, so nothing carried it and Recall did
    -- nothing after a relog. nil on an engine without the binding.
    local mark
    if mp.getMark then
        local ok, m = pcall(mp.getMark)
        if ok and type(m) == 'table' and m.cell ~= '' then mark = m end
    end
    -- Reputation (backlog 223): NpcStats only, like the mark, so it reset to 0 on every relog
    -- and every PcReputation-gated topic vanished. Rides on PlayerLevel.
    local okRep, rep = pcall(function() return NPC.stats.reputation(self).current end)
    return { attributes = attributes, skills = skills, level = Actor.stats.level(self).current, mark = mark,
        reputation = okRep and type(rep) == 'number' and rep or nil }
end

local function snapSpells()
    local set = {}
    for _, spell in pairs(Actor.spells(self)) do
        set[spell.id] = true
    end
    return set
end

-- ACTIVE EFFECTS, for the avatar. Levitate, Water Walking, Fortify Speed, Chameleon, a potion,
-- a scroll -- cast or drunk on this client and applied to THIS body only, while the peer's
-- avatar is what physics and NPC awareness actually run against. An avatar that does not
-- levitate drags its owner out of the sky through reconciliation; one that is not chameleoned
-- is seen. Temporary effects only: abilities, diseases and curses ride the spellbook, and
-- constant-effect enchantments ride equipment, so both are already on the avatar. Keyed by
-- the engine's own instance id so two potions of the same kind are two entries.
-- Effects the PEER put on us (global.lua MP_SelfActiveSpells): they came from the avatar, so
-- they must not go back to it. Counted per record id; MP_PeerEffect on/off maintains it.
local peerEffects = {}
function identity.notePeerEffect(id, on)
    if type(id) ~= 'string' then return end
    if on then peerEffects[id] = (peerEffects[id] or 0) + 1
    elseif peerEffects[id] then
        peerEffects[id] = peerEffects[id] - 1
        if peerEffects[id] <= 0 then peerEffects[id] = nil end
    end
end

-- Instances of PEER-APPLIED records on this body (a paralysis, a poison the world put on the
-- avatar and the peer relayed here). They are not ours to ADD -- but when one of them
-- disappears from this body while the peer still counts it, the owner CURED it (Cure
-- Paralyzation, Cure Poison, Dispel), and the peer must hear that or the avatar stays frozen
-- and poisoned until the timer runs out, pinning the owner in place through reconciliation.
local peerLocal = {} -- activeSpellId -> record id
local function snapActive()
    local set = {}
    local peerNow = {}
    local ok = pcall(function()
        for _, sp in pairs(Actor.activeSpells(self)) do
            if sp.temporary and not sp.fromEquipment and sp.activeSpellId ~= nil then
                if peerEffects[sp.id] then
                    peerNow[tostring(sp.activeSpellId)] = sp.id
                else
                    local idx = {}
                    for _, e in ipairs(sp.effects or {}) do
                        if e.index ~= nil then idx[#idx + 1] = e.index end
                    end
                    if #idx > 0 then set[tostring(sp.activeSpellId)] = { id = sp.id, effects = idx } end
                end
            end
        end
    end)
    if not ok then return nil end
    -- A peer-applied instance that was here and is gone: cured locally. Say so once.
    local cured = {}
    for aid, rid in pairs(peerLocal) do
        if not peerNow[aid] and peerEffects[rid] then
            cured[#cured + 1] = { key = aid, id = rid }
            identity.notePeerEffect(rid, false)
        end
    end
    peerLocal = peerNow
    return set, cured
end

-- Per-item state the record id cannot express: wear, remaining enchantment charge, and which
-- soul is in a gem. Read through types.Item.itemData(item) (mwlua/itemdata.cpp exposes condition,
-- enchantmentCharge and soul as read/write properties). A FUNCTION on types.Item, not a field of
-- the object: `item.itemData` is nil on every GameObject, and every reader here used that form,
-- so no condition, charge or soul ever left this client (s160 nil/nil/nil, s163). ONE ENTRY PER STACK (#234), always
-- carrying the stack size `n`: a stateless stack is a bare {n=k}, so the appliers can walk the
-- record's stacks in order and split a stack that is bigger than its entry -- an index alone
-- is not an identity (one Soultrap filled all three gems of a stack; two daggers swapped
-- conditions per relog).
--
-- `own` (#233): a lockpick, probe, repair tool or light wears only HERE -- the avatar never
-- picks a lock or burns a torch -- so the server copies its condition wholesale instead of
-- raise-only, and the peer's untouched copy must not refill it.
local OWN_WEAR_TYPES = {} -- type -> its name, sent as `t` so the server can check the kind (340)
for _, name in ipairs({ 'Lockpick', 'Probe', 'Repair', 'Light' }) do
    if types[name] then OWN_WEAR_TYPES[types[name]] = name end
end
local function itemState(item)
    local st = { n = item.count or 1 }
    local ok, d = pcall(function() return types.Item.itemData(item) end)
    if not ok or d == nil then return st end
    local okc, c = pcall(function() return d.condition end)
    if okc and type(c) == 'number' then st.condition = c end
    local oke, e = pcall(function() return d.enchantmentCharge end)
    if oke and type(e) == 'number' then st.charge = e end
    local oks, sl = pcall(function() return d.soul end)
    if oks and type(sl) == 'string' and sl ~= '' then st.soul = sl end
    local okt, t = pcall(function() return item.type end)
    if okt and t ~= nil and OWN_WEAR_TYPES[t] then
        st.own = true
        st.t = OWN_WEAR_TYPES[t]
    end
    return st
end

-- BOUND ITEMS ARE NOT POSSESSIONS. A Bound Dagger exists for the spell's duration and the
-- engine takes it back; the doc recorded it like any dagger, so a relog inside the window
-- granted a permanent one. The engine names every bound record in a GMST; skip those.
local boundIds = nil
local function isBoundRecord(id)
    if boundIds == nil then
        boundIds = {}
        pcall(function()
            for _, name in ipairs({ 'sMagicBoundBattleAxeID', 'sMagicBoundCuirassID', 'sMagicBoundDaggerID',
                'sMagicBoundGlovesID', 'sMagicBoundHelmID', 'sMagicBoundLongbowID', 'sMagicBoundLongswordID',
                'sMagicBoundMaceID', 'sMagicBoundShieldID', 'sMagicBoundSpearID', 'sMagicBoundBootsID',
                'sMagicBoundLeftGauntletID', 'sMagicBoundRightGauntletID' }) do
                local v = core.getGMST(name)
                if type(v) == 'string' and v ~= '' then boundIds[string.lower(v)] = true end
            end
        end)
    end
    return boundIds[string.lower(tostring(id))] == true
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
        if not isBoundRecord(item.recordId) then
            if not counts[item.recordId] then
                order[#order + 1] = item.recordId
            end
            counts[item.recordId] = (counts[item.recordId] or 0) + item.count
            local bucket = states[item.recordId]
            if not bucket then bucket = {}; states[item.recordId] = bucket end
            bucket[#bucket + 1] = itemState(item)
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

-- TALKED-TO (backlog 230). TalkedToPc is a flag on each NPC's CreatureStats, per engine, and
-- nothing in multiplayer saves it: every NPC greeted a returning character as a stranger.
-- Read off the actors around us (a conversation happens within reach), sent as it is learned,
-- persisted on the doc, and put back on every NPC we meet again after a relog.
local talkedTo = {} -- obj.id -> true (own doc's set; the record seeds it)
local function talkedToTick()
    if not (mp.talkedTo and mp.setTalkedTo) then return end
    local fresh = {}
    for _, obj in ipairs(require('openmw.nearby').actors) do
        if obj.contentFile and obj.id ~= self.id then
            local ok, said = pcall(mp.talkedTo, obj)
            if ok and said and not talkedTo[obj.id] then
                talkedTo[obj.id] = true
                fresh[#fresh + 1] = { ref = obj }
            elseif ok and not said and talkedTo[obj.id] then
                pcall(mp.setTalkedTo, obj)
            end
        end
    end
    if #fresh > 0 then mp.sendEvent('PlayerTalkedTo', { list = fresh }) end
end
-- The doc's set at join (SelfTalkedTo): keyed by object id, re-applied as they come near.
function identity.applyTalkedTo(list)
    for _, e in ipairs(type(list) == 'table' and list or {}) do
        local okId, id = pcall(function() return e.ref and e.ref.id end)
        if okId and id then talkedTo[id] = true end
    end
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
        mp.set('equippedIds', table.concat(ids, ','))
    end

    local dead = Actor.isDead(self)
    if dead and not wasDead then
        -- Death edge: dynamic snapshot NOW (hp 0) + PlayerDeath, ahead of any timer.
        last.dynamic = fingerprint(snapDynamic())
        mp.sendEvent('PlayerStatsDynamic', snapDynamic())
        mp.sendEvent('PlayerDeath', {})
        -- The dead do not talk (backlog 33): close a conversation the killer interrupted,
        -- which also lets go of the DialogueLock this client holds; the server drops it on
        -- PlayerDeath too, so a corpse never keeps an NPC refused to everyone else.
        pcall(function() I.UI.removeMode('Dialogue') end)
    end
    wasDead = dead

    trackLocalChange()
    if now >= nextAt.dynamic then
        nextAt.dynamic = now + INTERVALS.dynamic
        local dyn = snapDynamic()
        mp.set('hp', tostring(dyn.hp.c)) -- mirror unconditionally (diff may be seeded)
        if peerBarsAt and now - peerBarsAt < PEER_RULES_S and not dead then
            -- THE PEER RULES OUR BARS: send only what we changed, on top of what the peer
            -- last said -- never a bar we merely echo from its report. An echoed report the
            -- peer has since overtaken (a bite landed, a spend applied) would be taken as a
            -- fresh claim: the bite undone, the cast refilled (s113).
            local claim, any = {}, false
            for k, t in pairs(tracked) do
                -- A changed MAXIMUM is a claim too (a level-up, endurance, intelligence): the
                -- base is ours to say, and the avatar must get it or the new maximum exists
                -- on no body that fights.
                local baseMoved = t.baseSaid ~= nil and math.abs(dyn[k].b - t.baseSaid) > 0.5
                if math.abs(t.delta) > 0.5 or baseMoved then
                    -- THE GAIN RIDES ALONG AS `d` (backlog 461). `c` is `last report + gain`,
                    -- and the last report is stale for a round trip after every raise the
                    -- server applies: each claim in that window was BELOW the doc, ignored
                    -- as an echo, and its gain was zeroed here -- a 10x5 restore reached the
                    -- avatar as +6..+10 of 50 (s165). The server adds `d` to what it holds.
                    claim[k] = { c = math.floor(math.max(0, math.min(dyn[k].b, t.peer + t.delta)) + 0.5), b = dyn[k].b,
                        d = math.floor(t.delta * 10 + 0.5) / 10 }
                    any = true
                end
                t.baseSaid = dyn[k].b
                t.delta = 0
            end
            if any then
                mp.sendEvent('PlayerStatsDynamic', claim)
                if claim.hp then mp.set('hpClaim', string.format('%d+%s', claim.hp.c, tostring(claim.hp.d))) end
            end
            last.dynamic = nil -- the next full snapshot (peer gone) must send unconditionally
        else
            -- OUR OWN BARS RULE (no fresh report) -- but the server may still be inside its
            -- own freshness window, in which case it reads this snapshot as a claim, and a
            -- gain zeroed here without being said was a heal that reached nobody (s150: the
            -- rest's +24 in a frame the peer's word had gone stale). Say it, then zero it.
            local fp = fingerprint(dyn) -- of the bars alone: a gain is not a change to re-send
            local anyGain = false
            for k, t in pairs(tracked) do
                if math.abs(t.delta) > 0.5 then
                    dyn[k].d = math.floor(t.delta * 10 + 0.5) / 10
                    anyGain = true
                end
                t.delta = 0
            end
            if fp ~= last.dynamic or anyGain then
                last.dynamic = fp
                mp.sendEvent('PlayerStatsDynamic', dyn)
                if dyn.hp.d then mp.set('hpClaim', string.format('%d+%s', dyn.hp.c, tostring(dyn.hp.d))) end
            end
        end
    end

    if baselineReady and now >= nextAt.progression then
        nextAt.progression = now + INTERVALS.progression
        talkedToTick()
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
        if prog.level ~= last.level or prog.reputation ~= last.reputation then
            last.level = prog.level
            last.reputation = prog.reputation
            mp.sendEvent('PlayerLevel', { level = prog.level, reputation = prog.reputation })
        end
        -- The mark, when the engine can read one; only a SET mark is sent (nothing clears one).
        if prog.mark then
            local mfp = fingerprint(prog.mark)
            if mfp ~= last.mark then
                last.mark = mfp
                mp.sendEvent('PlayerMark', prog.mark)
            end
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

    -- Through global for the record registry, like equipment and the spellbook: a brewed
    -- potion or a self-enchanted ring is a `Generated:` id that means nothing to the next
    -- engine, so an inventory sent raw came back on relog as nothing -- or as whatever
    -- record the new engine had minted under that number.
    if baselineReady then
        diffSend('inventory', 'PlayerInventory', snapInventory, now, function(_, snap)
            core.sendGlobalEvent('mpInventoryOut', snap)
        end)
    end

    if now >= nextAt.active then
        nextAt.active = now + INTERVALS.active
        local active, cured = snapActive()
        if active then
            local add, remove = {}, {}
            for _, c in ipairs(cured or {}) do remove[#remove + 1] = c end
            for key, sp in pairs(active) do
                if not (last.active and last.active[key]) then
                    add[#add + 1] = { key = key, id = sp.id, effects = sp.effects }
                end
            end
            for key, sp in pairs(last.active or {}) do
                if not active[key] then remove[#remove + 1] = { key = key, id = sp.id } end
            end
            if #add > 0 or #remove > 0 then
                -- Through global for the record registry (toNet), like the spellbook.
                core.sendGlobalEvent('mpActiveSpellsOut', { add = add, remove = remove })
            end
            last.active = active
        end
    end

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
        if last.acquired ~= nil then
            for id, n in pairs(counts) do
                local before = last.acquired[id] or 0
                if n > before then
                    mp.sendEvent('PlayerItemAcquired', { id = id, n = n - before })
                end
            end
        end
        last.acquired = counts
    end
end

-- Rejoin: session ended -> everything must be re-sent on the next join (unless restored).
-- Called when chargen completes: global.lua sees chargenstate hit -1 and forwards it. The
-- restore path sets the same flag from applyPhase2. Idempotent.
function identity.markBaselineReady()
    baselineReady = true
    mp.set('baselineReady', '1')
end

-- THE AVATAR WAS (RE)BUILT -- a peer restart, a body rebuild -- and knows none of our
-- temporary effects; our diff cache says they were sent, so it would never say them again.
-- Forget the active set: the next tick re-adds every running effect (adds are idempotent
-- by instance on the peer's side, which has none after a rebuild). Levitating players were
-- dragged out of the sky by the new body; chameleoned ones were seen.
function identity.resyncActive()
    last.active = nil
end

-- The server refused a declaration of this event name: drop the cache for that kind so the
-- next tick re-sends (it may pass then -- the doc it was judged against has moved on).
local KIND_OF_EVENT = { PlayerAppearance = 'appearance', PlayerEquipment = 'equipment', PlayerInventory = 'inventory',
    PlayerSpellbook = 'spells', PlayerAttributes = 'progression', PlayerSkills = 'skills', PlayerLevel = 'level',
    PlayerStatsDynamic = 'dynamic', PlayerMark = 'mark', PlayerActiveSpells = 'active', PlayerItemAcquired = 'acquired' }
-- Capped (backlog 336): a declaration the server will NEVER accept (a level jump, a record
-- kind it cannot register) re-sent every tick is an anomaly + warn per tick, forever. Three
-- retries per kind while the declared value stands still; a changed fingerprint resets it.
local MAX_FORGETS = 3
local forgets = {} -- kind -> { fp = fingerprint last forgotten, n = forgets of that fingerprint }
function identity.forgetDeclared(eventName)
    local kind = KIND_OF_EVENT[eventName]
    if not kind then return end
    local cur = last[kind]
    local fp = type(cur) == 'table' and fingerprint(cur) or cur
    local f = forgets[kind]
    if f and f.fp == fp then
        f.n = f.n + 1
    else
        f = { fp = fp, n = 1 }
        forgets[kind] = f
    end
    if f.n > MAX_FORGETS then return end
    last[kind] = nil
end

-- Spells whose add went out under a local id (global.lua mpSpellbookOut): diffed again next
-- tick, by which time the registry answers with the net id.
function identity.forgetSpells(ids)
    if not last.spells then return end
    for _, id in ipairs(ids or {}) do last.spells[id] = nil end
end

function identity.reset()
    last = {}
    forgets = {}
    for _, t in pairs(tracked) do t.peer = nil; t.prev = nil; t.delta = 0; t.baseSaid = nil end
    peerBarsAt = nil
    -- nil, NOT {}: the next pass must re-seed the baseline rather than treat the whole restored
    -- inventory as newly acquired.
    last.acquired = nil
    nextAt = { appearance = 0, equipment = 0, dynamic = 0, progression = 0, inventory = 0, acquire = 0, active = 0 }
    wasDead = false
    restoring = false
    pendingPhase2 = nil
    talkedTo = {}
    -- SHUT THE GATE AGAIN. reset() runs every tick while we are not Joined -- a disconnect, a
    -- reconnect, a world hop -- and leaving baselineReady true across that reopens the exact
    -- hole it exists to close: the engine is the raw template again until the new world's
    -- record lands, and an open gate broadcasts that template over the real character. It is
    -- reopened by the same two events as the first time: applyPhase2 for a returning character,
    -- MP_ChargenDone for a brand new one.
    baselineReady = false
    mp.set('baselineReady', '0') -- the mirror must not keep saying 1 across a reset (it did)
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
            classSpec = record.appearance.classSpec, -- a custom class, rebuilt when the id is unknown
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
    -- Form (werewolf) is restored at the END of phase 2, not here: see applyPhase2.
    pendingPhase2 = record
    phase2At = core.getRealTime() + 0.5
end

local function applyPhase2(record)
    local ok, err = pcall(function()
        local stats = record.stats or {}
        if stats.level then Actor.stats.level(self).current = stats.level end
        if stats.reputation then pcall(function() NPC.stats.reputation(self).current = stats.reputation end) end
        for id, v in pairs(stats.attributes or {}) do
            local base = id:match('^(.-)_damage$')
            local stat = Actor.stats.attributes[base or id]
            if stat and base then stat(self).damage = v
            elseif stat then stat(self).base = v end
        end
        for id, v in pairs(stats.skills or {}) do
            local stat = NPC.stats.skills[id]
            if stat then stat(self).base = v end
        end
        local dyn = stats.dynamic
        if dyn then
            local d = Actor.stats.dynamic
            if dyn.hp then
                -- NEVER RESTORE A CORPSE. Death is a flush point, so a player who died and
                -- closed the tab has hp 0 on record. Writing 0 onto the live player kills
                -- them on arrival, the death edge fires again (wasDead was reset), the world
                -- hears "X has fallen" a second time and the respawn plugin runs again --
                -- at the spot they died, so a bad spot became a loop across rejoins. They
                -- already paid for that death. Back at a sliver of health, where they fell.
                d.health(self).base = dyn.hp.b
                d.health(self).current = (dyn.hp.c > 0) and dyn.hp.c or math.max(1, math.floor(dyn.hp.b * 0.1))
            end
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
        -- The Mark spot (backlog 155). Its own pcall: an older engine has no setMark.
        if record.mark and mp.setMark and type(record.mark.cell) == 'string' and record.mark.cell ~= '' then
            pcall(mp.setMark, record.mark.cell, record.mark.x or 0, record.mark.y or 0, record.mark.z or 0)
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
    -- Form LAST. setWerewolf(true) takes a snapshot of the human attributes/skills and lays
    -- the werewolf modifiers over them; it must run after applyChargen (which rebuilds the
    -- player record and would undo it) AND after the base writes above, or the snapshot is
    -- of the chargen defaults and the dawn revert leaves negative modifiers (backlog #153).
    if record.appearance and record.appearance.isWerewolf == true then
        pcall(function() NPC.setWerewolf(self, true) end)
    end
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
        last.reputation = prog.reputation
        last.mark = prog.mark and fingerprint(prog.mark) or nil
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
    mp.set('baselineReady', '1')
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
    mp.set('restored', '1')
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
