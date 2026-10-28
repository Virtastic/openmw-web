-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- ONE COPY of the small helpers several mp scripts used to carry their own copy of (OT3-237).
-- Pure: no engine requires, so it loads in global and local contexts and in the Lua runner.
local shared = {}

-- Chargen sanctuary: the opening is driven by Morrowind's own scripts on the actors in these
-- cells, so nothing of ours belongs in them. Kept in step with server/src/core/movement.ts.
-- Exact names (backlog 385): a substring on 'census' made every Tamriel Rebuilt Census and
-- Excise office a sanctuary.
function shared.isChargenCell(cellKey)
    local k = string.lower(tostring(cellKey or ''))
    return k == 'seyda neen, census and excise office' or k == 'imperial prison ship'
end

-- The server's cell key: "x,y" for an exterior, the lowercased name otherwise; nil for no cell.
function shared.cellKeyOf(cell)
    if not cell then return nil end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

-- flags arrive as LSER doubles; pure-arithmetic bit test
function shared.bit(flags, n)
    return math.floor((flags or 0) / 2 ^ n) % 2 == 1
end

function shared.shortestArc(a)
    while a > math.pi do a = a - 2 * math.pi end
    while a < -math.pi do a = a + 2 * math.pi end
    return a
end

-- setEquipment only works once the granted items exist in the inventory (createObject+moveInto
-- lands a frame or more later): wait until every pending record is there or the deadline
-- passes, then equip. Returns true once it has tried, and the caller drops `pending`.
-- BY OBJECT, THE LARGEST STACK. A record id equips the first matching stack, and the pack can
-- hold two of the same record: the single item an equipment push fabricated before the
-- inventory doc arrived, and the real stack the doc granted beside it. A quiver bound to the
-- lone arrow loosed one shot with the other twenty-three still in the pack.
function shared.equipWhenReady(types, actor, pending, deadline, now, tag)
    local best = {}
    for _, item in ipairs(types.Actor.inventory(actor):getAll()) do
        local b = best[item.recordId]
        if not b or (item.count or 1) > (b.count or 1) then best[item.recordId] = item end
    end
    if now <= deadline then
        for _, id in pairs(pending) do
            if not best[id] then return false end
        end
    end
    local slots = {}
    for slot, id in pairs(pending) do slots[slot] = best[id] or id end
    local ok, err = pcall(types.Actor.setEquipment, actor, slots)
    if not ok then print('[mp] ' .. tag .. ' equip failed: ' .. tostring(err)) end
    return true
end

return shared
