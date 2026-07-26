-- Multiplayer SOCIAL hub (Phase C/E): everyone playing, friends, party, and presence.
-- F opens it, or ESC -> Options -> Social.
--
-- Styled from the same MWUI templates the engine's own Options screen uses (see
-- scripts/mp/ui.lua) so it reads as part of the game rather than a debug overlay: bordered
-- transparent frame, GMST font colours, real padding and intervals, header text for
-- sections, and boxed controls instead of bare clickable strings.
--
-- Identity on the wire is the ACCOUNT KEY (`acct`), never the player id: ids are
-- per-session, so an id-keyed friend would vanish on every reconnect.
local core = require('openmw.core')
local ui = require('openmw.ui')
local util = require('openmw.util')
local async = require('openmw.async')
local input = require('openmw.input')
local mp = require('openmw.mp')
local I = require('openmw.interfaces')

local storage = require('openmw.storage')

local json = require('scripts.mp.json')
local U = require('scripts.mp.ui')

-- `isOpen` is deliberately separate from `element`. Using the element slot itself as the
-- open flag (element = true) made destroy() call `element:destroy()` on a BOOLEAN, which
-- threw inside the event handler: every mirror still updated, so state assertions passed
-- while the player saw no window at all.
local isOpen = false
local element = nil
local tab = 'players' -- players | friends | party

local roster = {} -- everyone in the world: {id, name}
local friends = {} -- {acct, name, online, playerId, cellKey}
local party = { leader = '', members = {} }
local requests = {} -- acct -> name (incoming friend requests)
local invites = {} -- acct -> {name=, kind='travel'|'party'}
local presence = 'friends'
local status = ''
local draft = ''
local myName = nil

-- There is no scroll container in this UI API, so a long list would simply run off the
-- bottom of the screen. The world is designed for ~100 concurrent players, so the Players
-- tab WILL exceed the screen — cap it and say how many are hidden rather than rendering a
-- window taller than the display and pretending it is fine.
local MAX_ROWS = 12

local PRESENCE_MODES = { 'public', 'friends', 'party', 'private' }
local PRESENCE_HELP = {
    public = 'anyone can see where you are',
    friends = 'only friends can see where you are',
    party = 'only your party can see where you are',
    private = 'nobody can see you, and invites are refused',
}

local function send(op, body)
    body = body or {}
    body.op = op
    core.sendGlobalEvent('mpSocial', body)
end

local function destroy()
    if element then
        element:destroy()
        element = nil
    end
end

local function isFriend(acct)
    for _, f in ipairs(friends) do
        if f.acct == acct then return true end
    end
    return false
end

local function inParty(acct)
    for _, m in ipairs(party.members or {}) do
        if m.acct == acct then return true end
    end
    return false
end

local render -- forward declaration: the row builders below re-render on click

-- One person, with only the actions that make sense for them. An [add friend] button beside
-- somebody who is already a friend is exactly what makes a UI feel unfinished, so each
-- action is gated on current state rather than always drawn.
local function personRow(name, opts)
    opts = opts or {}
    local label = name
    if opts.where then label = label .. '  (' .. opts.where .. ')' end
    if opts.offline then label = label .. '  (offline)' end
    if opts.leader then label = label .. '  - leader' end

    local items = { U.text(label, { grow = 1 }) }
    for _, a in ipairs(opts.actions or {}) do
        items[#items + 1] = U.button(a[1], a[2])
    end
    return U.row(items)
end

local function playersTab()
    local rows = {}
    local others = 0
    local shown = 0
    for _, p in ipairs(roster) do
        if p.name ~= myName then
            others = others + 1
            if shown < MAX_ROWS then
                shown = shown + 1
                local acct = string.lower(p.name) -- account keys are the lowercased name
                local actions = {}
                if not isFriend(acct) then
                    actions[#actions + 1] = { 'add friend', function() send('FriendRequest', { name = p.name }) end }
                end
                if not inParty(acct) then
                    actions[#actions + 1] = { 'party', function() send('PartyInvite', { acct = acct }) end }
                end
                actions[#actions + 1] = { 'block', function() send('BlockAdd', { name = p.name }) end }
                rows[#rows + 1] = personRow(p.name, { actions = actions })
            end
        end
    end
    if others == 0 then
        rows[#rows + 1] = U.text('Nobody else is online right now.')
    elseif others > shown then
        rows[#rows + 1] = U.text('... and ' .. (others - shown) .. ' more online'
            .. ' (add them by name from the Friends tab)')
    end
    return rows
end

local function friendsTab()
    local rows = {}
    if #friends == 0 then
        rows[#rows + 1] = U.text('No friends yet - add someone from the Players tab.')
    end
    for _, f in ipairs(friends) do
        local actions = {}
        if f.online then
            actions[#actions + 1] = { 'invite', function() send('InviteSend', { acct = f.acct }) end }
            if not inParty(f.acct) then
                actions[#actions + 1] = { 'party', function() send('PartyInvite', { acct = f.acct }) end }
            end
        end
        actions[#actions + 1] = { 'remove', function() send('FriendRemove', { acct = f.acct }) end }
        rows[#rows + 1] = personRow(f.name, {
            where = f.online and f.cellKey or nil,
            offline = not f.online,
            actions = actions,
        })
    end

    for acct, name in pairs(requests) do
        rows[#rows + 1] = U.row {
            U.text(name .. ' wants to be friends', { grow = 1 }),
            U.button('accept', function() send('FriendAccept', { acct = acct }) end),
            U.button('block', function() send('BlockAdd', { name = name }) end),
        }
    end

    rows[#rows + 1] = U.interval
    rows[#rows + 1] = U.text('Add by name (click the field, type, press Enter)')
    rows[#rows + 1] = {
        template = I.MWUI.templates.textEditLine,
        props = { size = util.vector2(320, 0) },
        events = {
            textChanged = async:callback(function(text) draft = text end),
            keyPress = async:callback(function(e)
                if e.code == input.KEY.Enter and draft ~= '' then
                    send('FriendRequest', { name = draft })
                    draft = ''
                    render()
                end
            end),
        },
    }
    return rows
end

local function partyTab()
    local rows = {}
    local members = party.members or {}
    if #members == 0 then
        rows[#rows + 1] = U.text('You are not in a party.')
        rows[#rows + 1] = U.text('Invite someone from the Players or Friends tab to start one.')
    else
        for _, m in ipairs(members) do
            rows[#rows + 1] = personRow(m.name, {
                where = m.online and m.cellKey or nil,
                offline = not m.online,
                leader = m.acct == party.leader,
                actions = m.online and { { 'travel to', function() send('InviteAccept', { acct = m.acct }) end } } or nil,
            })
        end
        rows[#rows + 1] = U.interval
        rows[#rows + 1] = U.row { U.button('leave party', function() send('PartyLeave', {}) end) }
    end

    for acct, inv in pairs(invites) do
        local verb = inv.kind == 'party' and 'invited you to their party' or 'invited you to join them'
        rows[#rows + 1] = U.row {
            U.text(inv.name .. ' ' .. verb, { grow = 1 }),
            U.button('accept', function()
                send(inv.kind == 'party' and 'PartyAccept' or 'InviteAccept', { acct = acct })
                invites[acct] = nil
                render()
            end),
            U.button('dismiss', function()
                invites[acct] = nil
                render()
            end),
        }
    end
    return rows
end

local function tabBar()
    local function tabButton(key, label)
        -- The active tab is marked with the header colour rather than punctuation, so the
        -- bar reads like the game's own tabbed panels.
        return U.button(label, function()
            tab = key
            render()
        end, { color = key == tab and I.MWUI.templates.textHeader.props.textColor or nil })
    end
    return U.row {
        tabButton('players', 'Players (' .. math.max(0, #roster - 1) .. ')'),
        tabButton('friends', 'Friends (' .. #friends .. ')'),
        tabButton('party', 'Party (' .. #(party.members or {}) .. ')'),
    }
end

local function presenceBar()
    local items = { U.text('Visible to:') }
    for _, mode in ipairs(PRESENCE_MODES) do
        items[#items + 1] = U.button(mode, function()
            send('PresenceMode', { mode = mode })
        end, { color = mode == presence and I.MWUI.templates.textHeader.props.textColor or nil })
    end
    return U.column {
        U.row(items),
        U.text(PRESENCE_HELP[presence] or ''),
    }
end

-- Windows rebuild by destroy+create — there is no in-place update in this UI API — so every
-- state change re-renders the whole hub.
render = function()
    if not isOpen then return end
    destroy()
    local tabRows = (tab == 'friends' and friendsTab()) or (tab == 'party' and partyTab()) or playersTab()
    -- Tab content and the privacy control each get their own bordered panel, mirroring how
    -- the settings screen groups controls, so the eye can find the sections.
    local body = { tabBar(), U.panel(tabRows), U.panel({ presenceBar() }) }
    if status ~= '' then
        body[#body + 1] = U.text(status)
    end
    body[#body + 1] = U.row { U.button('close', function()
        isOpen = false
        destroy()
        I.UI.removeMode('Interface')
    end) }

    I.UI.setMode('Interface', { windows = {} })
    element = ui.create(U.window('Social', body))
end

local function toggle()
    if isOpen then
        isOpen = false
        destroy()
        I.UI.removeMode('Interface')
    else
        isOpen = true
        myName = myName or mp.getName()
        render()
    end
end

local function mirror()
    mp.testSet('friends', json.encode(friends))
    mp.testSet('party', json.encode(party))
    mp.testSet('presenceMode', presence)
    local reqs, invs = {}, {}
    for acct, name in pairs(requests) do reqs[#reqs + 1] = { acct = acct, name = name } end
    for acct, inv in pairs(invites) do invs[#invs + 1] = { acct = acct, name = inv.name, kind = inv.kind } end
    mp.testSet('friendRequests', json.encode(reqs))
    mp.testSet('invites', json.encode(invs))
end

-- ESC -> Options -> Social. Registered as a settings PAGE so the engine's own settings UI
-- renders it: that is native by construction, rather than an imitation of native. The ESC
-- menu's own buttons are C++ ImageButtons backed by Morrowind's menu_*.dds art, so adding
-- one there would need matching artwork and would look MORE foreign without it.
--
-- The page carries the privacy control, which is a genuine setting and belongs somewhere
-- findable even when the hub is closed. The live lists stay in the hub (F) — a settings
-- screen is the wrong place for something that changes every few seconds.
local PRESENCE_SETTING = 'SettingsPlayerOmwMpSocial'

local function registerSettingsPage()
    I.Settings.registerPage {
        key = 'OmwMpSocial',
        l10n = 'OmwMpSocial',
        name = 'Social',
        description = 'Multiplayer friends, party and privacy. Press F in game to open the Social hub.',
    }
    I.Settings.registerGroup {
        key = PRESENCE_SETTING,
        page = 'OmwMpSocial',
        l10n = 'OmwMpSocial',
        name = 'Privacy',
        description = 'Who can see where you are, and who may invite you.',
        permanentStorage = true,
        settings = {
            {
                key = 'PresenceMode',
                renderer = 'select',
                name = 'Visible to',
                description = 'public: anyone. friends: friends only. party: your party only.'
                    .. ' private: nobody, and invites are refused.',
                default = 'friends',
                argument = { items = PRESENCE_MODES },
            },
        },
    }
    -- The SERVER is the authority on presence — it gates every disclosure — so the setting
    -- is pushed to it rather than being applied locally. A client-side-only privacy control
    -- would be decoration.
    local section = storage.playerSection(PRESENCE_SETTING)
    section:subscribe(async:callback(function(_, key)
        if key == 'PresenceMode' then send('PresenceMode', { mode = section:get('PresenceMode') }) end
    end))
end

return {
    engineHandlers = {
        onInit = registerSettingsPage,
        onLoad = registerSettingsPage,
        onKeyPress = function(key)
            if key.symbol == 'f' and not I.UI.getMode() then toggle() end
        end,
    },
    eventHandlers = {
        -- Test-only: the harness cannot press F (no SDL key injection), so the window has
        -- to be openable another way for any automated UI check to exist.
        MP_SocialUiOpen = function()
            if not isOpen then toggle() end
        end,
        MP_Roster = function(data)
            roster = data.players or {}
            render()
        end,
        MP_FriendList = function(data)
            friends = data.friends or {}
            -- Drop any pending request from someone who is now a friend. Clearing it only in
            -- the accept handler left the same person listed as BOTH a friend and a pending
            -- request whenever the accept happened another way — from a second session, or
            -- via the mutual-request path where the server completes the friendship without
            -- this client pressing anything.
            for _, f in ipairs(friends) do
                requests[f.acct] = nil
                invites[f.acct] = nil
            end
            mirror()
            render()
        end,
        MP_PartyUpdate = function(data)
            party = { leader = data.leader or '', members = data.members or {} }
            for _, m in ipairs(party.members) do invites[m.acct] = nil end
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
                invites[data.fromAcct] = { name = data.fromName or data.fromAcct, kind = 'travel' }
                ui.showMessage(tostring(invites[data.fromAcct].name) .. ' invited you to join them (F)')
                mirror()
                render()
            end
        end,
        MP_PartyInviteReceived = function(data)
            if data.fromAcct then
                invites[data.fromAcct] = { name = data.fromName or data.fromAcct, kind = 'party' }
                ui.showMessage(tostring(invites[data.fromAcct].name) .. ' invited you to their party (F)')
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
        -- Every refused action reports why. An action that silently does nothing is
        -- indistinguishable from a broken server.
        MP_SocialResult = function(data)
            if data.op == 'PresenceMode' and data.ok == true then
                presence = tostring(data.detail)
                status = 'Visibility set to ' .. presence .. '.'
            else
                status = tostring(data.op or '?') .. ': ' .. tostring(data.detail or '?')
                if data.ok ~= true then ui.showMessage(status) end
            end
            mp.testSet('socialResult', json.encode({ op = data.op, ok = data.ok, detail = data.detail }))
            mirror()
            render()
        end,
    },
}
