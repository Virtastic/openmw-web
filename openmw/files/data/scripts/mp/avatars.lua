-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- THE PEER DRIVING THE AVATARS (GLOBAL context, required by global.lua). Split out of
-- global.lua (OT3-238): input routing state, the authoritative pose / stats / item-state /
-- effects streams back to the owners, the avatar inventory docs, local summons, script notes,
-- arrest and the pvp policy push. global.lua calls M.init once with the state it owns.
local core = require('openmw.core')
local mp = require('openmw.mp')
local types = require('openmw.types')
local world = require('openmw.world')
local json = require('scripts.mp.json')
local net = require('scripts.mp.net')
local objects = require('scripts.mp.objects')
local actors = require('scripts.mp.actors')
local worldmp = require('scripts.mp.world')
local reconcile = require('scripts.mp.reconcile')

local M = {}
-- From global.lua: puppets / remoteIdentity (shared tables), applyItemStates,
-- pushEquipmentToPuppet, kit, and ownCellKey() (its cell key changes under us).
local deps, puppets, remoteIdentity, applyItemStates, pushEquipmentToPuppet, kit
function M.init(d)
    deps, puppets, remoteIdentity = d, d.puppets, d.remoteIdentity
    applyItemStates, pushEquipmentToPuppet, kit = d.applyItemStates, d.pushEquipmentToPuppet, d.kit
end


-- Phase 3: the input->avatar routing table. lastInputSeq[id] is the newest input routed to
-- that avatar — stamped onto the authoritative pose stream so the owner's client knows how
-- much of its input the pose already contains (reconciliation hangs off it).
local lastInputSeq = {}
-- The newest seq each avatar has APPLIED (avatar.lua mpAvatarApplied), which is what the pose
-- stream is stamped with. lastInputSeq above is what has been ROUTED, a frame or two ahead of
-- the body; stamping that made every pose claim input it did not yet contain.
local appliedSeq = {}
local appliedPose = {} -- id -> {x,y,z,at}: the pose as of appliedSeq[id]
local APPLIED_POSE_FRESH_S = 0.25
local avatarUsing = {} -- id -> the use bit of the newest routed input (mirrors "attacking")
-- The owner's whole posture, not just the use bit. The avatar stream used to forward only
-- "attacking" and "weapon drawn", so under the peer a friend sneaking walked upright on every
-- other screen, never jumped, and never showed a spell stance (s145). run / sneak come from
-- the newest input; a jump is an EDGE in a 30 Hz input stream and the avatar stream is
-- slower, so it is latched until the next stream entry carries it.
local lastInputFlags = {} -- id -> flags of the newest routed input
local jumpPending = {} -- id -> true until the next avatar stream entry has carried the edge
-- THE SAME FOR A CLICK. Two inputs often land in one peer frame (30 Hz against 20 fps), and a
-- quick click -- use on one input, off on the next -- left avatarUsing false at the stream: the
-- avatar swung (avatar.lua latches it, #198) and the friend saw the damage with no swing.
local usePending = {} -- id -> true until the next avatar stream entry has carried a use press
local avatarStreamAt = 0
-- THE FRIEND'S POSE IS THE BODY, NOT THE OWNER'S RECONCILE POINT. appliedPose is where the body
-- stood when the owner's last fully played input ended (avatar.lua), a frame old by the time its
-- event lands here: the right pair for the owner's reconciliation, but ~50 ms + the unfinished
-- segment behind the body for everyone else. Each such entry is preceded by one carrying the body
-- itself with this bit set; the server fans that one out and keeps the seq-matched one for the
-- owner (connection.ts). A server that predates the bit lets the second entry win: today's pose.
local POSE_OBSERVER_BIT = 128
-- Under the peer's 50 ms frame, not equal to it: at 0.05 a 49.9 ms frame missed the gate and
-- every other frame went unsent (s172 #158: 83 ms median between poses, not 50).
local AVATAR_STREAM_EVERY = 0.04

-- Phase 2b: full character docs for PEER-side avatars, keyed by connection id. A cosmetic
-- puppet only needs a look; the peer's copy must FIGHT and TRADE correctly, so the server
-- sends the whole PlayerDoc (AvatarState) and it is applied to the body here. Client
-- processes never receive AvatarState and never enter this path.
local avatarDocs = {}
-- Avatars whose doc must be (re)applied this frame: MP_AvatarState marks, the per-frame tick
-- applies ONCE with the latest doc, and a pass that left anything in flight marks again.
local avatarDocDirty = {}
-- The frame each avatar's doc was last applied in (reconcile.worldGivenSpells reads it).
local avatarDocAppliedGen = {}

-- The party leader's level, from their avatar doc, onto the engine (peer only). Called when
-- the leader is named (WorldMode) and whenever their doc arrives or changes (AvatarState).
M.partyOwnerId = 0
local partyLevelSaid = nil
local function applyPartyLevel()
    if not mp.isSystem() then return end
    local doc = M.partyOwnerId > 0 and avatarDocs[M.partyOwnerId] or nil
    local level = doc and doc.stats and tonumber(doc.stats.level) or 0
    if level ~= (partyLevelSaid or -1) then
        partyLevelSaid = level
        mp.setPartyLevel(level)
        print(string.format('[mp] party level -> %d (leader #%d)', level, M.partyOwnerId))
    end
end

-- Backlog 507: ids whose avatar shed something, and when to read what the shed left them
-- able to do (a frame later: the engine applies a Lua inventory change at the end of the
-- frame). Drained by shedProbeTick on the peer.
local shedProbeAt = {}

local function applyAvatarDoc(id)
    local doc = avatarDocs[id]
    local p = puppets and puppets[id]
    if not doc or not p or not p.obj or not p.obj:isValid() then return end
    local obj = p.obj
    -- The bounty rides the doc, and the avatar is who the world should hold responsible for it.
    -- Seeded here as well as on live CrimeUpdate, so a player who arrives ALREADY wanted is
    -- pursued on sight instead of only after their next offence.
    pcall(function() mp.setAvatarBounty(obj, doc.bounty or 0) end)
    -- Faction ranks too (#145): an NPC's aggression toward the avatar reads ITS memberships,
    -- and an avatar in no faction was a stranger to every guild hall its owner belongs to.
    if type(doc.factions) == 'table' then
        local list = {}
        for fid, f in pairs(doc.factions) do
            if type(f) == 'table' then
                list[#list + 1] = { id = fid, rank = f.rank or 1, reputation = f.reputation or 0, expelled = f.expelled == true }
            end
        end
        if #list > 0 then pcall(function() mp.setAvatarFactions(obj, list) end) end
    end
    -- Stats first: a fight against a default-statted mannequin is the bug this fixes.
    -- IN THE AVATAR'S OWN SCRIPT. Every stat setter in mwlua/stats.cpp is Self-gated
    -- ("Allowed only in local scripts for 'openmw.self'"); writing them from here threw on
    -- the first line, and the pcall that used to wrap this block swallowed it -- so the
    -- avatar stayed the level-1 template it was built from: attributes, skills, level and
    -- the HEALTH POOL. A level-20 player's avatar had a level-1 body's bars.
    pcall(function() obj:sendEvent('mpAvatarStats', doc.stats or {}) end)
    for _, sid in ipairs(doc.spells or {}) do
        pcall(function() types.Actor.spells(obj):add(sid) end)
    end
    -- INVENTORY: the doc is the avatar's truth. reconcile.lua grants the shortfall and sheds the
    -- surplus and every record the doc does not list -- the template NPC's own kit included (the
    -- body is built from an NPC record that brings its sword and spells) -- counting what is
    -- still in flight this frame, so two docs in one slow peer frame converge instead of
    -- stacking (backlog 507). What the owner has EQUIPPED is kept: pushEquipmentToPuppet
    -- fabricates an item for a slot the doc's list may not mention, and stripping it left an
    -- unarmed avatar. `nil` means "not synced yet" and sheds nothing; an EMPTY list is a real
    -- statement ("this player carries nothing") and does. THE PLACEHOLDER BAN (Phase 2b): an
    -- item that cannot be built is loud and simply absent -- a stand-in weapon computes the
    -- wrong damage.
    pcall(function()
        local inventory = types.Actor.inventory(obj)
        local key = 'p:' .. kit.idKey(id)
        local items = {}
        for _, entry in ipairs(doc.inventory or {}) do
            items[#items + 1] = { id = worldmp.toLocal(entry.id), n = entry.n or 1 }
        end
        local keep = {}
        local eq = remoteIdentity[id] and remoteIdentity[id].equipment
        for _, recordId in pairs((eq and eq.slots) or {}) do keep[worldmp.toLocal(recordId)] = true end
        local r = reconcile.reconcileInventory({
            inventory = inventory, items = items, key = key, keep = keep, shed = doc.inventory ~= nil,
            createObject = function(rid, n) return world.createObject(rid, n) end,
            log = function(msg) print('[mp] avatar #' .. tostring(id) .. ' ' .. msg) end,
        })
        for _, rid in ipairs(r.unresolved) do
            print('[mp] AVATAR ITEM UNRESOLVABLE for #' .. tostring(id) .. ': ' .. tostring(rid))
            mp.set('avatarUnresolvable', tostring(rid))
        end
        -- Per-item state onto what has LANDED; a record still in flight gets its state on the
        -- pass that finds it there. Idempotent: a layout already applied splits nothing.
        for recId, bucket in pairs(doc.itemStates or {}) do
            pcall(applyItemStates, inventory, worldmp.toLocal(recId), bucket, key)
        end
        -- What the shed left the body able to do, read a frame later (backlog 507).
        if r.removed > 0 then shedProbeAt[id] = core.getRealTime() + 1.0 end
        -- Not finished while anything is in flight: again next frame, and it converges.
        if r.pending or reconcile.anyInFlight(key) then avatarDocDirty[id] = true end
    end)
    if doc.spells ~= nil then
    pcall(function()
        local keep = {}
        for _, sid in ipairs(doc.spells) do keep[sid] = true end
        local spells = types.Actor.spells(obj)
        local drop = {}
        for _, sp in pairs(spells) do
            local sid = type(sp) == 'table' and sp.id or sp
            -- Racial/birthsign abilities ride the doc's spell list (identity.lua snapshots
            -- them as spells), so anything absent is the template's.
            if sid and not keep[sid] then drop[#drop + 1] = sid end
        end
        for _, sid in ipairs(drop) do pcall(function() spells:remove(sid) end) end
    end)
    end
    if doc.spells ~= nil then avatarDocAppliedGen[id] = reconcile.generation() end
    mp.set('avatarApplied', tostring(id))
    -- RE-BIND THE HANDS TO THE RECONCILED STACKS. The equipment push can arrive before the
    -- inventory doc and fabricates a single item for an empty slot; the doc then grants the
    -- real stack beside it. An avatar whose quiver slot still pointed at that lone arrow
    -- loosed exactly one shot and then stood there with 19 in the pack (s138).
    pushEquipmentToPuppet(id)
end

-- One apply per avatar per frame, with the latest doc (MP_AvatarState only marks). Keys are
-- collected first: a pass may mark its own avatar dirty again for the next frame.
local function avatarDocTick()
    local ids = {}
    for id in pairs(avatarDocDirty) do ids[#ids + 1] = id end
    avatarDocDirty = {}
    for _, id in ipairs(ids) do applyAvatarDoc(id) end
end

-- Phase 3 (peer only): stream the authoritative avatar poses back. mp.sendAvatarMoveBatch
-- -> 0x0105 -> the server fans out 0x0101 to everyone and 0x0103 (with lastInputSeq) to
-- each owner. Sent fresh every pass — a stale pose is a rubber-band on the wrong side.
-- HARNESS DIAGNOSTIC (peer): say what the engine thinks of a submerged avatar's drowning
-- inputs. The only window into the peer's side of s149 — but this ships in production Lua
-- and every line is a sync append to the peer's log, so once per 10 s, not once a second.
local DROWN_PROBE_EVERY = 10
local drownSaidAt = 0
local function avatarDrownProbe(now)
    if now - drownSaidAt < DROWN_PROBE_EVERY then return end
    drownSaidAt = now
    for id, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            local ok, d = pcall(mp.drownState, p.obj)
            if ok and d and d.submerged then
                local okh, hp = pcall(function() return types.Actor.stats.dynamic.health(p.obj).current end)
                print(string.format('[mp] avatar #%d submerged: breath=%s hp=%s god=%s wb=%s inRange=%s ai=%s dead=%s', id,
                    tostring(d.breath), tostring(okh and hp or '?'), tostring(d.godmode), tostring(d.waterBreathing), tostring(d.inRange), tostring(d.aiActive), tostring(d.dead)))
            end
        end
    end
end

-- HARNESS DIAGNOSTIC (peer): the fall the avatar took, and what it cost. Three sweeps of
-- s147 showed the peer's bar unmoved after a 1300-unit fall and reading could not say
-- whether the avatar ever left the ground on the peer, or landed and was not charged.
-- The ground read lives in avatar.lua (backlog 341: types.Actor.isOnGround takes an LObject;
-- this script's GObject was rejected, so the probe never fired); it reports mpAvatarLanded.
local function avatarLanded(data)
    if not (data and data.obj) then return end
    for id, p in pairs(puppets) do
        if p.obj and p.obj:isValid() and p.obj.id == data.obj.id then
            local okh, hp = pcall(function() return types.Actor.stats.dynamic.health(p.obj).current end)
            print(string.format('[mp] avatar #%d landed from z=%d at z=%d (fell %d) hp=%s', id,
                math.floor(data.top), math.floor(data.z), math.floor(data.top - data.z), tostring(okh and hp or '?')))
            return
        end
    end
end

-- WHAT A SHED LEFT THE BODY ABLE TO DO (backlog 507), read a frame after the shed so the
-- engine has applied it. One line per shed: encumbrance against capacity says whether the
-- weight is still the reason the avatar will not walk, and the item line says what is left.
local function shedProbeTick(now)
    for id, at in pairs(shedProbeAt) do
        if now >= at then
            shedProbeAt[id] = nil
            local pp = puppets[id]
            if pp and pp.obj and pp.obj:isValid() then
                pcall(function()
                    local held, inv = {}, types.Actor.inventory(pp.obj)
                    for _, item in ipairs(inv:getAll()) do
                        if #held < 8 then held[#held + 1] = string.format("%sx%d", tostring(item.recordId), item.count or 1) end
                    end
                    print(string.format("[mp] avatar #%s a frame after the shed: encumbrance %.0f/%.0f walk %.0f speed %.0f; carrying %s",
                        tostring(id), types.Actor.getEncumbrance(pp.obj), types.Actor.getCapacity(pp.obj),
                        types.Actor.getWalkSpeed(pp.obj), types.Actor.getCurrentSpeed(pp.obj),
                        #held > 0 and table.concat(held, " ") or "nothing"))
                end)
            end
        end
    end
end

local function avatarStreamTick(now)
    if not (mp.isSystem()) then return end
    avatarDrownProbe(now)
    shedProbeTick(now)
    if now - avatarStreamAt < AVATAR_STREAM_EVERY then return end
    avatarStreamAt = now
    local entries = {}
    for id, p in pairs(puppets) do
        -- NOT BEFORE THE BODY IS PLACED. createObject + teleport lands at the end of the frame;
        -- in between the object has no cell and its position reads (0,0,0), and a peer that
        -- spawns its avatars the frame it joins (a restart into a full world) streamed that as
        -- each player's first authoritative pose -- a 70,000-unit self snap to the world
        -- origin for everyone with fresh input (s69, #132 / backlog 503).
        if p.obj and p.obj:isValid() and p.obj.cell then
            local ok = pcall(function()
                -- The seq-matched pose while inputs are flowing; the body's own position once they
                -- stop (the avatar coasts, falls, is shoved, and nothing re-stamps it then).
                local ap = appliedPose[id]
                local body = p.obj.position
                local matched = ap and now - ap.at < APPLIED_POSE_FRESH_S
                local pos = matched and ap or body
                local walkSpeed = types.Actor.getWalkSpeed(p.obj)
                local animVel = walkSpeed > 0 and (types.Actor.getCurrentSpeed(p.obj) / walkSpeed) or 0
                local e = {
                    id = id,
                    lastInputSeq = appliedSeq[id] or 0,
                    x = pos.x, y = pos.y, z = pos.z,
                    yaw = p.obj.rotation:getYaw(),
                    pitch = p.obj.rotation:getPitch(),
                    -- bit 3: the avatar is attacking (its owner's use bit reached it). Rides
                    -- the pose flags so the owner's state batch -- and every observer's move
                    -- batch -- carries it; player.lua mirrors it as selfFlags for s67.
                    -- bit 4: weapon drawn, so every observer's puppet shows the same posture.
                    flags = (lastInputFlags[id] or 0) % 4 -- bits 0-1: run, sneak (owner's input)
                        + (jumpPending[id] and 4 or 0) -- bit 2: a latched jump edge
                        + ((avatarUsing[id] or usePending[id]) and 8 or 0)
                        + (types.Actor.getStance(p.obj) == types.Actor.STANCE.Weapon and 16 or 0)
                        -- bit 5 from the OWNER's input: the avatar deliberately never enters
                        -- the spell stance (avatar.lua -- it must never cast), so its own
                        -- stance can never say "spell ready"; the friend's screen still should.
                        + (math.floor((lastInputFlags[id] or 0) / 32) % 2 == 1 and 32 or 0),
                    animVel = animVel,
                }
                if matched and #entries < 254 then
                    entries[#entries + 1] = { id = id, lastInputSeq = e.lastInputSeq, x = body.x, y = body.y, z = body.z,
                        yaw = e.yaw, pitch = e.pitch, flags = e.flags + POSE_OBSERVER_BIT, animVel = animVel }
                end
                entries[#entries + 1] = e
            end)
            -- On a throw the entry was never appended (the constructor is what threw), so
            -- `entries[#entries] = nil` used to delete the PREVIOUS player's pose instead.
            if ok then jumpPending[id] = nil; usePending[id] = nil end
        end
    end
    if #entries > 0 then mp.sendAvatarMoveBatch(entries) end
end

-- Phase 4A: the peer reports each avatar's dynamic stats back to the server, which owns the
-- character doc and forwards the owner their own bars (MP_SelfStats). This replaces the
-- client asserting its own hp/mp/ft while the input tier is driving: damage the avatar takes
-- on the peer (NPC swings, falls, spells) is what everyone -- including the owner -- sees.
local avatarStatsAt = 0
local AVATAR_STATS_EVERY = 0.25
local deadMismatchAt = {} -- id -> last time the isDead/hp mismatch was said
local avatarStatsLast = {} -- id -> serialized last report (diff suppression)
local avatarStatsSentAt = {} -- id -> last SEND time: dropped is not the same as unchanged
local avatarStatsAnnounced = false
local AVATAR_STATS_REFRESH_S = 3.0

local function avatarStatsTick(now)
    if not (mp.isSystem()) then return end
    if now - avatarStatsAt < AVATAR_STATS_EVERY then return end
    avatarStatsAt = now
    local entries = {}
    for id, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            local ok, entry = pcall(function()
                local d = types.Actor.stats.dynamic
                local hp, m, ft = d.health(p.obj), d.magicka(p.obj), d.fatigue(p.obj)
                -- HARNESS DIAGNOSTIC (s22 #178): a body the engine holds DEAD while its bar reads
                -- above zero floats to the surface and never drowns on; the server then refuses
                -- its PlayerDeath (hp > 0). Say so once a second, with what wrote the bar.
                local okd, isDead = pcall(types.Actor.isDead, p.obj)
                if okd and (isDead == true) ~= (hp.current < 1) and now - (deadMismatchAt[id] or 0) >= 1 then
                    deadMismatchAt[id] = now
                    print(string.format('[mp] avatar #%s dead-latch mismatch: isDead=%s hp=%.1f/%.1f', tostring(id), tostring(isDead), hp.current, hp.base))
                end
                return { id = id,
                    hp = { c = hp.current, b = hp.base },
                    mp = { c = m.current, b = m.base },
                    ft = { c = ft.current, b = ft.base },
                    -- Backlog 73: knocked down here = the owner must stop walking (player.lua).
                    -- ...or PARALYZED: a placed avatar no longer freezes its owner by refusing to
                    -- move, so the owner walked on (and dragged it) until the 1 Hz effect relay.
                    kd = ((mp.isKnockedDown(p.obj)) == true or (function()
                        local ok, e = pcall(function() return types.Actor.activeEffects(p.obj):getEffect('paralyze') end)
                        return ok and e ~= nil and (e.magnitude or 0) > 0
                    end)()) or nil,
                    -- Backlog 312: a block since the last report; the owner plays its sound.
                    blk = (function() local s = mp.takeBlock(p.obj); return s ~= '' and s or nil end)() }
            end)
            if ok and entry then
                local key = string.format('%d:%.1f/%.1f %.1f/%.1f %.1f/%.1f %s', entry.id,
                    entry.hp.c, entry.hp.b, entry.mp.c, entry.mp.b, entry.ft.c, entry.ft.b, tostring(entry.kd))
                -- Diff for cadence, REFRESH for correctness: the server may drop a report
                -- (the owner's input tier not warmed up yet, a teleport race), and a dropped
                -- report the diff never retries is a player whose bars freeze forever.
                -- A block is an event, not a state: it always goes out.
                if entry.blk or avatarStatsLast[id] ~= key
                    or now - (avatarStatsSentAt[id] or 0) >= AVATAR_STATS_REFRESH_S then
                    avatarStatsLast[id] = key
                    avatarStatsSentAt[id] = now
                    entries[#entries + 1] = entry
                end
            end
        end
    end
    if #entries > 0 then
        if not avatarStatsAnnounced then
            avatarStatsAnnounced = true
            print(string.format('[mp] avatar stats reporting began (%d entr%s)', #entries,
                #entries == 1 and 'y' or 'ies'))
        end
        mp.sendEvent('AvatarStatsBatch', { entries = entries })
    end
end

-- Phase 4D: the peer reports each avatar's item STATES (wear / enchantment charge / soul).
-- It swings the weapon now (4C), so the peer is where wear happens; the owner's client only
-- learns of it through this. Same doc shape the server persists (record id -> positional
-- bucket), diffed, with the same refresh-for-correctness rule as the bars.
local avatarItemStatesAt = 0
local AVATAR_ITEMSTATES_EVERY = 2.0
local avatarItemStatesLast = {} -- id -> serialized last report
local avatarItemStatesSentAt = {}
local AVATAR_ITEMSTATES_REFRESH_S = 10.0

-- One entry PER STACK with its size, stateless stacks included (#234): the owner's applier
-- walks the record's stacks positionally, and a skipped empty stack would shift every state
-- after it onto the wrong item.
local function snapAvatarItemStates(obj)
    local states = {}
    local inv = types.Actor.inventory(obj)
    for _, item in ipairs(inv:getAll()) do
        local d = types.Item.itemData(item)
        local one = { n = item.count or 1 }
        local okC, cond = pcall(function() return d.condition end)
        if okC and cond ~= nil then one.condition = cond end
        local okE, charge = pcall(function() return d.enchantmentCharge end)
        if okE and charge ~= nil and charge >= 0 then one.charge = charge end
        local okS, soul = pcall(function() return d.soul end)
        if okS and soul ~= nil and soul ~= '' then one.soul = soul end
        local rid = worldmp.toNet and worldmp.toNet(item.recordId) or item.recordId
        states[rid] = states[rid] or {}
        local bucket = states[rid]
        bucket[#bucket + 1] = one
    end
    return states
end

local function avatarItemStatesTick(now)
    if not (mp.isSystem()) then return end
    if now - avatarItemStatesAt < AVATAR_ITEMSTATES_EVERY then return end
    avatarItemStatesAt = now
    local entries = {}
    for id, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            local ok, states = pcall(snapAvatarItemStates, p.obj)
            if ok and states then
                local key = json.encode(states)
                if avatarItemStatesLast[id] ~= key
                    or now - (avatarItemStatesSentAt[id] or 0) >= AVATAR_ITEMSTATES_REFRESH_S then
                    avatarItemStatesLast[id] = key
                    avatarItemStatesSentAt[id] = now
                    entries[#entries + 1] = { id = id, itemStates = states }
                end
            end
        end
    end
    if #entries > 0 then mp.sendEvent('AvatarItemStatesBatch', { entries = entries }) end
end

-- WHAT THE WORLD DID TO THE AVATAR, back to its owner. The owner->avatar direction carries
-- what the player cast or drank (MP_AvatarActiveSpells); this is the other half. A diseased
-- rat's bite lands on the avatar (the peer resolves the hit) and puts a disease in the
-- avatar's SPELL LIST; a hostile caster's Paralyze, Burden or Silence lands on the avatar as
-- an ACTIVE EFFECT. Neither reached the player's own engine: the player kept walking while
-- their body stood paralysed on the peer, and never caught a disease in their life.
--   * spells: anything in the avatar's list that the doc did not put there, reported once;
--   * effects: temporary, not from equipment, and not a record the owner sent us -- diffed by
--     instance so a second Burden is a second report and an expiry is a removal.
local ownerActive = {} -- id -> { localRecordId -> count } effects the OWNER applied here

-- The effects of a record that SHOW on another player's body: an invisible friend fades, a
-- chameleoned one shimmers, a lit one lights the corridor. Everything else in the record is
-- dropped on an observer's puppet (its bars are a mirror; a local Damage Health would fight it).
-- Levitate, slowfall and water walking shape the MOVEMENT the puppet is steered through: without
-- them the observer's copy of a flying friend fell under the streamed pose and snapped up every
-- second (backlog 132). Keys are core.magic.EFFECT_TYPE values (lowercase effect ids).
local VISIBLE_EFFECT = { invisibility = true, chameleon = true, light = true,
    levitate = true, slowfall = true, waterwalking = true }
local function magicRecordOf(localId)
    local rec
    pcall(function()
        rec = core.magic.spells.records[localId]
            or core.magic.enchantments.records[localId]
            or (types.Potion.record and types.Potion.record(localId))
    end)
    return rec and rec.effects and rec or nil
end
local function visibleEffectIndexes(localId, indexes)
    local rec = magicRecordOf(localId)
    if not rec then return {} end
    local out = {}
    for _, i in ipairs(indexes) do
        local e = rec.effects[i + 1]
        if e and e.id and VISIBLE_EFFECT[e.id] then out[#out + 1] = i end
    end
    return out
end
-- The effects whose RESULT already travels on the bar channel: the engine that cast them
-- applied them to its body once, and the bars carry the outcome (a raise claim to the avatar,
-- the peer's bar report to the owner; magicka in both directions -- playerstate.ts spend).
-- Mirroring the effect as well lands it a second time on the other body: a Cheap Potion of
-- Healing healed ~40, a helper's durational heal 2x (backlog 248). Damage Health stays: the
-- server takes no LOWER health claim from the client, so the mirror is its only road.
-- Fatigue stays: nothing on the bar channel restores it.
local BAR_CARRIED_EFFECT = { restorehealth = true, restoremagicka = true, damagemagicka = true }
local function withoutBarCarried(localId, indexes)
    local rec = magicRecordOf(localId)
    if not rec then return indexes end
    local out = {}
    for _, i in ipairs(indexes) do
        local e = rec.effects[i + 1]
        if not (e and e.id and BAR_CARRIED_EFFECT[e.id]) then out[#out + 1] = i end
    end
    return out
end
-- The sender's ROLLED magnitudes, as activeSpells:add's `magnitudes` (effect index -> value).
-- On the wire they are `mags`, parallel to `effects` with -1 for "none"; keyed by index here
-- so the filters above can drop effects without the two lists falling out of step. Without
-- them each body re-rolled a ranged effect and the two moved at different speeds (Fortify
-- Speed, Burden, Levitate) -- the owner was corrected toward the avatar every step.
local function rolledMagnitudes(sp)
    local out = {}
    for k, i in ipairs(sp.effects or {}) do
        local m = type(sp.mags) == 'table' and sp.mags[k]
        if type(i) == 'number' and type(m) == 'number' and m >= 0 then out[i] = m end
    end
    return out
end
local avatarEffectsAt = 0
local AVATAR_EFFECTS_EVERY = 1.0
local avatarSpellsReported = {} -- id -> { localSpellId -> true }
local avatarEffectsReported = {} -- id -> { activeSpellId -> localRecordId }
local avatarOwnerEffectsSeen = {} -- id -> { activeSpellId -> localRecordId } owner records seen on the avatar

local function avatarEffectsTick(now)
    if not (mp.isSystem()) then return end
    if now - avatarEffectsAt < AVATAR_EFFECTS_EVERY then return end
    avatarEffectsAt = now
    local entries = {}
    for id, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            local entry = { id = id }
            local any = false
            -- Spells the world gave the avatar (disease, blight, a curse).
            local docSpells = {}
            for _, sid in ipairs((avatarDocs[id] and avatarDocs[id].spells) or {}) do
                docSpells[worldmp.toLocal(sid)] = true
            end
            avatarSpellsReported[id] = avatarSpellsReported[id] or {}
            local okS = pcall(function()
                local present = {}
                for _, spell in pairs(types.Actor.spells(p.obj)) do present[spell.id] = true end
                -- Only against a doc applied in an earlier frame (reconcile.worldGivenSpells).
                local applied = (not avatarDocDirty[id]) and avatarDocAppliedGen[id] or nil
                for _, sid in ipairs(reconcile.worldGivenSpells(present, docSpells, avatarSpellsReported[id], applied)) do
                    avatarSpellsReported[id][sid] = true
                    entry.spellsAdd = entry.spellsAdd or {}
                    entry.spellsAdd[#entry.spellsAdd + 1] = worldmp.toNet(sid)
                    any = true
                end
                -- FORGET WHAT IS GONE. "Reported" was never cleared, so a disease the owner
                -- cured (the doc dropped it, applyAvatarDoc shed it) could not be reported
                -- a second time: one bite per session, then immunity. A spell no longer on
                -- the body is reportable again when it comes back.
                for sid in pairs(avatarSpellsReported[id]) do
                    if not present[sid] then avatarSpellsReported[id][sid] = nil end
                end
            end)
            -- Effects the world put on the avatar.
            local known = ownerActive[id] or {}
            local seen = {}
            local reported = avatarEffectsReported[id] or {}
            -- Owner-applied records are tracked too, by instance, so a Dispel that strips
            -- the owner's Levitate from the avatar reaches the owner as a removal (else they
            -- keep flying while their body falls). They are never reported as ADDS: the
            -- owner put them there.
            local ownerSeen = {}
            local ownerReported = avatarOwnerEffectsSeen[id] or {}
            local okE = pcall(function()
                for _, sp in pairs(types.Actor.activeSpells(p.obj)) do
                    if sp.temporary and not sp.fromEquipment and sp.activeSpellId ~= nil and known[sp.id] then
                        ownerSeen[sp.activeSpellId] = sp.id
                    end
                    if sp.temporary and not sp.fromEquipment and sp.activeSpellId ~= nil
                        and not known[sp.id] then
                        -- Same rolled-magnitude rule as identity.lua snapActive: the owner
                        -- gets this Burden's roll, and an instance not rolled yet waits a tick
                        -- (unseen, so the next tick reports it).
                        local idx, mags, rolled = {}, {}, true
                        for _, e in ipairs(sp.effects or {}) do
                            if e.index ~= nil then
                                local m = e.magnitudeThisFrame
                                if m == 0 and (e.minMagnitude or 0) > 0 then rolled = false end
                                idx[#idx + 1] = e.index
                                mags[#idx] = type(m) == 'number' and m or -1
                            end
                        end
                        if rolled or reported[sp.activeSpellId] then seen[sp.activeSpellId] = sp.id end
                        if rolled and not reported[sp.activeSpellId] and #idx > 0 then
                            entry.effectsAdd = entry.effectsAdd or {}
                            entry.effectsAdd[#entry.effectsAdd + 1] = { id = worldmp.toNet(sp.id), effects = idx, mags = mags }
                            any = true
                        end
                    end
                end
            end)
            if okE then
                for aid, rid in pairs(reported) do
                    if not seen[aid] then
                        entry.effectsRemove = entry.effectsRemove or {}
                        entry.effectsRemove[#entry.effectsRemove + 1] = { id = worldmp.toNet(rid) }
                        any = true
                    end
                end
                avatarEffectsReported[id] = seen
                -- An owner record that was on the avatar and is gone before the owner said
                -- so: dispelled (or absorbed) here. The owner's own expiry also lands here a
                -- tick before its removal arrives; the client-side remove is idempotent.
                for aid, rid in pairs(ownerReported) do
                    if not ownerSeen[aid] and known[rid] then
                        entry.effectsRemove = entry.effectsRemove or {}
                        entry.effectsRemove[#entry.effectsRemove + 1] = { id = worldmp.toNet(rid) }
                        any = true
                    end
                end
                avatarOwnerEffectsSeen[id] = ownerSeen
            end
            if (okS or okE) and any then entries[#entries + 1] = entry end
        end
    end
    if #entries > 0 then mp.sendEvent('AvatarEffectsBatch', { entries = entries }) end
end

-- SUMMONS SPAWN WHERE THEY FIGHT. Our Summon effect reaches the avatar, and the peer's
-- creature is the one that engages and is relayed to everyone -- so while a holder simulates
-- our cell the engine must not spawn a local copy too (mwmp/puppets.hpp setLocalSummons).
-- Re-evaluated as the holder comes and goes; degraded mode (no peer) keeps local summons.
-- Mirrors the engine's own default (mwmp/puppets.cpp): a human multiplayer client starts
-- with local spawns OFF, before the first cell loads; only a confirmed degraded world (joined,
-- nobody simulating) turns them on.
local localSummonsOn = not (mp.isEnabled() and not (mp.isSystem()))
-- The LAST SimReady the server sent (nil until one arrives), not the join-time flag
-- (backlog 325): the join flag was true for the whole session, so a peer outage never
-- turned the peer rules off -- no fall damage, no drowning, for as long as it lasted.
M.lastSimReady = nil
local localSpawnsDbgAt = 0
local localSpawnsGuardSaid = false
local function localSummonsTick()
    if not localSpawnsGuardSaid then
        localSpawnsGuardSaid = true
        pcall(function() mp.set('localSpawns', localSummonsOn and 'on' or 'off') end) -- scenario mirror
    end
    if mp.isSystem() then return end
    -- STICKY on "this world is simulated": levelled lists roll at cell load, before the new
    -- cell's ActorAuthorityInfo arrives, so gating on our own cell alone would roll a local
    -- creature in every cell we enter and then learn better. Once any holder has been seen the
    -- peer is the one spawning; only a peer outage (every holder gone) hands it back to us.
    local simulated = net.state == 'Joined' and net.flags and net.flags.simulated == true
    if M.lastSimReady ~= nil then simulated = M.lastSimReady end
    -- Not joined yet is not "degraded": the socket is still connecting while the starting
    -- cells load, and a creature rolled in that window is a ghost only this screen can see.
    local want = net.state == 'Joined'
        and not (simulated or actors.hasHolder(deps.ownCellKey()) or actors.anyHolder())
    objects.setPeerRules(not want) -- backlog 109: the peer's avatar fires the real arrows
    -- Diagnostic mirror (s107): why local spawns are on or off, once a second.
    local nowD = core.getRealTime()
    if nowD - (localSpawnsDbgAt or 0) >= 1 then
        localSpawnsDbgAt = nowD
        pcall(function() mp.set('localSpawnsDbg', string.format('sim=%s holder=%s any=%s',
            tostring(simulated), tostring(actors.hasHolder(deps.ownCellKey())), tostring(actors.anyHolder()))) end)
    end
    if want ~= localSummonsOn then
        localSummonsOn = want
        pcall(mp.setLocalSpawns, want)
        pcall(function() mp.set('localSpawns', want and 'on' or 'off') end) -- scenario mirror
    end
end

-- WHAT A SCRIPT DID THAT ONLY THIS ENGINE SAW (mwmp/puppets.hpp ScriptNote): a far-cell
-- Enable/Disable, a PlaceAtPC actor the client declined to build, a PositionCell on a puppet.
-- Drained only once joined, so a Startup that ran before the socket opened still travels.
-- Nil-guarded: an engine baked before the hook has no takeScriptNotes and keeps the polls.
-- METERED (backlog 413): the drain is one burst -- 30 s of a town's AI package completions
-- (aidone, #221) arrive on the first joined frame, and every note is one message to a
-- server whose session budget is 60/s with burst 60. s109 in Jenkins #102 was kicked with RATE
-- 70 ms after joining. Notes queue here and go out at NOTE_SENDS_PER_SEC; nothing is dropped,
-- a Startup that ran before the socket opened still travels, just not all in one frame.
local NOTE_SENDS_PER_SEC = 20
local pendingNotes, noteSendSec, noteSendCount = {}, 0, 0
local function scriptNotesTick()
    local ok, notes = pcall(mp.takeScriptNotes)
    if ok and notes then
        for _, n in ipairs(notes) do pendingNotes[#pendingNotes + 1] = n end
    end
    if #pendingNotes == 0 then return end
    local sec = math.floor(core.getRealTime())
    if sec ~= noteSendSec then noteSendSec, noteSendCount = sec, 0 end
    local batch = {}
    while #pendingNotes > 0 and noteSendCount < NOTE_SENDS_PER_SEC do
        batch[#batch + 1] = table.remove(pendingNotes, 1)
        noteSendCount = noteSendCount + 1
    end
    for _, n in ipairs(batch) do
        if n.kind == 'position' then
            actors.notePosition(n.ref, n.cellName, n)
        elseif n.kind == 'say' then
            actors.noteSay(n)
        elseif n.kind == 'aidone' then
            actors.noteAiDone(n)
        elseif n.kind == 'crimecombat' or n.kind == 'scriptcombat' then
            -- scriptcombat: a world script's StartCombat Player on a puppet (same claim)
            actors.noteCrimeCombat(n)
        elseif n.kind == 'crimepursue' then
            actors.noteCrimeCombat(n, true) -- a guard's arrest chase, same claim
        else
            objects.onScriptNote(n)
        end
    end
end

-- ARREST. A guard that reaches a wanted avatar on the peer cannot open a dialogue nobody is
-- there to see; the engine records the reach (mwmp/puppets.hpp recordArrest) and this hands
-- it to the server for the owner's client, which opens the dialogue with ITS copy of the
-- guard -- and vanilla's own greeting does the rest: pay the fine, go to jail, or resist.
local function avatarArrestTick()
    if not mp.isSystem() then return end
    for id, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            -- Crimes the avatar committed on this engine (assault, murder: the peer's swing is
            -- the one that lands). The bounty is the owner's; they get the increment.
            do
                local okc, crimes = pcall(mp.takeCrimes, p.obj)
                if okc and crimes then
                    for _, c in ipairs(crimes) do
                        mp.sendEvent('PlayerCrime', { id = id, bounty = c.bounty, kind = c.kind, faction = c.faction })
                    end
                end
            end
            local ok, guards = pcall(mp.takeArrests, p.obj)
            if ok and guards then
                for _, guard in ipairs(guards) do
                    local okv, valid = pcall(function() return guard:isValid() end)
                    if okv and valid then
                        print(string.format('[mp] arrest: %s reached avatar #%s', tostring(guard.recordId), tostring(id)))
                        mp.sendEvent('PlayerArrest', { id = id, guard = guard })
                    end
                end
            end
        end
    end
end

-- Phase 4C safety: the peer resolves avatar-vs-avatar melee natively, so the server's
-- allowPlayerHit veto never sees it. Tell every avatar whether pvp is on and which bodies
-- are avatars, so avatar.lua can veto player-on-player damage while it is off. PvE is
-- untouched -- an NPC is not in the set.
M.pushAvatarPolicyQueued = false
M.pushAvatarPolicyAt = 0
local AVATAR_POLICY_EVERY = 5.0 -- re-push cadence; a dropped event must not disable the veto
local function pushAvatarPolicy()
    if not (mp.isSystem()) then return end
    local ids = {}
    for _, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            local ok, oid = pcall(function() return p.obj.id end)
            if ok and oid then ids[oid] = true end
        end
    end
    local pvp = (net.flags and net.flags.pvp) == true
    local placed = (net.flags and net.flags.clientAuthority) == true
    for _, p in pairs(puppets) do
        if p.obj and p.obj:isValid() then
            pcall(function() p.obj:sendEvent('mpAvatarPolicy', { pvp = pvp, avatarObjIds = ids, placed = placed }) end)
        end
    end
end

M.lastInputSeq = lastInputSeq
M.appliedSeq = appliedSeq
M.appliedPose = appliedPose
M.avatarUsing = avatarUsing
M.lastInputFlags = lastInputFlags
M.jumpPending = jumpPending
M.usePending = usePending
M.avatarDocs = avatarDocs
M.avatarDocDirty = avatarDocDirty
M.avatarDocAppliedGen = avatarDocAppliedGen
M.applyPartyLevel = applyPartyLevel
M.applyAvatarDoc = applyAvatarDoc
M.avatarDocTick = avatarDocTick
M.avatarLanded = avatarLanded
M.avatarStreamTick = avatarStreamTick
M.avatarStatsLast = avatarStatsLast
M.avatarStatsSentAt = avatarStatsSentAt
M.avatarStatsTick = avatarStatsTick
M.avatarItemStatesLast = avatarItemStatesLast
M.avatarItemStatesSentAt = avatarItemStatesSentAt
M.avatarItemStatesTick = avatarItemStatesTick
M.ownerActive = ownerActive
M.visibleEffectIndexes = visibleEffectIndexes
M.withoutBarCarried = withoutBarCarried
M.rolledMagnitudes = rolledMagnitudes
M.avatarSpellsReported = avatarSpellsReported
M.avatarEffectsReported = avatarEffectsReported
M.avatarOwnerEffectsSeen = avatarOwnerEffectsSeen
M.avatarEffectsTick = avatarEffectsTick
M.localSummonsTick = localSummonsTick
M.scriptNotesTick = scriptNotesTick
M.avatarArrestTick = avatarArrestTick
M.AVATAR_POLICY_EVERY = AVATAR_POLICY_EVERY
M.pushAvatarPolicy = pushAvatarPolicy

return M
