-- Multiplayer GLOBAL orchestrator (omw-mp/1, M0) — see server/PROTOCOL.md.
-- Connects on game start when the boot JS enabled MP (?mp= -> ENV OPENMW_MP_URL), drives the
-- session via scripts/mp/net.lua, maintains the player roster and forwards chat to the
-- player script. Mirrors {state, playerId, players} into window.__omwMP for the harness.
local core = require('openmw.core')
local mp = require('openmw.mp')
local world = require('openmw.world')

local json = require('scripts.mp.json')
local net = require('scripts.mp.net')

local roster = {} -- array of {id=u16, name=string}, server order

local function mirrorRoster()
    mp.testSet('players', json.encode(roster))
end

local function playerScript()
    return world.players[1]
end

local function toPlayer(eventName, data)
    local player = playerScript()
    if player then player:sendEvent(eventName, data) end
end

-- Golden-vector dump for the server's LSER codec tests (&mpvectors=1 -> ENV OPENMW_MP_VECTORS).
-- Prints `MPVECTOR:<name>:<base64>` lines to the console log; capture headlessly and feed to
-- the server test suite.
local function dumpVectors()
    local util = require('openmw.util')
    local vectors = {
        { 'bool_true', true },
        { 'bool_false', false },
        { 'num_zero', 0 },
        { 'num_negzero', -0.0 },
        { 'num_neghalf', -0.5 },
        { 'num_int', 42 },
        { 'num_bigint', 2^52 },
        { 'num_huge', 1e300 },
        { 'str_empty', '' },
        { 'str_short', 'hello' },
        { 'str_31', string.rep('a', 31) },
        { 'str_32', string.rep('b', 32) },
        { 'str_255', string.rep('c', 255) },
        { 'str_unicode', 'héllo wörld — ✓ 日本語' },
        { 'table_empty', {} },
        { 'table_flat', { a = 1, b = 'two', c = true } },
        { 'table_nested', { outer = { inner = { deep = 'value', n = 3 } } } },
        { 'table_array', { 10, 20, 30 } },
        { 'table_mixed', { 1, 2, key = 'val' } },
    }
    local ok, vec3 = pcall(function() return util.vector3(1.5, -2.5, 3.25) end)
    if ok then vectors[#vectors + 1] = { 'vec3', vec3 } end
    for _, entry in ipairs(vectors) do
        local okSer, b64 = pcall(mp.debugSerialize, entry[2])
        if okSer then
            print('MPVECTOR:' .. entry[1] .. ':' .. b64)
        else
            print('MPVECTOR-SKIP:' .. entry[1] .. ':' .. tostring(b64))
        end
    end
end

local function start()
    if not mp.isEnabled() then return end
    if mp.vectorsEnabled() then dumpVectors() end
    net.onStateChanged = function(state)
        print('[mp] session state: ' .. state)
        if state ~= 'Joined' then
            roster = {}
            mirrorRoster()
        end
    end
    if net.state == 'Offline' or net.state == 'Failed' then
        net.start()
    end
end

local eventHandlers = {
    MP_TransportOpen = function() net.onOpen() end,
    MP_TransportClose = function() net.onClose() end,
    MP_SessionJson = function(str) net.onJson(str) end,

    MP_ChatMessage = function(data)
        mp.testSet('lastChat', json.encode(data))
        toPlayer('MP_UiChatMessage', data)
    end,

    MP_PlayerJoinWorld = function(data)
        for _, p in ipairs(roster) do
            if p.id == data.id then return end
        end
        roster[#roster + 1] = { id = data.id, name = data.name }
        mirrorRoster()
        toPlayer('MP_UiChatMessage', { channel = 'server', text = tostring(data.name) .. ' joined' })
    end,

    MP_PlayerLeaveWorld = function(data)
        for i, p in ipairs(roster) do
            if p.id == data.id then
                toPlayer('MP_UiChatMessage', { channel = 'server', text = tostring(p.name) .. ' left' })
                table.remove(roster, i)
                break
            end
        end
        mirrorRoster()
    end,

    MP_PlayerList = function(data)
        roster = {}
        for _, p in ipairs(data.players or {}) do
            roster[#roster + 1] = { id = p.id, name = p.name }
        end
        mirrorRoster()
    end,

    -- player.lua -> here -> server (Event tier, PROTOCOL.md `ChatSend`).
    mpChatSend = function(data)
        if type(data.text) == 'string' and data.text ~= '' then
            mp.sendEvent('ChatSend', { text = data.text })
        end
    end,
}

return {
    engineHandlers = {
        onInit = start,
        onLoad = start,
        onUpdate = function() net.tick() end,
    },
    eventHandlers = eventHandlers,
}
