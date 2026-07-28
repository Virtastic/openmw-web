-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- Phase 4: party difficulty scaling and the threat table, both run by the cell's AUTHORITY
-- HOLDER (the client simulating that cell's actors).
--
-- WHY HERE AND NOT ON THE SERVER. The server never simulates: it elects a client to run
-- the cell's AI and relays the result. So the only place that can decide who an NPC swings
-- at, or how much health it has, is the holder — the server's job is to tell it the RULE
-- (how many party members are co-present), which it does in the scaling payload.
--
-- VANILLA HAS NO THREAT TABLE. An aggroed NPC picks a target — mostly proximity or last
-- attacker — and tunnels. In a group that produces the two failures everyone recognises:
-- whoever opened the door tanks everything while the mage is never touched, and if the AI
-- re-evaluates every frame the enemy strobes between two players hitting neither. So this
-- adds a small, explicit model: accumulate threat, switch only on a real margin.

local types = require('openmw.types')
local core = require('openmw.core')

local threat = {}

-- refKey -> { target = playerId, scores = { [playerId] = n }, lastSeen = t }
local tables = {}
-- Threat decays so a hit landed a minute ago does not own the fight forever.
local DECAY_PER_SEC = 0.9
-- A challenger must EXCEED the current target by this much to steal aggro. Without a
-- margin the enemy ping-pongs between two similar threats and effectively fights nobody.
local SWITCH_MARGIN = 1.25
local PROXIMITY_WEIGHT = 400 -- distance-scaled bonus, so standing in reach still matters
local ATTACK_BONUS = 25 -- a fresh attacker is credibly the problem right now
local TAUNT_SPIKE = 120 -- Speechcraft taunt: a native tank tool, no new UI needed

local function tableFor(refKey)
    local t = tables[refKey]
    if not t then
        t = { target = nil, scores = {}, last = core.getRealTime() }
        tables[refKey] = t
    end
    return t
end

-- Damage credits the DEALER, which is what makes a summoner or a damage-over-time caster
-- visible to the AI at all — in vanilla their pet does the hitting and they are ignored.
function threat.addDamage(refKey, playerId, amount)
    if not playerId or not amount or amount <= 0 then return end
    local t = tableFor(refKey)
    t.scores[playerId] = (t.scores[playerId] or 0) + amount + ATTACK_BONUS
end

function threat.taunt(refKey, playerId)
    local t = tableFor(refKey)
    t.scores[playerId] = (t.scores[playerId] or 0) + TAUNT_SPIKE
end

-- Proximity keeps a melee player relevant without a hit landing, and is what lets a group
-- peel: stepping in front of the healer actually does something.
function threat.addProximity(refKey, playerId, distance)
    if not playerId or not distance or distance <= 0 then return end
    local t = tableFor(refKey)
    t.scores[playerId] = (t.scores[playerId] or 0) + (PROXIMITY_WEIGHT / distance)
end

function threat.decay(now)
    for _, t in pairs(tables) do
        local dt = now - (t.last or now)
        t.last = now
        if dt > 0 then
            local factor = DECAY_PER_SEC ^ dt
            for id, v in pairs(t.scores) do
                local nv = v * factor
                t.scores[id] = (nv < 1) and nil or nv
            end
        end
    end
end

-- Who should this actor be attacking? Sticky: the current target keeps it unless somebody
-- clears the margin.
function threat.targetOf(refKey)
    local t = tables[refKey]
    if not t then return nil end
    local current = t.target
    local currentScore = current and (t.scores[current] or 0) or 0
    local bestId, bestScore = current, currentScore
    for id, score in pairs(t.scores) do
        if id ~= current and score > bestScore * SWITCH_MARGIN then
            bestId, bestScore = id, score
        end
    end
    t.target = bestId
    return bestId
end

-- Spread: when several enemies aggro at once, bias each new one toward whoever is being
-- targeted least. Four rats on four players is a fight; four rats on the leader while three
-- friends watch is a spectacle.
function threat.leastTargeted(candidateIds)
    local counts = {}
    for _, id in ipairs(candidateIds) do counts[id] = 0 end
    for _, t in pairs(tables) do
        if t.target and counts[t.target] then counts[t.target] = counts[t.target] + 1 end
    end
    local bestId, bestCount = nil, math.huge
    for _, id in ipairs(candidateIds) do
        if counts[id] < bestCount then bestId, bestCount = id, counts[id] end
    end
    return bestId
end

-- Authority handoff carries the table with it: without this the new holder starts blank
-- and every fight in the cell visibly forgets who it was angry at.
function threat.export()
    local out = {}
    for refKey, t in pairs(tables) do
        local scores = {}
        for id, v in pairs(t.scores) do scores[#scores + 1] = { id = id, v = v } end
        out[#out + 1] = { refKey = refKey, target = t.target, scores = scores }
    end
    return out
end

function threat.import(list)
    for _, entry in ipairs(list or {}) do
        local t = tableFor(entry.refKey)
        t.target = entry.target
        for _, s in ipairs(entry.scores or {}) do t.scores[s.id] = s.v end
    end
end

function threat.forget(refKey)
    tables[refKey] = nil
end

function threat.reset()
    tables = {}
end

-- ------------------------------------------------------------------- scaling

local scaling = nil -- { hp, damage, extraSpawns, members } from the server, or nil

function threat.setScaling(s)
    scaling = s
end

function threat.scaling()
    return scaling
end

-- Applied ONCE when an actor first enters combat, never re-evaluated mid-fight: a member
-- arriving should not visibly inflate a health bar (that reads as a bug), and one dying
-- should not deflate it (that would reward sacrificing the weakest member).
local scaled = {} -- refKey -> true

function threat.applyScaling(obj, refKey, isNamed)
    if not scaling or scaled[refKey] then return false end
    scaled[refKey] = true
    -- Named/scripted encounters get HP and damage only. Adding actors to a scripted fight
    -- is the V Rising mistake, and it would collide with quest spawn replay besides.
    local ok = pcall(function()
        local health = types.Actor.stats.dynamic.health(obj)
        health.base = health.base * scaling.hp
        health.current = health.current * scaling.hp
    end)
    if isNamed then return ok end
    return ok
end

function threat.clearScaled(refKey)
    scaled[refKey] = nil
end

return threat
