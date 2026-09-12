-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- COMPANIONS. A recruited follower used to follow the person who recruited them on that
-- client ONLY: everyone else saw the same NPC standing where the cell left them. Several
-- main-quest and expansion arcs hand you a companion, so this is not a corner.
--
-- Why a script on the ACTOR rather than in the holder's diff loop, where every other actor
-- property is read: a global script CANNOT read AI package state for a foreign actor. That is
-- an engine limitation, not an oversight, and it is why `ActorAI` sat as dead protocol
-- surface with a server relay and nothing ever sending one. An actor's OWN local script can
-- read its own packages, so the fact travels up from here instead of being fetched.
--
-- Deliberately tiny and cheap: this runs on every NPC and creature in every loaded cell. One
-- table lookup per second, and it says nothing at all unless the answer CHANGED.
local self = require('openmw.self')
local core = require('openmw.core')
local types = require('openmw.types')
local I = require('openmw.interfaces')

-- 1 Hz. Recruiting is a dialogue action and losing a follower is a conversation or a death --
-- none of it needs a fast beat, and the cost here is multiplied by every actor in the cell.
local POLL = 1.0
local nextPoll = 0
-- The last thing we told the global script, so a follower standing still says nothing at all.
-- Starts nil, which is also "following nobody" -- so an ordinary NPC, which is almost all of
-- them, never sends a single event in its life.
local reportedId = nil
-- ...and who we are fighting, if it is a player. The client's copy of us has its AI off and
-- an empty combat state, so nothing there knew a fight was on: the player could open the rest
-- dialog mid-bite. Reported on change like the follow, and relayed the same way (ActorAI).
local reportedCombat = nil

-- ...and where we are travelling, if a script sent us. On a puppet the AI never runs, so the
-- top of the package stack is static -- the only thing that can change it is a dialogue result
-- ("AITravel x y z" on Goodbye), which is exactly the case that never reached the holder.
local reportedTravel = nil
local function travelDest()
    local ok, pkg = pcall(function() return I.AI.getActivePackage() end)
    if not (ok and pkg and pkg.type == 'Travel' and pkg.destPosition) then return nil end
    local d = pkg.destPosition
    return { x = d.x, y = d.y, z = d.z }
end

local function fightingPlayer()
    local ok, pkg = pcall(function() return I.AI.getActivePackage() end)
    if not (ok and pkg and pkg.type == 'Combat') then return nil end
    local t = pkg.target
    local okv, valid = pcall(function() return t and t:isValid() end)
    return (okv and valid) and t or nil
end

local function playerAmong(packageType)
    -- getTargets rather than getActiveTarget: a follower that is momentarily fighting, or
    -- fleeing, has Follow further down its package stack and is still a companion. Asking for
    -- the ACTIVE package would drop them the instant anything else happened and re-recruit
    -- them a second later, which would flap this event at exactly the worst moment.
    local ok, targets = pcall(function() return I.AI.getTargets(packageType) end)
    if not ok or not targets then return nil end
    for _, t in ipairs(targets) do
        if t and t:isValid() and types.Player.objectIsInstance(t) then return t end
    end
    return nil
end

-- Follow, or Escort. An escort quest ("AIEscort player 0 x y z" from a dialogue result) is
-- the NPC leading the player somewhere, and it runs on the same client-only path a recruit
-- does -- so without this the pilgrim stood at the shrine on every other screen. The
-- destination is only readable off the ACTIVE package (there is no getPackages), so an
-- escort momentarily fighting is reported once it resumes -- one poll later, at most.
local function followedPlayer()
    local t = playerAmong('Follow')
    if t then return t, nil end
    t = playerAmong('Escort')
    if not t then return nil, nil end
    local okp, pkg = pcall(function() return I.AI.getActivePackage() end)
    if not (okp and pkg and pkg.type == 'Escort' and pkg.destPosition) then return nil, nil end
    local d = pkg.destPosition
    return t, { x = d.x, y = d.y, z = d.z, duration = pkg.duration or 0 }
end

return {
    engineHandlers = {
        onUpdate = function()
            local now = core.getRealTime()
            if now < nextPoll then return end
            nextPoll = now + POLL

            -- Combat first: independent of following, and its own change key.
            local foe = fightingPlayer()
            local foeId = foe and foe.id or nil
            if foeId ~= reportedCombat then
                reportedCombat = foeId
                core.sendGlobalEvent('mpActorCombat', { actor = self.object, target = foe })
            end

            local dest = travelDest()
            local destKey = dest and string.format('%.0f,%.0f,%.0f', dest.x, dest.y, dest.z) or nil
            if destKey ~= reportedTravel then
                reportedTravel = destKey
                if dest then core.sendGlobalEvent('mpActorTravel', { actor = self.object, dest = dest }) end
            end

            local target, escort = followedPlayer()
            -- Compared by ID, not by object: two reads of the same actor are different Lua
            -- values, so comparing the objects would report a change every single tick.
            -- The kind is part of the key: Follow -> Escort of the same player is a change.
            local id = target and ((escort and 'escort:' or 'follow:') .. tostring(target.id)) or nil
            if id == reportedId then return end
            reportedId = id

            -- The GLOBAL script decides whether we are the cell's authority and whether this
            -- is worth putting on the wire. This script only knows a fact about itself.
            core.sendGlobalEvent('mpActorFollow', { actor = self.object, target = target, escort = escort })
        end,
    },
    eventHandlers = {
        -- THE BARS A HANDOFF HANDS US. Dynamic-stat setters are Self-gated (mwlua/stats.cpp),
        -- so the holder cannot write a snapshot's health onto an actor from the global script
        -- -- it threw inside a pcall, and every actor a new holder took over came back at
        -- whatever health its own engine had, a half-dead bandit at full. This script is on
        -- every NPC and creature already, so the write lands here.
        mpSetStats = function(dyn)
            if type(dyn) ~= 'table' then return end
            pcall(function()
                local d = types.Actor.stats.dynamic
                local map = { hp = 'health', mp = 'magicka', ft = 'fatigue' }
                for k, statName in pairs(map) do
                    local v = dyn[k]
                    if v then
                        local stat = d[statName](self)
                        if v.b then stat.base = v.b end
                        if v.c then stat.current = v.c end
                    end
                end
            end)
        end,
    },
}
