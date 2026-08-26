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

local function followedPlayer()
    -- getTargets rather than getActiveTarget: a follower that is momentarily fighting, or
    -- fleeing, has Follow further down its package stack and is still a companion. Asking for
    -- the ACTIVE package would drop them the instant anything else happened and re-recruit
    -- them a second later, which would flap this event at exactly the worst moment.
    local ok, targets = pcall(function() return I.AI.getTargets('Follow') end)
    if not ok or not targets then return nil end
    for _, t in ipairs(targets) do
        if t and t:isValid() and types.Player.objectIsInstance(t) then return t end
    end
    return nil
end

return {
    engineHandlers = {
        onUpdate = function()
            local now = core.getRealTime()
            if now < nextPoll then return end
            nextPoll = now + POLL

            local target = followedPlayer()
            -- Compared by ID, not by object: two reads of the same actor are different Lua
            -- values, so comparing the objects would report a change every single tick.
            local id = target and target.id or nil
            if id == reportedId then return end
            reportedId = id

            -- The GLOBAL script decides whether we are the cell's authority and whether this
            -- is worth putting on the wire. This script only knows a fact about itself.
            core.sendGlobalEvent('mpActorFollow', { actor = self.object, target = target })
        end,
    },
}
