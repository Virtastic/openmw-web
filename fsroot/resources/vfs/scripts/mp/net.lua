-- omw-mp/1 session driver (M0) — see server/PROTOCOL.md. Required by scripts/mp/global.lua,
-- which forwards the MP_Transport*/MP_SessionJson global events here. This module owns the
-- session state machine; the C++ NetManager only tracks connection state + what we tell it.
local core = require('openmw.core')
local mp = require('openmw.mp')

local json = require('scripts.mp.json')

local PING_IDLE_SECONDS = 30

local net = {
    state = 'Offline', -- Offline|Connecting|HelloSent|Authing|Joined|Failed
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
local lastSendTime = 0 -- real time; onUpdate dt pauses with the world, pings must not

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

function net.start()
    triedLogin = false
    triedResume = false
    authMode = 'register'
    -- M8: the ticket survives a PAGE RELOAD (mp.setResumeToken -> localStorage), which is
    -- the case §M8 is really about — a reloaded tab rejoins in place instead of re-authing.
    local token = mp.getResumeToken and mp.getResumeToken() or ''
    if type(token) == 'string' and token ~= '' then
        authMode = 'resume'
        net.resumeToken = token
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
    })
    setState('HelloSent')
end

function net.onClose()
    -- PROTOCOL.md has no in-band "account already exists" reply: a failed SessionRegister is a
    -- SessionDisconnect(AUTH_FAILED) + close. Implement register-then-login-on-exists as one
    -- reconnect with SessionLoginRequest instead.
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
    if net.state ~= 'Failed' then
        if net.state == 'Joined' or net.state == 'Offline' then
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
    if net.state ~= 'Joined' then return end
    if core.getRealTime() - lastSendTime >= PING_IDLE_SECONDS then
        send({ t = 'SessionPing', clientTime = nowMs() })
    end
end

return net
