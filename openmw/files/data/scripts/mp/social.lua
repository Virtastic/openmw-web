-- Multiplayer SOCIAL hub (Phase C/E): everyone playing, friends, and presence.
-- Opened by the Social key (default 'O', rebindable in Options -> Controls under both
-- Mouse/Keyboard and Controller — it is a real engine action, MWInput::A_Social).
--
-- Built to read like the engine's own Options window (see scripts/mp/ui.lua): a large,
-- centred, fixed-footprint frame with a title, a tab strip whose selected tab is filled, its
-- content grouped into bordered panels, and a footer bar with the dismiss button — GMST font
-- colours and real spacing throughout, so it is native by resemblance, not a debug overlay.
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


local json = require('scripts.mp.json')

-- `isOpen` is deliberately separate from `element`. Using the element slot itself as the
-- open flag (element = true) made destroy() call `element:destroy()` on a BOOLEAN, which
-- threw inside the event handler: every mirror still updated, so state assertions passed
-- while the player saw no window at all.
local isOpen = false
local element = nil
local tab = 'players' -- players | friends | worlds | chars

local roster = {} -- everyone in the world: {id, name}
local friends = {} -- {acct, name, online, playerId, cellKey}
local blocked = {} -- {acct, name}: who I have blocked, so the panel can offer unblock
local muted = {} -- {acct, name}: who I have muted, so the panel can offer unmute
local requests = {} -- acct -> name (incoming friend requests)
local invites = {} -- acct -> {name=} (world invites: come stand next to me)
local presence = 'friends'
-- Availability (Online/Offline) — a SEPARATE axis from presence (which is "who sees my
-- location"). Offline peels you into your Solo world, hidden and unjoinable. Echoed back by
-- the server on SetAvailability so the toggle reflects the real state.
local availability = 'online'
local status = ''
local draft = ''
local myName = nil

-- F3 world browser. worlds=nil means "not asked yet", {} means "asked, none joinable" —
-- the two read very differently to a player and must not collapse into one blank list.
-- Friend requests THIS CLIENT has just sent, keyed by lowercased display name.
--
-- The row already renders 'Request sent' -- but only once the SERVER roster comes back saying
-- reqOut, which is a round trip away. Until then the button still read 'add friend', so
-- clicking it appeared to do nothing and inviting the same person twice was the natural
-- response. Recording the click locally flips the row immediately; the server's own reqOut
-- takes over when it arrives, and the two agree.
local sentFriendReq = {}
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
-- Report flow: pick a target from a row, then type the reason. Kept as window state
-- rather than a modal so the player can still see who is who while writing it.
local reportTarget = nil
local reportName = nil
local reportDraft = ''
-- There is no scroll container in this UI API, so a long list would simply run off the
-- bottom of the screen. The world is designed for ~100 concurrent players, so the Players
-- tab WILL exceed the screen — cap it and say how many are hidden rather than rendering a
-- window taller than the display and pretending it is fine.
local MAX_ROWS = 12

local PRESENCE_MODES = { 'public', 'friends', 'private' }
local PRESENCE_HELP = {
    public = 'anyone can see where you are',
    friends = 'only friends can see where you are',
    private = 'nobody can see you, and invites are refused',
}

-- WHAT THE PLAYER IS TOLD WHEN A SOCIAL ACTION IS REFUSED.
--
-- Every social op answers with a `SocialResult` carrying a protocol code — `blocked`,
-- `private`. Those are wire identifiers, and they used to be shown to the player verbatim,
-- which is the difference between a game telling you what happened and a game leaking its
-- own internals at you.
local SOCIAL_FAIL = {
    no_such_player    = 'No player by that name.',
    blocked           = 'You cannot do that with this player.',
    already_friends   = 'You are already friends.',
    self              = 'That is you.',
    too_many_requests = 'Too many requests pending — try again shortly.',
    no_request        = 'That invitation has expired.',
    not_online        = 'They are offline.',
    private           = 'They are not accepting invitations.',
}

local SOCIAL_FAIL_BY_OP = {}

local SOCIAL_OK = {
    InviteSend    = 'Invitation sent.',
    InviteAccept  = 'Invitation accepted.',
    FriendAccept  = 'You are now friends.',
    FriendRemove  = 'Friend removed.',
    BlockAdd      = 'Blocked.',
    BlockRemove   = 'Unblocked.',
    MuteAdd       = 'Muted.',
    MuteRemove    = 'Unmuted.',
    ReportPlayer  = 'Report sent to the moderators.',
}

local SOCIAL_SILENT = {}

-- FriendRequest answers 'sent' or 'accepted' — a request that crosses one already waiting the
-- other way completes on the spot, and saying "request sent" there would be wrong.
local function socialText(op, ok, detail)
    if ok then
        if op == 'FriendRequest' then
            return detail == 'accepted' and 'You are now friends.' or 'Friend request sent.'
        end
        return SOCIAL_OK[op] or 'Done.'
    end
    local byOp = SOCIAL_FAIL_BY_OP[op]
    return (byOp and byOp[detail]) or SOCIAL_FAIL[detail]
        or (tostring(op) .. ': ' .. tostring(detail or '?'))
end

local function send(op, body)
    body = body or {}
    body.op = op
    core.sendGlobalEvent('mpSocial', body)
end

-- Switching world is a reconnect, not a reload: mp.connect takes any URL, so the engine
-- keeps running and only the session moves. Accounts are shared across worlds (F1), so
-- the same login works wherever we land. THE ADDRESS IS COMPUTED ON THE GLOBAL SIDE, by
-- worldUrlOf, the one place that knows the rule (prefer the gateway PATH on the current
-- connection's authority; fall back to host:port only when a world publishes them). Used by
-- the overlay's join (MP_SocialJoinById), so it lives with the bridge, not the dead window.
local function joinWorld(w)
    joiningWorld = tostring(w.name)
    status = 'Joining ' .. joiningWorld .. '...'
    -- mpJoinWorld, NOT MP_JoinWorld: mp* is player -> global, MP_* is global -> player.
    -- Sending the wrong one is silent -- an unhandled sendGlobalEvent simply does nothing.
    core.sendGlobalEvent('mpJoinWorld', {
        name = tostring(w.name), id = tostring(w.id or ''),
        wsPath = w.wsPath, host = w.host, port = w.port,
    })
end

-- The MyGUI window is gone; the overlay renders. Kept as a no-op so the handlers below
-- read the same as when they redrew a window.
local render = function() end

-- The Social hub is now presented by the HTML overlay (index.html), not MyGUI. This script
-- is the BRIDGE: it maintains social state from server events and MIRRORS it to JS via
-- mirror() (window.omw.state.friends/presenceMode/availability/blocked/muted/...); the overlay reads
-- that and sends ops back as commands (social:/where:/avail:/joinfriend:/...) parsed in
-- player.lua's dispatch. render() is a deliberate no-op so the old MyGUI window (and its
-- tab builders, kept below but never called) never draws. The O key raises an openSocial
-- signal the overlay polls; the overlay drives the cursor via uimode: commands.
local function mirror()
    mp.set('friends', json.encode(friends))
    mp.set('blocked', json.encode(blocked))
    mp.set('muted', json.encode(muted))
    mp.set('presenceMode', presence)
    mp.set('availability', availability)
    local reqs, invs = {}, {}
    for acct, name in pairs(requests) do reqs[#reqs + 1] = { acct = acct, name = name } end
    for acct, inv in pairs(invites) do invs[#invs + 1] = { acct = acct, name = inv.name } end
    mp.set('friendRequests', json.encode(reqs))
    mp.set('invites', json.encode(invs))
end

-- Raise the openSocial signal the HTML overlay polls. (isOpen/toggle semantics are gone with
-- the MyGUI window; the overlay owns open/close.)
local socialOpenSeq = 0
local function toggle()
    socialOpenSeq = socialOpenSeq + 1
    mp.set('openSocial', tostring(socialOpenSeq)) -- testSet takes strings only
end

-- The Social hub used to also register a settings PAGE under Options -> Scripts (carrying a
-- duplicate privacy control). That was removed: privacy now lives inside the hub itself, and
-- a half-empty "Social" entry buried in the Scripts list only fragmented the feature. The hub
-- is the one place for all of it, opened by the rebindable Social key or from wherever else.

-- The Social key. It is a real engine input action (MWInput::A_Social, default 'O') so it
-- shows up in Options -> Controls under BOTH Mouse/Keyboard and Controller and can be
-- rebound there like any other control — not a hardcoded key. C++ forwards every action
-- press to onInputAction below; input.ACTION.Social is that action's id.
local SOCIAL_ACTION = input.ACTION and input.ACTION.Social

return {
    engineHandlers = {
        onInputAction = function(id)
            if SOCIAL_ACTION == nil or id ~= SOCIAL_ACTION then return end
            -- Raise the openSocial signal; the HTML overlay toggles itself open/closed.
            toggle()
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
            blocked = data.blocked or {}
            muted = data.muted or {}
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
                invites[data.fromAcct] = { name = data.fromName or data.fromAcct }
                ui.showMessage(tostring(invites[data.fromAcct].name) .. ' invited you to join them (F)')
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
            mp.set('joinError', 'no such world: ' .. want)
        end,
        -- Test-only: the harness has no way to click a tab button.
        MP_SocialTab = function(data)
            local which = tostring(data.tab or '')
            if which == 'players' or which == 'friends' or which == 'worlds' or which == 'chars' then
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
        MP_ProfileResult = function(data)
            status = data.ok and 'Profile saved.' or ('Profile not saved: ' .. tostring(data.error or 'error'))
            render()
        end,
        MP_WorldList = function(data)
            worlds = data.worlds or {}
            worldsError = tostring(data.error or '')
            myWorldPort = data.myPort
            mp.set('worldCount', string.format('%d', #worlds))
            -- The list itself, so a scenario can assert a SPECIFIC world is present rather
            -- than only counting (s57 reaps and revives one world by id).
            local ids = {}
            for _, w in ipairs(worlds) do ids[#ids + 1] = { id = w.id, up = w.up } end
            mp.set('worlds', json.encode(ids))
            mp.set('worldsError', worldsError)
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
            mp.set('worldCreate', json.encode({ ok = data.ok, error = data.error }))
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
        -- Why the world clock did not move. `[rules] timeSkip` refuses a Rest or Wait.
        -- Without this the bed simply does nothing and the player tries again.
        MP_WorldTimeRefused = function(data)
            -- The server already phrases this as a sentence ("time does not skip in this
            -- world", "only the world owner can rest for everyone"), so pass it through
            -- rather than re-deriving it from a code that does not exist. A lookup table here
            -- would silently stop matching the day someone adds a reason.
            local reason = tostring(data.reason or '')
            if reason == '' then reason = 'you cannot pass time here' end
            status = reason:sub(1, 1):upper() .. reason:sub(2) .. '.'
            ui.showMessage(status)
            render()
        end,
        -- The swing was real and the server threw it away, because the cell it landed in is not
        -- being simulated right now (the peer is restarting, or has not picked the cell up yet).
        -- Without this the attack just does nothing, which reads as a broken game rather than a
        -- momentary one.
        MP_CombatRefused = function(data)
            local why = tostring(data.reason or '')
            if why == 'stale epoch' then
                status = 'The world is handing this area over — try that again.'
            else
                status = 'This area is not being simulated right now; attacks will not land.'
            end
            ui.showMessage(status)
        end,
        MP_SocialNotice = function(data)
            status = 'Something changed: ' .. tostring(data.kind or 'notice')
            ui.showMessage(status)
            mirror()
            render()
        end,
        MP_SocialResult = function(data)
            if data.op == 'PresenceMode' and data.ok == true then
                presence = tostring(data.detail)
                status = 'Visibility set to ' .. presence .. '.'
            elseif data.op == 'SetAvailability' and data.ok == true then
                availability = tostring(data.detail)
                status = availability == 'offline'
                    and 'You are offline (solo, hidden).' or 'You are online.'
            elseif data.op == 'SetWorldMode' and data.ok == true then
                status = tostring(data.detail) == 'party'
                    and 'Your world is open to your friends.' or 'Your world is solo again.'
            elseif SOCIAL_SILENT[data.op] then
                -- Machinery, not a player action. Never narrated, success or failure.
            else
                status = socialText(data.op, data.ok == true, tostring(data.detail or ''))
                if data.ok ~= true then ui.showMessage(status) end
            end
            mp.set('socialResult', json.encode({ op = data.op, ok = data.ok, detail = data.detail }))
            mirror()
            render()
        end,
        -- Cross-world join result (the redial itself happens in global.lua on success).
        MP_JoinFriend = function(data)
            if data.ok == true then
                status = 'Joining ' .. tostring(data.friendName or 'your friend') .. '...'
            else
                local why = {
                    not_friends = 'You are not friends with them.',
                    not_online = 'They are offline.',
                    blocked = 'You cannot join them.',
                }
                status = why[tostring(data.error)] or ('Could not join: ' .. tostring(data.error or '?'))
                ui.showMessage(status)
            end
            render()
        end,
    },
}
