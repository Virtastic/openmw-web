-- omw-mp/1 session driver (M0) — see server/PROTOCOL.md. Required by scripts/mp/global.lua,
-- which forwards the MP_Transport*/MP_SessionJson global events here. This module owns the
-- session state machine; the C++ NetManager only tracks connection state + what we tell it.
local core = require('openmw.core')
local mp = require('openmw.mp')

local json = require('scripts.mp.json')

local PING_IDLE_SECONDS = 30

-- Reconnect backoff. Truncated exponential with FULL jitter: delay = random(0, min(cap,
-- base*2^n)). The jitter is not decoration — synchronized client retries against a slow or
-- restarting backend are a documented cascading-failure mode (SRE Workbook, Pokemon GO:
-- retry amplification produced 20x peak RPS and effectively halved GCLB capacity). Every
-- one of our clients notices a server restart within the same second, so without jitter
-- they would all redial in lockstep.
local RECONNECT_BASE_SECONDS = 1
local RECONNECT_CAP_SECONDS = 30

local net = {
    state = 'Offline', -- Offline|Connecting|HelloSent|Authing|Joined|Reconnecting|Failed
    playerId = nil,
    flags = {}, -- SessionWelcome.flags (M5: pvp, difficulty)
    serverName = nil,
    motd = nil,
    sessionToken = nil,
    rttMs = nil,
    lastError = nil,
    -- global.lua fills these in before start():
    onStateChanged = function() end,
}

-- Auth ladder (PROTOCOL.md session flow + §M8 resume): resume -> register -> login.
-- A parked resume ticket is tried FIRST because it skips argon2 and rejoins in place; an
-- unknown/expired token answers AUTH_FAILED, which drops us onto the normal ladder.
local authMode = 'register'
local triedLogin = false
local triedResume = false
local triedTicket = false
local lastSendTime = 0 -- real time; onUpdate dt pauses with the world, pings must not
-- F3: the world we are currently dialling. nil = the boot URL from the environment. Set by
-- switchTo so that RECONNECTS after a world switch redial the new world, not the one the
-- player originally launched into — otherwise a dropped connection would silently teleport
-- them back to the public world.
local currentUrl = nil
local function targetUrl() return currentUrl or mp.getUrl() end
-- Character slots: which slot the NEXT auth should select. nil = server default (last
-- played). Set by the character UI right before a switch-reconnect; cleared once the
-- server confirms in Welcome so later reconnects fall back to the (now correct) default.
local desiredCharId = nil
-- The character slot chosen on the HTML pre-boot tile screen (OPENMW_MP_CHARACTER via
-- mp.getBootCharacter). Applied on the first auth; an in-game switch overrides it below.
if mp.getBootCharacter then
    local boot = mp.getBootCharacter()
    if type(boot) == 'string' and boot ~= '' then desiredCharId = boot end
end
function net.setCharacter(id)
    desiredCharId = (type(id) == 'string' and id ~= '') and id or nil
end
-- Exposed for global.lua (character switch redials the world we are in).
function net.currentTarget() return targetUrl() end

-- Mirrored so a test can assert WHICH world the next dial would reach. Every reconnect path
-- goes through targetUrl(), so this one value determines where a dropped player comes back
-- to; if it were still the boot URL after a switch, a hiccup would silently return them to
-- the public world mid-session.
local function mirrorTarget() mp.testSet('dialTarget', targetUrl()) end

-- While set (real time), connection failures keep retrying instead of turning terminal:
-- covers the window where a freshly created world is still booting. Cleared on Joined.
local switchDeadline = nil
-- Bounds the wait for a travel ticket, so a wedged world cannot strand a world switch.
-- True from the moment a world switch is requested until we ARRIVE somewhere. Kept because a
-- switch must authenticate with its travel ticket, never with a resume token belonging to the
-- world we are leaving.
local switching = false
-- The next close is OURS. dialNow hangs up the old world before dialling the new one, and
-- onClose cannot otherwise tell that close apart from a real drop: it only sees state ==
-- 'Joined' and reports "connection lost", which is what greeted players creating a character
-- (creating one opens a private world, which is a switch). Scoped to a single close rather
-- than keyed on `switching`, because `switching` stays true until we ARRIVE — so a new
-- connection that fails on the way must still be reported.
local closingForSwitch = false
local reconnectAttempt = 0 -- reset on a successful Joined
-- Have we EVER been in the world on this page? A drop after joining is worth retrying
-- indefinitely (the character is in there, and the resume ticket rejoins in place). A server
-- that was never reachable is a different situation: retrying it silently forever leaves the
-- player staring at a boot screen with no explanation, which is the failure s90 exists to
-- catch. Retry a few times, then say so.
local everJoined = false
local UNREACHABLE_ATTEMPTS = 3
-- Monotonic and NEVER reset, unlike reconnectAttempt. A test that watches for a transient
-- ("state left Joined") races the redial, which on localhost can complete between polls;
-- a counter that only ever grows cannot be missed.
local reconnectTotal = 0
local reconnectAt = nil -- real time to redial at, nil = not scheduled
-- Sticky for the whole reconnect CYCLE, not just the waiting phase. The visible state
-- oscillates Reconnecting -> Connecting -> (closed) -> Reconnecting on every failed dial,
-- so keying "should I retry?" off the state alone gives up after exactly one attempt.
local reconnecting = false

local function setState(s)
    if net.state == s then return end
    net.state = s
    mp._setState(s)
    mp.testSet('state', s)
    net.onStateChanged(s)
end

local function nowMs()
    return math.floor(core.getRealTime() * 1000)
end

local function send(msg)
    mp.sendJson(json.encode(msg))
    lastSendTime = core.getRealTime()
end

-- Session-tier sends initiated OUTSIDE this file (character create, profile setup — UI
-- flows that global.lua relays). Only meaningful once authed; silently dropped otherwise
-- so a stray click during a reconnect cannot corrupt the auth handshake.
function net.sendSession(msg)
    if net.state ~= 'Joined' and net.state ~= 'ProfileNeeded' then return false end
    send(msg)
    return true
end

local function buildManifest()
    -- core.contentFiles.list (mwlua/corebindings.cpp initContentFilesBindings) exposes NAMES
    -- only — file sizes are not reachable from Lua, so M0 sends size=0 and the server's
    -- `names` content policy must compare name+order only.
    local manifest = {}
    for i, name in ipairs(core.contentFiles.list) do
        manifest[i] = { name = name, size = 0, idx = i - 1 }
    end
    return manifest
end

-- Schedule the next redial. Called only for connection LOSS, never for the auth ladder:
-- ladder retries are bounded (one attempt each) and deliberately immediate.
local function scheduleReconnect()
    reconnecting = true
    mp.testSet('reconnecting', 'true')
    reconnectAttempt = reconnectAttempt + 1
    reconnectTotal = reconnectTotal + 1
    mp.testSet('reconnectTotal', string.format('%d', reconnectTotal))
    local ceiling = math.min(RECONNECT_CAP_SECONDS, RECONNECT_BASE_SECONDS * 2 ^ (reconnectAttempt - 1))
    local delay = math.random() * ceiling -- full jitter across [0, ceiling)
    reconnectAt = core.getRealTime() + delay
    net.nextRetrySeconds = delay
    mp.testSet('reconnectAttempt', string.format('%d', reconnectAttempt))
    mp.testSet('nextRetrySeconds', string.format('%.2f', delay))
    setState('Reconnecting')
    print(string.format('[mp] connection lost — reconnecting in %.1fs (attempt %d)', delay, reconnectAttempt))
end

function net.start()
    mirrorTarget()
    triedLogin = false
    triedResume = false
    triedTicket = false
    authMode = 'register'
    -- The FIRST dial gets the same still-booting grace a world switch gets: the launcher just
    -- asked the gateway to create-or-wake this world, and with cached game data the engine can
    -- reach the dial before the world process listens. A refused socket inside this window
    -- keeps retrying instead of dead-ending at UNREACHABLE.
    if switchDeadline == nil then switchDeadline = core.getRealTime() + 60 end
    -- M8: the ticket survives a PAGE RELOAD (mp.setResumeToken -> localStorage), which is
    -- the case §M8 is really about — a reloaded tab rejoins in place instead of re-authing.
    local token = mp.getResumeToken and mp.getResumeToken() or ''
    -- Character slots: an explicit switch must NEVER resume — resume pins the character
    -- the old session was playing, which is exactly the one we are leaving. Fall through
    -- to ticket/login, which carry the characterId selection.
    -- A resume token belongs to the world that issued it: it lives in THAT process's memory,
    -- so presenting it to the world we are switching to is always refused. Skipping it here
    -- keeps the switch on the ticket it was given, instead of spending an attempt to learn
    -- what we already know.
    if desiredCharId == nil and not switching
        and type(token) == 'string' and token ~= '' then
        authMode = 'resume'
        net.resumeToken = token
    end
    -- An SSO ticket outranks the password ladder but NOT a parked resume ticket: resuming
    -- rejoins in place and costs the server nothing, whereas redeeming burns the one-use
    -- ticket. Both are tried before falling back to register/login.
    -- A travel ticket minted for THIS hop outranks the boot-time env ticket, which is
    -- single-use and was spent on the first join. Re-reading the env here would overwrite
    -- the fresh credential with the dead one and refuse every world switch.
    local ticket = net.loginTicket
    if not ticket or ticket == '' then
        ticket = mp.getLoginTicket and mp.getLoginTicket() or ''
    end
    if authMode ~= 'resume' and type(ticket) == 'string' and ticket ~= '' then
        authMode = 'ticket'
        net.loginTicket = ticket
    end
    net.lastError = nil
    net.lastErrorDetail = nil
    if mp.connect(targetUrl()) then
        setState('Connecting')
    else
        net.lastError = 'connect failed'
        setState('Failed')
    end
end

-- F3: move this session to another world. Deliberately resets the reconnect backoff and the
-- auth ladder: arriving at a new world is a fresh connection attempt, and carrying an
-- exponential delay (or a spent resume token) over from the old one would make the first
-- join look broken.
-- CHANGING WORLD RELOADS THE ENGINE. It does not redial.
--
-- A socket redial reuses the running engine, and the Morrowind world in memory is never
-- reloaded — so everything the previous world put into it stays: objects on the ground,
-- journal entries, mwscript globals, faction rank, crime level, revealed map, disabled refs,
-- custom records, puppet scripts with AI still switched off. Each reset() below clears its
-- OWN bookkeeping and undoes none of that, and the client has no complete list of what to
-- undo — an item dropped in one world was then re-reported to the next as a fresh drop and
-- written into its database for real.
--
-- So the page reboots into the destination instead, exactly the way the launcher boots a
-- world in the first place. Nothing survives a reload, so no list has to be complete. The
-- cost is a real load, which is honest: you ARE going somewhere else.
--
-- Reconnects are untouched — those go through dialNow and are a socket event, not a world
-- change.
function net.switchTo(url)
    mp.testSet('publicStage', 'switchTo:' .. tostring(url))
    if type(url) ~= 'string' or url == '' then return false end
    -- The page owns navigation; Lua cannot reload itself. It mints a fresh login ticket and
    -- rebuilds the boot fragment for `url`.
    mp.testSet('switchTo', url)
    return true
end

function net.dialNow(url)
    if type(url) ~= 'string' or url == '' then return false end
    switching = true
    currentUrl = url
    mirrorTarget()
    reconnectAttempt = 0
    reconnectAt = nil
    reconnecting = false
    -- Party travel / world join: the destination is often STILL BOOTING when we dial (the
    -- gateway answers create before the world process listens). A refused socket inside
    -- this window must keep retrying rather than dead-ending at Failed — that is the
    -- normal arrival experience, not an error.
    switchDeadline = core.getRealTime() + 60
    -- We are about to hang up on purpose; the close this causes is not a loss.
    closingForSwitch = true
    mp.disconnect()
    net.start()
    return true
end

function net.onOpen()
    send({
        t = 'SessionHello',
        proto = 1,
        engineHash = mp.getEngineHash(),
        lserVersion = 0,
        manifest = buildManifest(),
        -- Phase H: a headless simulation peer (OPENMW_MP_SYSTEM=1) is infrastructure, not a
        -- participant, so it asks the server to keep it out of the player list, the count,
        -- and maxPlayers. mp.isSystem() is false for every normal client.
        system = mp.isSystem(),
        -- We run a real engine, so we can hold cell actor authority. The server refuses to
        -- hand a cell to anything that does not claim this: authority is otherwise elected
        -- on network fitness, and a protocol-only client (a bot, a load tool) is a
        -- near-perfect RTT candidate that simulates nothing, freezing every NPC in the cell
        -- for everyone in it.
        simulatesActors = true,
    })
    setState('HelloSent')
end

function net.onClose()
    -- Our own hang-up, one line above in dialNow. Say nothing and schedule nothing: net.start()
    -- is already dialling the new world and will drive the state from here. Consumed on use, so
    -- only THIS close is excused.
    if closingForSwitch then
        closingForSwitch = false
        return
    end
    -- PROTOCOL.md has no in-band "account already exists" reply: a failed SessionRegister is a
    -- SessionDisconnect(AUTH_FAILED) + close. Implement register-then-login-on-exists as one
    -- reconnect with SessionLoginRequest instead.
    -- SSO ONLY: a login ticket is the only credential a real user has. If it fails (spent or
    -- expired), we do NOT fall back to a password login — password auth for users is disabled
    -- as an attack surface, and the SSO server refuses it anyway. Let it fall through to the
    -- Failed state, which surfaces "sign in again" and stops. No password ladder for SSO.
    if net.lastError == 'AUTH_FAILED' and authMode == 'resume' and not triedResume then
        -- Expired/unknown resume token: forget it. A parked resume token outranks a fresh SSO
        -- ticket on the happy path (it rejoins in place for free), but when it FAILS we must
        -- fall back to the ticket — the user's real credential — NOT to the password ladder.
        -- Otherwise a stale token in localStorage dead-ends every SSO login at "wrong server
        -- password" (the password path is disabled for users anyway). Only if there is no
        -- ticket do we drop to register/login.
        triedResume = true
        net.resumeToken = nil
        if mp.setResumeToken then mp.setResumeToken('') end
        net.lastError = nil
        -- The TRAVEL ticket (minted for this hop by the world we just left) outranks the
        -- boot-time env ticket, which is single-use and was spent on the first join. Reading
        -- the env here is what made every world switch fail: resume was refused by a world
        -- that had never seen us, and the fallback then presented the dead credential.
        local ticket = net.loginTicket
        if not ticket or ticket == '' then
            ticket = mp.getLoginTicket and mp.getLoginTicket() or ''
        end
        if type(ticket) == 'string' and ticket ~= '' then
            authMode = 'ticket'
            net.loginTicket = ticket
        else
            authMode = 'register'
        end
        if mp.connect(targetUrl()) then
            setState('Connecting')
            return
        end
    end
    if net.lastError == 'AUTH_FAILED' and authMode == 'register' and not triedLogin then
        triedLogin = true
        authMode = 'login'
        net.lastError = nil
        if mp.connect(targetUrl()) then
            setState('Connecting')
            return
        end
    end
    -- Connection LOST after we were in the world (server restart, wifi hop, CF recycling a
    -- long-lived socket). Previously this dead-ended at "reload the page to retry"; now we
    -- redial ourselves, and because the resume ticket is still parked the rejoin is in place
    -- (M8) — a blip should be invisible rather than a re-login.
    -- ...but NOT for a terminal credential failure. AUTH_FAILED means the credential is
    -- wrong, and no amount of redialling makes a wrong credential right. `reconnecting`
    -- latches after ANY earlier redial (a rate-limit blip is enough), and once latched this
    -- branch swallowed every later AUTH_FAILED — so a wrong password retried silently and
    -- forever instead of saying "sign in again". The auth ladder above has already tried the
    -- alternatives by the time we get here.
    if net.lastError == 'AUTH_FAILED' then
        net.lastErrorDetail = net.lastErrorDetail or 'sign in again'
        mp.testSet('lastError', tostring(net.lastError) .. ' ' .. tostring(net.lastErrorDetail))
        setState('Failed')
        return
    end
    if not everJoined and reconnectAttempt >= UNREACHABLE_ATTEMPTS then
        net.lastError = net.lastError or 'UNREACHABLE'
        net.lastErrorDetail = net.lastErrorDetail or 'could not reach the server'
        mp.testSet('lastError', tostring(net.lastError) .. ' ' .. tostring(net.lastErrorDetail))
        setState('Failed')
        return
    end
    if net.state == 'Joined' or reconnecting then
        if net.resumeToken or (mp.getResumeToken and mp.getResumeToken() ~= '') then
            authMode = 'resume'
            triedResume = false
            net.resumeToken = net.resumeToken or mp.getResumeToken()
        else
            authMode = 'login' -- we had an account; register would just answer AUTH_FAILED
            triedLogin = true
        end
        net.lastError = nil
        scheduleReconnect()
        return
    end
    if net.state ~= 'Failed' then
        if net.state == 'Offline' then
            -- Clean close after joining (server restart, network drop): global.lua turns
            -- this into a "connection lost" notice via its wasJoined flag.
            setState('Offline')
        elseif switchDeadline and core.getRealTime() < switchDeadline then
            -- Mid-switch and the destination is not answering yet — it is booting. Keep
            -- dialling on the normal backoff until the deadline; only then is it a failure.
            scheduleReconnect()
            return
        else
            -- Closed before ever joining (server down/unreachable, refused upgrade):
            -- a real player must see a failure, not silence.
            net.lastError = net.lastError or 'UNREACHABLE'
            net.lastErrorDetail = net.lastErrorDetail or 'could not reach the server'
            mp.testSet('lastError', tostring(net.lastError) .. ' ' .. tostring(net.lastErrorDetail))
            setState('Failed')
        end
    end
end

local dispatch = {}

dispatch.SessionHelloOk = function(msg)
    net.serverName = msg.serverName
    mp.testSet('serverName', tostring(msg.serverName or ''))
    -- §M8: SessionResume is sent in HELLO_OK — AFTER SessionHello — so engine and content
    -- policy are enforced for a resume exactly as for a login.
    local auth
    if authMode == 'resume' then
        auth = { t = 'SessionResume', token = net.resumeToken }
    elseif authMode == 'ticket' then
        -- Phase B SSO. The ticket is single-use and ~60s-lived, so it is redeemed on this
        -- page load or not at all; onClose drops us to the password ladder rather than
        -- retrying a ticket that can no longer work.
        auth = { t = 'SessionLoginTicket', ticket = net.loginTicket }
    else
        auth = {
            t = (authMode == 'register') and 'SessionRegister' or 'SessionLoginRequest',
            account = mp.getName(),
            password = mp.getPassword(),
        }
    end
    -- THE SIM PEER'S SHARED SECRET. The server gates a SYSTEM peer on msg.serverPassword —
    -- a field distinct from the user password above — and this client never sent it, so the
    -- check compared '' against the configured secret and refused every peer with "wrong
    -- server password". The peer booted, loaded the world, failed auth and sat there: server
    -- authoritative NPC simulation was never actually running. Only a system peer sends this;
    -- a real user has no server password and is never checked against one.
    if mp.isSystem() then
        auth.serverPassword = mp.getPassword()
    end
    -- Character slots: an explicit selection rides every auth rung except resume (resume
    -- pins the character server-side; overriding it would swap personas mid-reconnect).
    -- Re-read the boot character HERE, not only at module load. The auth arrived at the
    -- server without a characterId while the fragment plainly carried one, so the world fell
    -- back to minting its own character and the wrong-world guard refused it. Whether the
    -- module-load env read raced or the state was lost, the fix is the same: ask again at the
    -- moment the answer matters.
    -- LOCAL, and that is the whole point. This used to assign to desiredCharId itself, which
    -- is module state the resume decision reads ("nil = nothing explicit was chosen, so a
    -- parked resume token may be used"). Setting it here left it non-nil forever after the
    -- first auth, so every later reconnect SKIPPED resume, fell through to a login ticket
    -- already spent at Welcome, and was refused — the endless "connection lost, reconnecting"
    -- on a connection the server still held open. An explicit switch (net.setCharacter) must
    -- still block resume; a passive fallback must only label the message being built.
    local charForAuth = desiredCharId
    if charForAuth == nil then
        -- The SESSION's confirmed character outranks the boot fragment: the fragment names
        -- the character the PAGE was opened with, which is wrong once the session has
        -- switched slots.
        if type(net.characterId) == 'string' and net.characterId ~= '' then
            charForAuth = net.characterId
        elseif mp.getBootCharacter then
            local boot = mp.getBootCharacter()
            if type(boot) == 'string' and boot ~= '' then charForAuth = boot end
        end
    end
    if charForAuth and auth.t ~= 'SessionResume' then
        auth.characterId = charForAuth
    end
    send(auth)
    mp.testSet('authMode', authMode)
    setState('Authing')
end

dispatch.SessionWelcome = function(msg)
    net.playerId = msg.playerId
    net.sessionToken = msg.sessionToken
    -- Tokens are single use: a resumed session gets a fresh one, so always overwrite.
    if mp.setResumeToken and type(msg.sessionToken) == 'string' then
        mp.setResumeToken(msg.sessionToken)
    end
    net.authPath = authMode
    mp.testSet('authPath', authMode)
    net.motd = msg.motd
    -- M2: non-null playerRecord = stored snapshot to restore (json.null when fresh).
    net.playerRecord = (type(msg.playerRecord) == 'table' and msg.playerRecord ~= json.null)
        and msg.playerRecord or nil
    -- M5: server rules the client must honour locally (PvP gating, difficulty display).
    net.flags = (type(msg.flags) == 'table' and msg.flags ~= json.null) and msg.flags or {}
    mp.testSet('pvp', tostring(net.flags.pvp == true))
    mp.testSet('playerId', tostring(msg.playerId))
    -- Character slots + onboarding profile: the account's slot list, which one this
    -- session plays, and whether the server demands a completed profile before Ready.
    switchDeadline = nil -- arrived: a later drop is a normal reconnect, not a boot wait
    switching = false    -- arrived: a later drop IS a normal reconnect, so resume applies again
    -- The ticket that got us in is now SPENT. Holding it would make the next reconnect retry
    -- a dead credential; a plain reconnect resumes, and a world switch mints a fresh one.
    net.loginTicket = nil
    net.characters = (type(msg.characters) == 'table' and msg.characters ~= json.null) and msg.characters or {}
    net.characterId = tostring(msg.characterId or '')
    net.profile = (type(msg.profile) == 'table' and msg.profile ~= json.null) and msg.profile or {}
    desiredCharId = nil -- confirmed (or refused before we got here); default is right now
    if net.onCharacters then net.onCharacters() end
    mp.testSet('characterId', net.characterId)
    mp.testSet('characterCount', tostring(#net.characters))
    mp.testSet('characters', json.encode(net.characters))
    mp.testSet('profileRequired', tostring(net.profile.required == true))
    -- SSO already captured the email; the picker only has to ask for a handle, and it needs
    -- the address to send back with it (ProfileSetup takes both).
    mp.testSet('profileEmail', tostring(net.profile.email or ''))
    mp.testSet('profileUsername', tostring(net.profile.username or ''))
    -- Back in the world: forget the backoff so the NEXT outage starts from 1s again rather
    -- than inheriting a 30s ceiling from an earlier bad patch.
    reconnectAttempt = 0
    reconnectAt = nil
    reconnecting = false
    mp.testSet('reconnectAttempt', '0')
    mp.testSet('reconnecting', 'false')
    if net.profile.required == true then
        -- The server will refuse Ready until email + username are set. Hold here; the
        -- profile UI submits ProfileSetup and the ok reply below sends Ready for us.
        setState('ProfileNeeded')
        if net.onProfileNeeded then net.onProfileNeeded() end
        return
    end
    send({ t = 'SessionReady' })
    everJoined = true
    setState('Joined')
end

-- Onboarding: answer to ProfileSetup. On success while we were holding at ProfileNeeded,
-- complete the join. Failures surface to the UI via the callback.
local profileSeq = 0
dispatch.ProfileResult = function(msg)
    net.profileResult = msg
    mp.testSet('profileOk', tostring(msg.ok == true))
    mp.testSet('profileError', tostring(msg.error or ''))
    profileSeq = profileSeq + 1
    mp.testSet('profileSeq', tostring(profileSeq))
    if net.onProfileResult then net.onProfileResult(msg) end
    if msg.ok == true and net.state == 'ProfileNeeded' then
        net.profile.required = false
        send({ t = 'SessionReady' })
        setState('Joined')
    end
end

-- Character slots: answer to CharacterCreate — carries the refreshed slot list.
dispatch.CharacterResult = function(msg)
    if type(msg.characters) == 'table' and msg.characters ~= json.null then
        net.characters = msg.characters
        mp.testSet('characterCount', tostring(#net.characters))
        mp.testSet('characters', json.encode(net.characters))
    end
    mp.testSet('charCreateOk', tostring(msg.ok == true))
    if net.onCharacters then net.onCharacters(msg) end
end

dispatch.SessionPong = function(msg)
    net.rttMs = nowMs() - msg.clientTime
    mp.testSet('rttMs', tostring(net.rttMs))
end

dispatch.SessionDisconnect = function(msg)
    net.lastError = msg.code
    net.lastErrorDetail = msg.detail
    print('[mp] server disconnect: ' .. tostring(msg.code) .. ' (' .. tostring(msg.detail) .. ')')
    mp.testSet('lastError', tostring(msg.code) .. ' ' .. tostring(msg.detail or ''))
    if msg.code ~= 'AUTH_FAILED' then
        setState('Failed')
    end
end

function net.onJson(str)
    local ok, msg = pcall(json.decode, str)
    if not ok or type(msg) ~= 'table' or type(msg.t) ~= 'string' then
        print('[mp] bad session frame: ' .. tostring(msg))
        return
    end
    local handler = dispatch[msg.t]
    if handler then
        handler(msg)
    else
        print('[mp] unhandled session message: ' .. msg.t)
    end
end

function net.tick()
    -- NOT gated on Joined any more: the reconnect scheduler has to run precisely when we are
    -- NOT connected. Real time throughout — onUpdate dt pauses with the world, and a paused
    -- tab must still redial.
    local now = core.getRealTime()
    if reconnectAt and now >= reconnectAt then
        reconnectAt = nil
        if mp.connect(targetUrl()) then
            setState('Connecting')
        else
            scheduleReconnect() -- dial refused outright; back off and try again
        end
        return
    end
    if net.state ~= 'Joined' then return end
    if now - lastSendTime >= PING_IDLE_SECONDS then
        send({ t = 'SessionPing', clientTime = nowMs() })
    end
end

return net
