-- Multiplayer SOCIAL player script (Phase C): friends list, requests, blocks and invites.
-- F toggles the window. Rows are clickable; text entry needs a click first because 0.52
-- Lua cannot set keyboard focus programmatically.
--
-- Server contract lives in server/PROTOCOL.md. Identity on the wire is the ACCOUNT KEY
-- (`acct`), never the player id: ids are per-session, so an id-keyed friend would vanish on
-- every reconnect.
local core = require('openmw.core')
local ui = require('openmw.ui')
local util = require('openmw.util')
local async = require('openmw.async')
local input = require('openmw.input')
local mp = require('openmw.mp')
local I = require('openmw.interfaces')

local json = require('scripts.mp.json')

local element = nil
local friends = {} -- array of {acct, name, online, playerId, cellKey}
local requests = {} -- acct -> name, incoming friend requests awaiting an answer
local invites = {} -- acct -> name, incoming invites awaiting an answer
local status = '' -- last SocialResult, shown so a refused action is never silent
local draft = ''

local function row(text, onClick)
    local r = { template = I.MWUI.templates.textNormal, props = { text = text } }
    if onClick then r.events = { mouseClick = async:callback(onClick) } end
    return r
end

local function destroy()
    if element then
        element:destroy()
        element = nil
    end
end

-- Windows rebuild by destroy+create: there is no in-place update in this UI API, so every
-- state change re-renders the whole list.
local function render()
    if not element then return end
    destroy()
    local rows = {}
    rows[#rows + 1] = row('-- Friends --')
    if #friends == 0 then
        rows[#rows + 1] = row('  (nobody yet)')
    end
    for _, f in ipairs(friends) do
        -- cellKey is only ever sent for friends, so showing it here cannot leak a
        -- stranger's location.
        local where = f.online and (f.cellKey and (' @ ' .. f.cellKey) or ' (online)') or ' (offline)'
        local label = '  ' .. tostring(f.name) .. where
        if f.online then
            rows[#rows + 1] = row(label .. '  [invite]', function()
                core.sendGlobalEvent('mpSocial', { op = 'InviteSend', acct = f.acct })
            end)
        else
            rows[#rows + 1] = row(label)
        end
        rows[#rows + 1] = row('      [unfriend]', function()
            core.sendGlobalEvent('mpSocial', { op = 'FriendRemove', acct = f.acct })
        end)
    end

    local anyReq = false
    for acct, name in pairs(requests) do
        if not anyReq then
            rows[#rows + 1] = row('-- Friend requests --')
            anyReq = true
        end
        rows[#rows + 1] = row('  ' .. tostring(name) .. '  [accept]', function()
            core.sendGlobalEvent('mpSocial', { op = 'FriendAccept', acct = acct })
            requests[acct] = nil
            render()
        end)
        rows[#rows + 1] = row('      [block]', function()
            core.sendGlobalEvent('mpSocial', { op = 'BlockAdd', name = name })
            requests[acct] = nil
            render()
        end)
    end

    local anyInv = false
    for acct, name in pairs(invites) do
        if not anyInv then
            rows[#rows + 1] = row('-- Invites --')
            anyInv = true
        end
        rows[#rows + 1] = row('  ' .. tostring(name) .. ' invited you  [join]', function()
            core.sendGlobalEvent('mpSocial', { op = 'InviteAccept', acct = acct })
            invites[acct] = nil
            render()
        end)
    end

    rows[#rows + 1] = row('-- Add a friend (click, type a name, Enter) --')
    rows[#rows + 1] = {
        template = I.MWUI.templates.textEditLine,
        props = { text = '', size = util.vector2(400, 0) },
        events = {
            textChanged = async:callback(function(text) draft = text end),
            keyPress = async:callback(function(e)
                if e.code == input.KEY.Enter and draft ~= '' then
                    core.sendGlobalEvent('mpSocial', { op = 'FriendRequest', name = draft })
                    draft = ''
                    render()
                end
            end),
        },
    }
    if status ~= '' then rows[#rows + 1] = row(status) end
    rows[#rows + 1] = row('[ close ]', function()
        destroy()
        I.UI.removeMode('Interface')
    end)

    I.UI.setMode('Interface', { windows = {} })
    element = ui.create {
        layer = 'Windows',
        template = I.MWUI.templates.boxSolid,
        props = { position = util.vector2(60, 60) },
        content = ui.content {
            { type = ui.TYPE.Flex, props = { horizontal = false, autoSize = true }, content = ui.content(rows) },
        },
    }
end

local function toggle()
    if element then
        destroy()
        I.UI.removeMode('Interface')
        return
    end
    element = true -- render() rebuilds from scratch; this just marks it open
    render()
end

local function mirror()
    mp.testSet('friends', json.encode(friends))
    local reqs, invs = {}, {}
    for acct, name in pairs(requests) do reqs[#reqs + 1] = { acct = acct, name = name } end
    for acct, name in pairs(invites) do invs[#invs + 1] = { acct = acct, name = name } end
    mp.testSet('friendRequests', json.encode(reqs))
    mp.testSet('invites', json.encode(invs))
end

return {
    engineHandlers = {
        onKeyPress = function(key)
            -- Only when no UI mode is active, matching the chat window's 'T' convention.
            if key.symbol == 'f' and not I.UI.getMode() then toggle() end
        end,
    },
    eventHandlers = {
        MP_FriendList = function(data)
            friends = data.friends or {}
            mirror()
            render()
        end,
        MP_FriendRequestReceived = function(data)
            if data.fromAcct then
                requests[data.fromAcct] = data.fromName or data.fromAcct
                ui.showMessage(tostring(requests[data.fromAcct]) .. ' sent you a friend request (F)')
                mirror()
                render()
            end
        end,
        MP_InviteReceived = function(data)
            if data.fromAcct then
                invites[data.fromAcct] = data.fromName or data.fromAcct
                ui.showMessage(tostring(invites[data.fromAcct]) .. ' invited you to join them (F)')
                mirror()
                render()
            end
        end,
        MP_PresenceUpdate = function(data)
            for _, f in ipairs(friends) do
                if f.acct == data.acct then
                    f.online = data.online == true
                    if not f.online then f.cellKey = nil end
                    f.playerId = data.playerId
                end
            end
            mirror()
            render()
        end,
        -- Every refused action reports why. A friend request that silently does nothing is
        -- indistinguishable from a broken server.
        MP_SocialResult = function(data)
            status = tostring(data.op or '?') .. ': ' .. tostring(data.detail or '?')
            mp.testSet('socialResult', json.encode({ op = data.op, ok = data.ok, detail = data.detail }))
            if data.ok ~= true then ui.showMessage(status) end
            render()
        end,
    },
}
