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

-- `isOpen` is deliberately separate from `element`. Using the element slot itself as the
-- open flag (element = true) meant destroy() ran `element:destroy()` on a BOOLEAN and threw
-- inside the event handler: every mirror still updated, so state assertions passed, and the
-- window simply never appeared. Only a screenshot caught it.
local isOpen = false
local element = nil
local friends = {} -- array of {acct, name, online, playerId, cellKey}
local requests = {} -- acct -> name, incoming friend requests awaiting an answer
local invites = {} -- acct -> name, incoming invites awaiting an answer
local status = '' -- last SocialResult, shown so a refused action is never silent
local draft = ''

-- MyGUI reads '#' as a colour escape ("#RRGGBB"), so any text containing one is silently
-- mangled: /list output like "#1 ui-a-ms1ytyfi" rendered as green "-ms1ytyfi" because
-- "#1 ui-" was eaten as a colour. '##' is MyGUI's literal '#'. This matters beyond ids —
-- a player whose NAME contains '#' would corrupt every row it appears in.
local function escape(text)
    return (tostring(text):gsub('#', '##'))
end

local function row(text, onClick)
    local r = { template = I.MWUI.templates.textNormal, props = { text = escape(text) } }
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
    if not isOpen then return end
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
        isOpen = false
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
    if isOpen then
        isOpen = false
        destroy()
        I.UI.removeMode('Interface')
        return
    end
    isOpen = true
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
        -- Test-only: the harness cannot press F (no SDL key injection), so the window has
        -- to be openable another way for any automated UI check to exist.
        MP_SocialUiOpen = function()
            if not isOpen then toggle() end
        end,
        MP_FriendList = function(data)
            friends = data.friends or {}
            -- Drop any pending request from someone who is now a friend. Clearing it only
            -- in the [accept] click handler left the same person listed as BOTH a friend
            -- and a pending request whenever the accept happened any other way — from
            -- another session, or from the mutual-request path where the server completes
            -- the friendship without this client ever pressing accept.
            for _, f in ipairs(friends) do
                requests[f.acct] = nil
                invites[f.acct] = nil
            end
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
