-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- Inventory reconciliation: bringing a pack to what a document says it should hold. No engine
-- requires -- the engine's calls arrive as arguments -- so wasm-build/lua-tests runs this code
-- against a stub inventory that applies changes the way the engine does.
--
-- THE ENGINE RULE (mwlua/objectbindings.cpp, mwlua/luamanagerimp.cpp):
--   * remove(n), and the source side of split(n) and moveInto(), change counts AT ONCE;
--   * the add side of moveInto() lands in applyDelayedActions(), which runs after every event
--     handler and the global onUpdate of the frame;
--   * a moved object's own count reads 0 from the call on and it never gets a parentContainer:
--     the container adds a NEW object at the end of the frame.
-- So within one frame countOf/getAll see removals but not adds. On a sim peer many network
-- events land in one frame, and every read-then-add reconcile raced itself: an avatar granted
-- the same shortfall twice, an equipped item fabricated three times at spawn (backlog 507),
-- item states written onto stacks that had not arrived yet on a relog. An add is therefore
-- remembered here by the count recorded when it was queued and the frame it was queued in, and
-- a reconcile counts it as held until that frame is over.
local R = {}

-- ---------------------------------------------------------------- frames and in-flight adds
local gen = 0
-- Called at the END of the global onUpdate: every event handler and onUpdate of this frame has
-- run, and the adds queued in it land in applyDelayedActions right after.
function R.nextFrame() gen = gen + 1 end
function R.generation() return gen end

local inflight, inflightGen = {}, 0 -- key -> recordId -> count queued this frame
local function current()
    if inflightGen ~= gen then inflight, inflightGen = {}, gen end
    return inflight
end
function R.queued(key, recordId, n)
    local t = current()
    t[key] = t[key] or {}
    t[key][recordId] = (t[key][recordId] or 0) + n
end
-- How many of a record are on their way into `key`'s inventory and not yet visible to countOf.
function R.inFlight(key, recordId)
    local t = current()[key]
    return (t and t[recordId]) or 0
end
function R.anyInFlight(key)
    local t = current()[key]
    return t ~= nil and next(t) ~= nil
end

-- Move ALL of `obj` into `inventory`, remembering the add until it lands. The count is read
-- before the call: after it, the object says 0.
function R.moveInto(obj, inventory, key, recordId)
    local n = obj.count or 1
    obj:moveInto(inventory)
    if key then R.queued(key, recordId or obj.recordId, n) end
    return n
end

-- What `inventory` holds of a record, counting what is on its way in.
function R.held(inventory, key, recordId)
    local ok, landed = pcall(function() return inventory:countOf(recordId) end)
    return ((ok and landed) or 0) + (key and R.inFlight(key, recordId) or 0)
end

-- ---------------------------------------------------------------- item states (#234)
-- Write one record's item-state bucket onto the stacks the inventory holds for it. Entries are
-- one per stack, in inventory order, each with its stack size `n`; a stateless entry ({n=k})
-- only advances the walk. A stateful entry is written to a piece of EXACTLY n items: the stack
-- is split first when it holds more, and the piece goes back into the inventory (a partly-used
-- or souled item never restacks with fresh ones). An entry without `n` (a pre-#234 doc) takes
-- the rest of the stack. Returns how many entries wrote a state.
--
-- The split test reads the stack's LIVE count (split() lowers it at once), not the walk's
-- running remainder: that remainder also discounts stateless entries walked past WITHOUT a
-- split, so a stack of three walked as {n=2},{n=1,soul} compared 1 < 1, split nothing and wrote
-- the soul onto all three gems.
--
-- `itemData(obj)` is types.Item.itemData; `key`, when given, records each moved piece as in
-- flight, so a reconcile later in the same frame does not read the split as a shortfall.
function R.applyItemStates(inventory, localId, bucket, itemData, key)
    local stacks = {}
    for _, item in ipairs(inventory:getAll()) do
        if item.recordId == localId and (item.count or 1) > 0 then stacks[#stacks + 1] = item end
    end
    local si = 1
    local left = stacks[1] and (stacks[1].count or 1) or 0 -- of stacks[si], not yet walked
    local applied = 0
    for _, st in ipairs(bucket or {}) do
        local item = stacks[si]
        if not item then break end
        local n = st.n or left
        if n > left then n = left end
        local stateful = st.condition ~= nil or st.charge ~= nil or st.soul ~= nil
        if stateful and n > 0 then
            local piece = item
            if n < (item.count or 1) then piece = item:split(n) end
            local d = itemData(piece)
            if st.condition ~= nil then pcall(function() d.condition = st.condition end) end
            if st.charge ~= nil then pcall(function() d.enchantmentCharge = st.charge end) end
            if st.soul ~= nil then pcall(function() d.soul = st.soul end) end
            applied = applied + 1
            if piece ~= item then R.moveInto(piece, inventory, key, localId) end
        end
        left = left - n
        if left <= 0 then
            si = si + 1
            left = stacks[si] and (stacks[si].count or 1) or 0
        end
    end
    return applied
end

-- ---------------------------------------------------------------- bringing a pack to a doc
-- opts:
--   inventory     the pack
--   items         { {id = localRecordId, n = count}, ... } -- what it must hold
--   createObject  function(recordId, n) -> object (world.createObject)
--   key           in-flight key for this pack
--   shed          true: remove surplus and every record `items` does not list (an avatar, whose
--                 doc is the truth); false: grant only (a player's own restore -- holding MORE
--                 than the debounced doc is ordinary)
--   keep          { [recordId] = true } never shed (what the owner has equipped)
--   log           optional function(message)
-- Returns { added = n, removed = n, unresolved = {ids}, pending = bool }. `pending` means adds
-- are in flight or a surplus is still on its way in: call again next frame, and it converges.
function R.reconcileInventory(opts)
    local inv, key = opts.inventory, opts.key
    local out = { added = 0, removed = 0, unresolved = {}, pending = false }
    local want = {}
    for _, e in ipairs(opts.items or {}) do
        if e.id then want[e.id] = (want[e.id] or 0) + (e.n or 1) end
    end
    local function removeFromStacks(recordId, n)
        local done = 0
        for _, item in ipairs(inv:getAll()) do
            if done >= n then break end
            if item.recordId == recordId and (item.count or 1) > 0 then
                local take = math.min(n - done, item.count or 1)
                if pcall(function() item:remove(take) end) then done = done + take end
            end
        end
        return done
    end
    for recordId, n in pairs(want) do
        local ok, landed = pcall(function() return inv:countOf(recordId) end)
        landed = (ok and landed) or 0
        local coming = key and R.inFlight(key, recordId) or 0
        local short = n - landed - coming
        if short > 0 then
            local okc, obj = pcall(opts.createObject, recordId, short)
            if okc and obj then
                R.moveInto(obj, inv, key, recordId)
                out.added = out.added + short
                if opts.log then opts.log(string.format('adds %d x %s (doc says %d, had %d, %d on the way)', short, recordId, n, landed, coming)) end
            else
                out.unresolved[#out.unresolved + 1] = recordId
            end
        elseif short < 0 and opts.shed then
            local surplus = -short
            local done = removeFromStacks(recordId, math.min(surplus, landed))
            out.removed = out.removed + done
            if opts.log then opts.log(string.format('sheds %d x %s (doc says %d, had %d, %d on the way)', done, recordId, n, landed, coming)) end
            -- Whatever is still in flight lands after this frame; the next pass removes it.
            if done < surplus then out.pending = true end
        end
    end
    if opts.shed then
        local keep = opts.keep or {}
        for _, item in ipairs(inv:getAll()) do
            local rid = item.recordId
            if not want[rid] and not keep[rid] and (item.count or 1) > 0 then
                local n = item.count or 1
                if pcall(function() item:remove(n) end) then
                    out.removed = out.removed + n
                    if opts.log then opts.log(string.format('sheds %d x %s (not in the doc)', n, tostring(rid))) end
                end
            end
        end
        -- A record the doc no longer lists that is still arriving: gone next pass.
        local t = key and current()[key]
        if t then
            for rid in pairs(t) do if not want[rid] and not keep[rid] then out.pending = true end end
        end
    end
    if key and R.anyInFlight(key) then out.pending = true end
    return out
end

-- ---------------------------------------------------------------- spells the world gave
-- Which spells on an avatar's body to report as the WORLD's (a disease, blight, a curse) rather
-- than its owner's: present on the body, absent from the doc, not reported yet. Only once the
-- doc has been applied in an EARLIER frame: spell add/remove land at the end of the frame
-- (magicbindings.cpp), so until then the body still carries the template NPC's spells, or one
-- the doc just dropped -- and every one of them was reported as the player's and kept by the
-- server for good (phantom spells, PLAYTEST item 12). appliedGen is the frame the doc was last
-- applied in, nil when it has not been or is due again.
function R.worldGivenSpells(present, docSpells, reported, appliedGen)
    local adds = {}
    if appliedGen == nil or appliedGen >= gen then return adds end
    for sid in pairs(present) do
        if not docSpells[sid] and not reported[sid] then adds[#adds + 1] = sid end
    end
    table.sort(adds)
    return adds
end

return R
