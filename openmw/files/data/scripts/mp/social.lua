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
local tab = 'players' -- players | friends | party | worlds | chars

local roster = {} -- everyone in the world: {id, name}
local friends = {} -- {acct, name, online, playerId, cellKey}
local party = { leader = '', members = {} }
local requests = {} -- acct -> name (incoming friend requests)
local invites = {} -- acct -> {name=, kind='travel'|'party'}
local presence = 'friends'
local status = ''
local draft = ''
local myName = nil

-- F3 world browser. worlds=nil means "not asked yet", {} means "asked, none joinable" —
-- the two read very differently to a player and must not collapse into one blank list.
local worlds = nil
local worldsError = ''
local worldDraft = ''
local myWorldPort = nil -- so the world we are IN is marked rather than offered as a join
local joiningWorld = nil -- name of the world a join is in flight to, nil = not switching

-- Character slots. nil = not asked yet; the list comes from the global script's cache of
-- Welcome/CharacterResult (MP_Characters). Switching is a reconnect with the selection.
local characters = nil
local activeCharId = ''
local charDraft = ''
-- Party voice: off until the player asks for it (the browser mic prompt is the consent
-- step). Push-to-talk is bound to V in the player script.
local voiceOn = false

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
                -- Mute is separate from block: block ends the relationship, mute just
                -- means "I do not want to hear this person right now". Persistent, so it
                -- survives a relog.
                actions[#actions + 1] = { 'mute', function() send('MuteAdd', { acct = acct }) end }
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
        -- Group travel: the whole party moves together. Leader-only server-side — a
        -- non-leader pressing these gets a loud SocialResult rather than a silent nothing.
        rows[#rows + 1] = U.row {
            U.button(voiceOn and 'voice: on' or 'voice: off', function()
                voiceOn = not voiceOn
                -- Enabling prompts the browser for the microphone: consent is the prompt,
                -- which is why voice is never hot just because you joined a party.
                core.sendGlobalEvent('mpVoice', { op = voiceOn and 'enable' or 'disable' })
                status = voiceOn and 'Voice on (hold V to talk).' or 'Voice off.'
                render()
            end),
        }
        rows[#rows + 1] = U.row {
            U.button('travel: party world', function()
                status = 'Asking the party to travel...'
                send('PartyTravel', { target = 'party' })
                render()
            end),
            U.button('travel: public', function()
                status = 'Asking the party to travel...'
                send('PartyTravel', { target = 'public' })
                render()
            end),
            U.button('leave party', function() send('PartyLeave', {}) end),
        }
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

local function joinWorld(w)
    -- Switching world is a reconnect, not a reload: mp.connect takes any URL, so the engine
    -- keeps running and only the session moves. Accounts are shared across worlds (F1), so
    -- the same login works wherever we land.
    if not w.host or not w.port then
        status = 'That world did not say where to connect.'
        render()
        return
    end
    local url = 'ws://' .. tostring(w.host) .. ':' .. string.format('%d', w.port) .. '/ws'
    joiningWorld = tostring(w.name)
    status = 'Joining ' .. joiningWorld .. '...'
    render()
    -- mpJoinWorld, NOT MP_JoinWorld: this repo's convention is `mp*` for player -> global
    -- (mpSocial, mpOpenUi) and `MP_*` for global -> player. Sending the wrong one is
    -- silent — sendGlobalEvent for an unhandled name simply does nothing.
    core.sendGlobalEvent('mpJoinWorld', { url = url, name = tostring(w.name) })
end

local function worldsTab()
    local rows = {}

    if worldsError == 'no_gateway' then
        rows[#rows + 1] = U.text('This is a standalone world.')
        rows[#rows + 1] = U.text('There is no world directory to browse - which is perfectly')
        rows[#rows + 1] = U.text('normal for a single server.')
        return rows
    end
    if worldsError ~= '' then
        rows[#rows + 1] = U.text('Could not reach the world directory.')
        rows[#rows + 1] = U.row { U.button('try again', function() send('WorldList', {}) end) }
        return rows
    end
    if worlds == nil then
        -- Never asked yet. Distinct from "asked and there are none".
        rows[#rows + 1] = U.text('Loading worlds...')
        return rows
    end
    if #worlds == 0 then
        rows[#rows + 1] = U.text('No worlds are available right now.')
    end

    for _, w in ipairs(worlds) do
        local here = myWorldPort ~= nil and w.port == myWorldPort
        local full = w.maxPlayers > 0 and w.playerCount >= w.maxPlayers
        local where = string.format('%d', w.playerCount or 0)
        if (w.maxPlayers or 0) > 0 then where = where .. '/' .. string.format('%d', w.maxPlayers) end
        where = where .. ' players, ' .. tostring(w.mode)
        if not w.up then where = where .. ', starting up' end

        local actions = nil
        if here then
            -- The world you are standing in is marked, not offered — a "join" that
            -- reconnects you to where you already are looks like a bug.
            where = where .. ' - you are here'
        elseif not w.up then
            where = where .. ''
        elseif full then
            where = where .. ' - full'
        else
            actions = { { 'join', function() joinWorld(w) end } }
        end
        rows[#rows + 1] = personRow(tostring(w.name), { where = where, actions = actions })
    end

    rows[#rows + 1] = U.text('')
    rows[#rows + 1] = U.text('Host your own session:')
    rows[#rows + 1] = U.row {
        U.text('Name: '),
        {
            template = I.MWUI.templates.textEditLine,
            props = { size = util.vector2(180, 22), text = worldDraft },
            events = {
                textChanged = async:callback(function(text) worldDraft = text end),
            },
        },
        U.button('private', function()
            if worldDraft ~= '' then send('WorldCreate', { id = worldDraft, mode = 'private' }) end
        end),
        U.button('party', function()
            if worldDraft ~= '' then send('WorldCreate', { id = worldDraft, mode = 'party' }) end
        end),
    }
    rows[#rows + 1] = U.text('A private session is yours alone; a party session is for your party.')
    return rows
end

local function charsTab()
    local rows = {}
    if characters == nil then
        rows[#rows + 1] = U.text('Loading characters...')
        return rows
    end
    for _, ch in ipairs(characters) do
        local here = ch.id == activeCharId
        rows[#rows + 1] = personRow(tostring(ch.name), {
            where = here and 'playing now' or nil,
            actions = (not here) and {
                { 'play', function()
                    status = 'Switching to ' .. tostring(ch.name) .. '...'
                    render()
                    -- A switch is a reconnect with the selection; the world stays put.
                    core.sendGlobalEvent('mpCharSwitch', { id = ch.id })
                end },
            } or nil,
        })
    end
    rows[#rows + 1] = U.interval
    rows[#rows + 1] = U.text('New character (name, then create):')
    rows[#rows + 1] = U.row {
        {
            template = I.MWUI.templates.textEditLine,
            props = { size = util.vector2(220, 22), text = charDraft },
            events = {
                textChanged = async:callback(function(text) charDraft = text end),
            },
        },
        U.button('create', function()
            if charDraft ~= '' then
                core.sendGlobalEvent('mpCharCreate', { name = charDraft })
                charDraft = ''
                status = 'Creating character...'
                render()
            end
        end),
    }
    rows[#rows + 1] = U.text('Each character has its own story, journal and solo world.')
    return rows
end

local function tabBar()
    local function tabButton(key, label)
        -- The active tab is marked with the header colour rather than punctuation, so the
        -- bar reads like the game's own tabbed panels.
        return U.button(label, function()
            tab = key
            -- Ask the directory the first time the Worlds tab is opened, not on every
            -- render (render runs on every roster/presence event) and not at login (a
            -- player who never opens it should cost the gateway nothing).
            if key == 'worlds' and worlds == nil and worldsError == '' then
                send('WorldList', {})
            end
            if key == 'chars' and characters == nil then
                core.sendGlobalEvent('mpChars', {})
            end
            render()
        end, { color = key == tab and I.MWUI.templates.textHeader.props.textColor or nil })
    end
    return U.row {
        tabButton('players', 'Players (' .. math.max(0, #roster - 1) .. ')'),
        tabButton('friends', 'Friends (' .. #friends .. ')'),
        tabButton('party', 'Party (' .. #(party.members or {}) .. ')'),
        tabButton('worlds', worlds and ('Worlds (' .. #worlds .. ')') or 'Worlds'),
        tabButton('chars', characters and ('Characters (' .. #characters .. ')') or 'Characters'),
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
    local tabRows = (tab == 'friends' and friendsTab())
        or (tab == 'party' and partyTab())
        or (tab == 'worlds' and worldsTab())
        or (tab == 'chars' and charsTab())
        or playersTab()
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
            -- Arriving somewhere completes any join in flight. The world list and the port
            -- that marks "you are here" both belong to the world we LEFT, so they are
            -- dropped rather than shown stale — the tab refetches next time it is opened.
            if joiningWorld then
                status = 'You are now in ' .. joiningWorld .. '.'
                joiningWorld = nil
                worlds = nil
                worldsError = ''
                myWorldPort = nil
                if tab == 'worlds' then send('WorldList', {}) end
            end
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
            -- Keep the voice mesh exactly in step with the party the player can see:
            -- someone who left the group must not still be connected to your microphone.
            core.sendGlobalEvent('mpVoice', { op = 'party', members = data.members or {} })
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
        -- Test-only: press "join" for a listed world by id, through the SAME joinWorld()
        -- path the button uses (not a shortcut around it).
        MP_SocialJoinById = function(data)
            local want = tostring(data.id or '')
            for _, w in ipairs(worlds or {}) do
                if tostring(w.id) == want then
                    joinWorld(w)
                    return
                end
            end
            mp.testSet('joinError', 'no such world: ' .. want)
        end,
        -- Test-only: the harness has no way to click a tab button.
        MP_SocialTab = function(data)
            local which = tostring(data.tab or '')
            if which == 'players' or which == 'friends' or which == 'party' or which == 'worlds' or which == 'chars' then
                tab = which
                if which == 'worlds' and worlds == nil and worldsError == '' then
                    send('WorldList', {})
                end
                if which == 'chars' and characters == nil then
                    core.sendGlobalEvent('mpChars', {})
                end
                if not isOpen then toggle() else render() end
            end
        end,
        -- Character slots: the account's slot list (asked for, or pushed after a create).
        MP_Characters = function(data)
            characters = data.characters or {}
            activeCharId = tostring(data.active or '')
            if data.ok == true then status = 'Character created.'
            elseif data.ok == false then
                status = data.error == 'full' and 'All character slots are used.'
                    or data.error == 'badname' and 'That name cannot be used.'
                    or 'Could not create the character.'
            end
            render()
        end,
        -- Party travel: the actual redial happens in the global script; this is the notice.
        MP_PartyTravel = function(data)
            local dest = tostring(data.worldId or 'another world')
            status = (data.target == 'public')
                and ('Your party is heading to ' .. dest .. '.')
                or ('Your party is heading to its own world.')
            render()
        end,
        MP_ProfileResult = function(data)
            status = data.ok and 'Profile saved.' or ('Profile not saved: ' .. tostring(data.error or 'error'))
            render()
        end,
        MP_WorldList = function(data)
            worlds = data.worlds or {}
            worldsError = tostring(data.error or '')
            myWorldPort = data.myPort
            mp.testSet('worldCount', string.format('%d', #worlds))
            mp.testSet('worldsError', worldsError)
            render()
        end,
        MP_WorldCreate = function(data)
            if data.ok == true and data.world then
                status = 'Session "' .. tostring(data.world.name or data.world.id) .. '" is ready.'
                worldDraft = ''
                -- Refresh so the new session appears in the list with a join button.
                send('WorldList', {})
            else
                local why = tostring(data.error or 'refused')
                local human = why
                if why == 'too_many_sessions' then human = 'You already have as many sessions as you are allowed.'
                elseif why == 'platform_full' then human = 'The server has no room for another world right now.'
                elseif why == 'bad_id' then human = 'That name has characters the server will not accept.'
                elseif why == 'unreachable' then human = 'The world directory did not answer.'
                end
                status = human
                ui.showMessage(human)
            end
            mp.testSet('worldCreate', json.encode({ ok = data.ok, error = data.error }))
            render()
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
