-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- A stub world whose inventories change the way the ENGINE's do (mwlua/objectbindings.cpp):
--   * remove(n) and the source side of split(n)/moveInto() change counts at once;
--   * split(n) returns a new object OUTSIDE any inventory;
--   * moveInto() zeroes the moved object at once and adds a NEW object to the destination only
--     at endFrame() -- the engine's applyDelayedActions;
--   * a count of 0 (or asking for more than the count) throws "Can't remove", as the engine does;
--   * items stack when record and item data are equal (ContainerStore::stacks).
-- The old run.lua fake applied adds at once and removals never, so it could not see a single
-- one of the same-frame bugs this exists to catch (backlog 507).
local F = {}

local function copy(t)
    local o = {}
    for k, v in pairs(t or {}) do o[k] = v end
    return o
end
local function sameData(a, b)
    for _, k in ipairs({ 'condition', 'enchantmentCharge', 'soul' }) do
        if (a or {})[k] ~= (b or {})[k] then return false end
    end
    return true
end

function F.new()
    local W = { queue = {} }
    local Obj = {}
    Obj.__index = Obj
    local nextId = 0
    local function newObj(recordId, count, data)
        nextId = nextId + 1
        return setmetatable({ recordId = recordId, count = count, data = copy(data), id = 'o' .. nextId }, Obj)
    end
    local function removeCheck(self, n)
        if n <= 0 or n > self.count then
            error("Can't remove " .. tostring(n) .. ' of ' .. tostring(self.count) .. ' items')
        end
    end
    function Obj:isValid() return true end
    function Obj:remove(n)
        n = n or self.count
        removeCheck(self, n)
        self.count = self.count - n
    end
    function Obj:split(n)
        removeCheck(self, n)
        self.count = self.count - n
        return newObj(self.recordId, n, self.data)
    end
    function Obj:moveInto(inv)
        local n = self.count
        removeCheck(self, n)
        self.count = 0
        local rec, data = self.recordId, copy(self.data)
        W.queue[#W.queue + 1] = function() inv:_add(rec, n, data) end
    end

    local Inv = {}
    Inv.__index = Inv
    function Inv:getAll()
        local out = {}
        for _, it in ipairs(self.items) do if it.count > 0 then out[#out + 1] = it end end
        return out
    end
    function Inv:countOf(recordId)
        local n = 0
        for _, it in ipairs(self.items) do if it.recordId == recordId then n = n + it.count end end
        return n
    end
    function Inv:_add(recordId, n, data)
        for _, it in ipairs(self.items) do
            if it.recordId == recordId and it.count > 0 and sameData(it.data, data) then
                it.count = it.count + n
                return
            end
        end
        self.items[#self.items + 1] = newObj(recordId, n, data)
    end
    -- test helpers: what the pack holds, and how many of a record carry a given field value
    function Inv:put(recordId, n, data) self:_add(recordId, n, data) end
    function Inv:countWhere(recordId, field, value)
        local c = 0
        for _, it in ipairs(self.items) do
            if it.recordId == recordId and it.count > 0 and it.data[field] == value then c = c + it.count end
        end
        return c
    end

    function W.inventory() return setmetatable({ items = {} }, Inv) end
    function W.createObject(recordId, n) return newObj(recordId, n or 1, {}) end
    function W.itemData(obj) return obj.data end
    -- The engine's applyDelayedActions: every add queued this frame lands.
    function W.endFrame()
        local q = W.queue
        W.queue = {}
        for _, fn in ipairs(q) do fn() end
    end
    return W
end

return F
