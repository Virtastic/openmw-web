-- M8 ops client (GLOBAL context; wired from scripts/mp/global.lua).
-- See server/PROTOCOL.md §M8. Everything here is server->client: the effects of the
-- commands an operator issued from the dashboard. There is no outbound half: a client cannot
-- ask for an operator command, so there is nothing here for it to send.
--
-- ConsoleCommand is remote code execution on this machine BY DESIGN (rank 3 only,
-- operator-disableable, audited server-side). We run it, and we say so in the log: a
-- player must be able to see in their own console that an operator ran something.
local types = require('openmw.types')
local util = require('openmw.util')
local world = require('openmw.world')
local mp = require('openmw.mp')

local admin = {}

-- injected by global.lua: {playerFn, noticeFn, teleportFn, toLocalRecordFn}
local deps = nil

local lastConsole = nil
local lastGive = nil
local lastTeleport = nil

local handlers = {}

-- /tp, /tpto: move, then let the normal M1 reporting path tell everyone where we are
-- (player.lua's cell watcher sends PlayerCellChange; the pose sampler follows).
handlers.MP_AdminTeleport = function(data)
    if type(data.cellKey) ~= 'string' then return end
    lastTeleport = data.cellKey
    deps.teleportFn({ cellKey = data.cellKey, x = data.x, y = data.y, z = data.z })
    mp.set('adminTeleport', data.cellKey)
end

-- /give: add the item and let the M2 inventory diff report it.
handlers.MP_AdminGive = function(data)
    local player = deps.playerFn()
    if not player or type(data.recordId) ~= 'string' then return end
    local count = math.max(1, math.floor(tonumber(data.count) or 1))
    -- Custom (player-made) items travel as a server recordNetId — resolve it to whatever
    -- this client minted for it (§M7 RecordsSync), never as a raw foreign id.
    local recordId = deps.toLocalRecordFn(data.recordId)
    local ok, item = pcall(function() return world.createObject(recordId, count) end)
    if not ok then
        print('[mp] AdminGive: unknown record "' .. tostring(recordId) .. '": ' .. tostring(item))
        deps.noticeFn('An admin sent you an item this client does not have: ' .. tostring(data.recordId))
        return
    end
    item:moveInto(types.Actor.inventory(player))
    lastGive = recordId .. 'x' .. count
    mp.set('adminGive', lastGive)
    deps.noticeFn('An admin gave you ' .. count .. 'x ' .. recordId)
end

handlers.MP_ConsoleCommand = function(data)
    if type(data.script) ~= 'string' or data.script == '' then return end
    lastConsole = data.script
    mp.set('adminConsole', data.script)
    print('[mp] admin console command: ' .. data.script)
    deps.noticeFn('An admin ran a console command on your client')
    -- mp.runConsole is the engine's own console executor (mwmp/luabindings.cpp); there is
    -- no vanilla Lua API for running MWScript console text.
    if not mp.runConsole then
        print('[mp] runConsole binding missing: console command NOT executed')
        return
    end
    local ok, err = pcall(function() mp.runConsole(data.script) end)
    if not ok then print('[mp] runConsole failed: ' .. tostring(err)) end
end

admin.handlers = handlers

function admin.reset()
    lastConsole = nil
    lastGive = nil
    lastTeleport = nil
end

function admin.init(d)
    deps = d
end

return admin
