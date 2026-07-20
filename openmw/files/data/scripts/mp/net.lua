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
    serverName = nil,
    motd = nil,
    sessionToken = nil,
    rttMs = nil,
    lastError = nil,
    -- global.lua fills these in before start():
    onStateChanged = function() end,
}

local authMode = 'register' -- register-then-login-on-exists (PROTOCOL.md session flow)
local triedLogin = false
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
    authMode = 'register'
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
    local auth = {
        t = (authMode == 'register') and 'SessionRegister' or 'SessionLoginRequest',
        account = mp.getName(),
        password = mp.getPassword(),
    }
    send(auth)
    setState('Authing')
end

dispatch.SessionWelcome = function(msg)
    net.playerId = msg.playerId
    net.sessionToken = msg.sessionToken
    net.motd = msg.motd
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
