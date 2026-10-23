-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- TELEPORT AND REMOVE THAT DO NOT GET LOST (GLOBAL context: global.lua, objects.lua, actors.lua).
--
-- A non-player teleport() zeroes the object's count until the END of the frame
-- (mwlua/objectbindings.cpp). Until it lands, a second teleport() throws "already in the
-- process of teleporting" and remove() throws "Can't remove 0 of 0". A bare pcall around
-- either loses the request: an NPC that never followed its cell change, a deleted item still
-- lying there to be picked up. Here the latest teleport per object wins on a later frame, and a
-- refused remove disables the object at once (out of the scene, nothing to pick up or bump
-- into) and is tried again until it lands. No engine requires: the module is pure, so the Lua
-- runner drives it with stub objects. `tick(now)` runs once a frame from global.lua.
local retry = {}

local teleports = {} -- obj.id -> { obj, cellArg, pos, opts, until_, onLanded }
local removes = {} -- obj.id -> { obj, at }
local warned = {} -- obj.id -> true: the first refusal per object is said, the rest are not

local TELEPORT_SECONDS = 30 -- a COLD interior load on the peer takes well over three seconds

local function idOf(obj)
    local ok, id = pcall(function() return obj.id end)
    return ok and id or obj
end

local function valid(obj)
    local ok, v = pcall(function() return obj:isValid() end)
    return ok and v
end

local function warn(id, obj, what, err)
    if warned[id] then return end
    warned[id] = true
    local okR, rec = pcall(function() return obj.recordId end)
    print(string.format('[mp] %s refused for %s (%s), retrying: %s', what, tostring(id),
        tostring(okR and rec or '?'), tostring(err)))
end

local function doTeleport(obj, cellArg, pos, opts)
    return pcall(function()
        if opts then obj:teleport(cellArg, pos, opts) else obj:teleport(cellArg, pos) end
    end)
end

-- Move `obj` now, or as soon as the engine lets it. A later call for the same object replaces
-- the queued target: the latest request wins. `onLanded` runs once the move happens.
-- Returns whether it happened now.
function retry.teleport(obj, cellArg, pos, onLanded, opts)
    if not obj or cellArg == nil or not valid(obj) then return false end
    local id = idOf(obj)
    if removes[id] then return false end -- on its way out; a move would only fight that
    local ok, err = doTeleport(obj, cellArg, pos, opts)
    if ok then
        teleports[id] = nil
        if onLanded then onLanded() end
        return true
    end
    warn(id, obj, 'teleport', err)
    teleports[id] = { obj = obj, cellArg = cellArg, pos = pos, opts = opts,
        onLanded = onLanded } -- until_: stamped by the next tick (no engine clock needed here)
    return false
end

-- The queued target for `obj`, or nil: where it is GOING, which obj.position does not say yet.
function retry.pendingTeleport(obj)
    return obj and teleports[idOf(obj)] or nil
end

-- Remove `obj` now, or disable it now and remove it once the engine lets it. Returns whether
-- the remove happened now. No deadline: a disabled body costs nothing while it waits.
function retry.remove(obj)
    if not obj or not valid(obj) then return false end
    local id = idOf(obj)
    teleports[id] = nil -- a queued move must not bring it back
    local ok, err = pcall(function() obj:remove() end)
    if ok then
        removes[id] = nil
        return true
    end
    warn(id, obj, 'remove', err)
    pcall(function() obj.enabled = false end)
    removes[id] = { obj = obj, at = 0 } -- the next tick tries again
    return false
end

function retry.tick(now)
    local landed = {}
    for id, t in pairs(teleports) do
        t.until_ = t.until_ or now + TELEPORT_SECONDS
        if not valid(t.obj) or now > t.until_ then
            teleports[id] = nil
        elseif doTeleport(t.obj, t.cellArg, t.pos, t.opts) then
            teleports[id] = nil
            if t.onLanded then landed[#landed + 1] = t.onLanded end
        end
    end
    -- After the walk: a callback may queue another teleport (followers), and adding keys to a
    -- table mid-pairs is undefined.
    for _, f in ipairs(landed) do pcall(f) end
    for id, r in pairs(removes) do
        if not valid(r.obj) then
            removes[id] = nil
        elseif now >= r.at then
            if pcall(function() r.obj:remove() end) then removes[id] = nil else r.at = now + 1 end
        end
    end
end

return retry
