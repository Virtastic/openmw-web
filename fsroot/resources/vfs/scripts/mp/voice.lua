-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- Phase 2.5 party voice, Lua side.
--
-- The audio itself never touches Lua or the server: getUserMedia and RTCPeerConnection are
-- browser APIs, so the WebRTC mesh lives in play/index.html (window.__omwVoice) and this
-- module is the courier between it and the session. What travels the wire is only
-- signalling — offer/answer/ICE — relayed by the server between PARTY MEMBERS, which is
-- also the access control: you cannot be offered a connection by a stranger.
--
-- The two directions use different transports because that is what the engine already
-- exposes, and both are SEQUENCED rather than single-slot: ICE candidates arrive in
-- bursts, and an overwritten one leaves a half-negotiated peer that presents as "voice
-- just doesn't work".
--   Lua -> JS   mp.testSet('voiceSig<N>', json) + 'voiceSeq'
--   JS  -> Lua  Module.__omwMPCmd = 'voice:<acct>:<kind>:<payload>' (player.lua parses)

local mp = require('openmw.mp')
local json = require('scripts.mp.json')

local voice = {}

local seq = 0
local enabled = false
local members = {} -- acct -> true, the party as we last heard it
local myAcct = nil

local function toJs(msg)
    seq = seq + 1
    mp.testSet('voiceSig' .. tostring(seq), json.encode(msg))
    mp.testSet('voiceSeq', tostring(seq))
end

-- Who offers? The alphabetically-lower account key. Both sides run the same rule, so
-- exactly one offer is made per pair — otherwise two simultaneous offers collide (SDP
-- "glare") and the connection never completes.
local function shouldOffer(otherAcct)
    return myAcct ~= nil and myAcct < otherAcct
end

function voice.setSelf(acct)
    myAcct = acct
end

function voice.isEnabled()
    return enabled
end

-- Turning voice on is deliberately an explicit act: the browser's microphone prompt is
-- the consent step, and a voice channel that goes hot the moment you join a party is how
-- someone's room ends up broadcast to people they just met.
function voice.enable()
    enabled = true
    toJs({ op = 'enable' })
    for acct in pairs(members) do
        if shouldOffer(acct) then toJs({ op = 'offer', acct = acct }) end
    end
end

function voice.disable()
    enabled = false
    toJs({ op = 'dropAll' })
end

function voice.setTalking(on)
    if enabled then toJs({ op = 'talk', on = on and true or false }) end
end

-- The party roster changed: connect to anyone new, drop anyone gone. Called from the
-- social window's PartyUpdate handler, so voice membership can never drift from the
-- party the player can actually see.
function voice.syncParty(partyMembers)
    local now = {}
    for _, m in ipairs(partyMembers or {}) do
        if m.acct and m.acct ~= myAcct then now[m.acct] = true end
    end
    for acct in pairs(now) do
        if not members[acct] and enabled and shouldOffer(acct) then
            toJs({ op = 'offer', acct = acct })
        end
    end
    for acct in pairs(members) do
        if not now[acct] then toJs({ op = 'drop', acct = acct }) end
    end
    members = now
end

-- A signal arrived from another member (relayed by the server).
function voice.onSignal(fromAcct, kind, payload)
    if not enabled then return end -- we never offered and cannot answer without a mic
    toJs({ op = 'signal', acct = fromAcct, kind = kind, payload = payload })
end

function voice.reset()
    seq = seq + 1
    enabled = false
    members = {}
    toJs({ op = 'dropAll' })
end

return voice
