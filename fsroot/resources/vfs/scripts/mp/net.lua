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
local reconnectAttempt = 0 -- reset on a successful Joined
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
    triedLogin = false
    triedResume = false
    triedTicket = false
    authMode = 'register'
    -- M8: the ticket survives a PAGE RELOAD (mp.setResumeToken -> localStorage), which is
    -- the case §M8 is really about — a reloaded tab rejoins in place instead of re-authing.
    local token = mp.getResumeToken and mp.getResumeToken() or ''
    if type(token) == 'string' and token ~= '' then
        authMode = 'resume'
        net.resumeToken = token
    end
    -- An SSO ticket outranks the password ladder but NOT a parked resume ticket: resuming
    -- rejoins in place and costs the server nothing, whereas redeeming burns the one-use
    -- ticket. Both are tried before falling back to register/login.
    local ticket = mp.getLoginTicket and mp.getLoginTicket() or ''
    if authMode ~= 'resume' and type(ticket) == 'string' and ticket ~= '' then
        authMode = 'ticket'
        net.loginTicket = ticket
    end
    net.lastError = nil
    net.lastErrorDetail = nil
    if mp.connect(mp.getUrl()) then
        setState('Connecting')
    else
        net.lastError = 'connect failed'
        setState('Failed')
    end
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
    -- PROTOCOL.md has no in-band "account already exists" reply: a failed SessionRegister is a
    -- SessionDisconnect(AUTH_FAILED) + close. Implement register-then-login-on-exists as one
    -- reconnect with SessionLoginRequest instead.
    -- An SSO ticket is single-use and short-lived, so AUTH_FAILED means it is spent or
    -- expired — never retry it. Drop to the password ladder, which is a no-op on a
    -- password-less SSO account (the server refuses cleanly) and correct for everyone else.
    if net.lastError == 'AUTH_FAILED' and authMode == 'ticket' and not triedTicket then
        triedTicket = true
        authMode = 'register'
        net.loginTicket = nil
        net.lastError = nil
        if mp.connect(mp.getUrl()) then
            setState('Connecting')
            return
        end
    end
    if net.lastError == 'AUTH_FAILED' and authMode == 'resume' and not triedResume then
        -- Expired/unknown ticket: forget it and fall back to the normal ladder.
        triedResume = true
        authMode = 'register'
        net.resumeToken = nil
        if mp.setResumeToken then mp.setResumeToken('') end
        net.lastError = nil
        if mp.connect(mp.getUrl()) then
            setState('Connecting')
            return
        end
    end
    if net.lastError == 'AUTH_FAILED' and authMode == 'register' and not triedLogin then
        triedLogin = true
        authMode = 'login'
        net.lastError = nil
        if mp.connect(mp.getUrl()) then
            setState('Connecting')
            return
        end
    end
    -- Connection LOST after we were in the world (server restart, wifi hop, CF recycling a
    -- long-lived socket). Previously this dead-ended at "reload the page to retry"; now we
    -- redial ourselves, and because the resume ticket is still parked the rejoin is in place
    -- (M8) — a blip should be invisible rather than a re-login.
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
    send({ t = 'SessionReady' })
    -- Back in the world: forget the backoff so the NEXT outage starts from 1s again rather
    -- than inheriting a 30s ceiling from an earlier bad patch.
    reconnectAttempt = 0
    reconnectAt = nil
    reconnecting = false
    mp.testSet('reconnectAttempt', '0')
    mp.testSet('reconnecting', 'false')
    setState('Joined')
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
        if mp.connect(mp.getUrl()) then
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
