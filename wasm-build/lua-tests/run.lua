-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- Logic tests for the mp/ CLIENT scripts. Run with:
--   docker run --rm -v "$PWD:/repo" alpine:3 sh -c \
--     'apk add --no-cache lua5.1 >/dev/null && cd /repo && lua5.1 wasm-build/lua-tests/run.lua'
package.path = './openmw/files/data/?.lua;./wasm-build/lua-tests/?.lua;' .. package.path

local stubs = require('stubs')
local pass, fail = 0, 0
local function check(name, ok, detail)
  if ok then pass = pass + 1; print('  ok   ' .. name)
  else fail = fail + 1; print('  FAIL ' .. name .. (detail and ('  -- ' .. detail) or '')) end
end
local function fresh()
  for _, m in ipairs({ 'scripts.mp.net', 'scripts.mp.identity', 'scripts.mp.json' }) do
    package.loaded[m] = nil
  end
end

-- ============================================================ net.lua: disconnect codes
-- A RESTART IS NOT A FAILURE. SHUTDOWN used to set the terminal Failed state, so every deploy
-- ejected every player into a modal they could only escape by reloading — and rolling restart,
-- built to prevent exactly that, could only have staggered the ejections.
print('net.lua — SessionDisconnect handling')
local function disconnectLeaves(code)
  fresh()
  local env = stubs.install({})
  local net = require('scripts.mp.net')
  local json = require('scripts.mp.json')
  net.onJson(json.encode({ t = 'SessionDisconnect', code = code, detail = 'test' }))
  return net.state, env
end

local st = disconnectLeaves('SHUTDOWN')
check('SHUTDOWN does not become the terminal Failed state', st ~= 'Failed', 'state=' .. tostring(st))
st = disconnectLeaves('SERVER_FULL')
check('SERVER_FULL is transient too', st ~= 'Failed', 'state=' .. tostring(st))

-- ...and the verdicts stay terminal. An auto-retry on these re-litigates a moderator's decision,
-- fights another live session, or hammers the server that just shed the client for flooding.
for _, code in ipairs({ 'BANNED', 'KICKED', 'SUPERSEDED', 'RATE', 'BAD_ENGINE', 'BAD_CONTENT' }) do
  st = disconnectLeaves(code)
  check(code .. ' stays terminal', st == 'Failed', 'state=' .. tostring(st))
end

-- The flag the page reads to say "the server is restarting" rather than "connection lost".
fresh()
local env = stubs.install({})
local net = require('scripts.mp.net')
local json = require('scripts.mp.json')
net.onJson(json.encode({ t = 'SessionDisconnect', code = 'SHUTDOWN', detail = 'server shutting down' }))
check('SHUTDOWN publishes serverRestarting for the page', env.calls.testSet['serverRestarting'] == '1')

-- ============================================================ identity.lua: acquisition report
-- Closes the race that made drop conservation unenforceable: the inventory snapshot is a 2 s
-- diff, so pick-up-then-drop outruns the player's own declaration.
print('identity.lua — PlayerItemAcquired')
local function acquiredEvents(calls)
  local out = {}
  for _, c in ipairs(calls.events) do
    if c.name == 'PlayerItemAcquired' then out[#out + 1] = c.body end
  end
  return out
end

fresh()
env = stubs.install({})
local identity = require('scripts.mp.identity')
env.setInventory({ { recordId = 'iron_dagger', count = 1 } })
identity.tick(0)   -- first pass SEEDS the baseline
check('the first scan reports nothing', #acquiredEvents(env.calls) == 0,
  'reporting an existing inventory as freshly acquired would credit it twice')

env.setInventory({ { recordId = 'iron_dagger', count = 1 }, { recordId = 'gold_001', count = 25 } })
identity.tick(1.0) -- past ACQUIRE_INTERVAL
local got = acquiredEvents(env.calls)
check('a gain is reported', #got == 1 and got[1].id == 'gold_001' and got[1].n == 25,
  '#got=' .. #got)

-- Only increases. A decrease is a drop, a sale or a use, and the server learns those from the
-- snapshot — reporting them here would credit the player for losing things.
env.setInventory({ { recordId = 'iron_dagger', count = 1 } })
identity.tick(2.0)
check('a loss is not reported as an acquisition', #acquiredEvents(env.calls) == 1,
  '#got=' .. #acquiredEvents(env.calls))

-- A rejoin must re-seed, or the whole restored inventory reads as newly acquired.
identity.reset()
env.setInventory({ { recordId = 'ebony_shield', count = 1 } })
identity.tick(3.0)
check('reset re-seeds rather than reporting the restored inventory',
  #acquiredEvents(env.calls) == 1, '#got=' .. #acquiredEvents(env.calls))

-- ============================================================ social.lua: party rule toggles
-- MP_PartyUpdate rebuilt the client's party table from leader+members alone, dropping every
-- setting the server sent. goldSplit/rollOnRare were therefore ALWAYS nil: each button rendered
-- its default label whatever the party had chosen, and since the click handler derives the new
-- value from that same nil it could only ever send 'false'. One-way toggles with lying labels.
--
-- Asserted on the DATA rather than by driving MyGUI: the bug was the handler discarding fields,
-- so that is what to pin.
print('social.lua -- MP_PartyUpdate carries the party rules')
do
  local f = io.open('./openmw/files/data/scripts/mp/social.lua')
  local src = f:read('*a'); f:close()
  local handler = src:match('MP_PartyUpdate = function%(data%)(.-)mirror%(%)')
  check('the handler was found', handler ~= nil)
  for _, field in ipairs({ 'goldSplit', 'rollOnRare', 'scaling' }) do
    local carried = handler ~= nil and handler:find(field .. '%s*=%s*data%.' .. field) ~= nil
    check('MP_PartyUpdate carries ' .. field, carried,
      'dropped -> that button shows a default label and can only ever send false')
  end
end

-- ==================================================== social.lua: refusal text for the player
-- SocialResult carries a WIRE CODE. It was rendered straight into the UI, so a refused invite
-- said "PartyInvite: already_in_party" and an accepted one said "PartyInvite: ok".
--
-- These tables are pure Lua with no engine dependency, so unlike the rest of social.lua they can
-- be lifted out and actually EXECUTED rather than pattern-matched.
print('social.lua -- SocialResult is rendered in English')
do
  local f = io.open('./openmw/files/data/scripts/mp/social.lua')
  local src = f:read('*a'); f:close()
  local chunk = src:match('(local SOCIAL_FAIL = .-\nend\n)')
  check('the message tables were found', chunk ~= nil)
  local socialText
  if chunk then
    socialText = assert((loadstring or load)(chunk .. '\nreturn socialText'))()
  end
  check('socialText loaded', type(socialText) == 'function')
  if type(socialText) == 'function' then
    -- No raw wire code reaches the player for any documented failure.
    for _, code in ipairs({ 'no_such_player', 'blocked', 'already_friends', 'self',
                            'too_many_requests', 'no_request', 'not_online', 'private',
                            'not_in_party', 'not_leader', 'party_full', 'already_in_party' }) do
      local t = socialText('PartyAccept', false, code)
      check('"' .. code .. '" reads as a sentence', not t:find(code, 1, true), t)
    end
    -- The one code that means a different PERSON depending on which way the action pointed.
    check('already_in_party on an INVITE is about them',
      socialText('PartyInvite', false, 'already_in_party') == 'They are already in a party.',
      socialText('PartyInvite', false, 'already_in_party'))
    check('already_in_party on an ACCEPT is about you',
      socialText('PartyAccept', false, 'already_in_party') == 'You are already in a party.',
      socialText('PartyAccept', false, 'already_in_party'))
    -- Success is a sentence too. The old one was "PartyInvite: ok".
    check('a sent invite says so', socialText('PartyInvite', true, 'ok') == 'Invitation sent.',
      socialText('PartyInvite', true, 'ok'))
    -- A friend request that crosses one already waiting completes on the spot.
    check('a crossed friend request says you are friends',
      socialText('FriendRequest', true, 'accepted') == 'You are now friends.',
      socialText('FriendRequest', true, 'accepted'))
    check('an ordinary friend request says it was sent',
      socialText('FriendRequest', true, 'sent') == 'Friend request sent.',
      socialText('FriendRequest', true, 'sent'))
    -- An unknown future code must still return text rather than nil-crashing the handler.
    check('an unknown code still returns text', type(socialText('X', false, 'nope')) == 'string')
  end
  -- The tables existing proves nothing if the handler still formats its own string. Pin the
  -- WIRING as well as the text, or this whole section can pass over dead code.
  local handler = src:match('MP_SocialResult = function%(data%)(.-)mp%.testSet')
  check('MP_SocialResult calls socialText', handler ~= nil and handler:find('socialText(', 1, true) ~= nil,
    'the handler is still building its own message')
  check('VoiceSignal is not narrated at the player',
    handler ~= nil and handler:find('SOCIAL_SILENT', 1, true) ~= nil,
    'a dropped WebRTC offer would pop a message over the game')
end

-- ===================================================== combat.lua: a swing must not vanish
-- puppet.lua's onHit interceptor returns false and cancels the ENTIRE local damage chain
-- before this code runs. So anything that declines to forward here does not lose a message,
-- it loses the SWING: no damage, no miss, no sound. The player attacks and the game says
-- nothing at all.
--
-- This used to `return` whenever it had no epoch for the victim's cell — a condition the
-- server had already stopped caring about. server/src/core/combat.ts validates the epoch only
-- `if (target.epoch !== undefined)` and proves presence by proximity, and its own test
-- ("non-holder may omit epoch; proximity is the presence proof") pins that. The attacker is
-- USUALLY a non-holder, so this fired in ordinary play.
print('combat.lua -- an attack is always forwarded when it can be addressed')
do
  local env = stubs.install({})
  local combat = dofile('./openmw/files/data/scripts/mp/combat.lua')
  local cell, epoch = '0,0', nil
  combat.init({
    playerFn = function() return { id = 'me' } end,
    ownIdFn = function() return 1 end,
    puppetObjOf = function() return nil end,
    epochOf = function() return epoch end,
    isHolderOf = function() return false end,
    cellKeyOfObj = function() return cell end,
    isPvpEnabled = function() return true end,
  })
  local victim = { isValid = function() return true end }
  local function lastHit()
    for i = #env.calls.events, 1, -1 do
      if env.calls.events[i].name == 'CombatHit' then return env.calls.events[i].body end
    end
    return nil
  end

  -- The case that was silently dropped: a non-holder with no epoch yet.
  epoch = nil
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true })
  local sent = lastHit()
  check('a hit with no epoch is still sent', sent ~= nil,
    'the swing was swallowed -- no damage, no miss, nothing')
  if sent then
    check('it carries the cell so the server can route it', sent.target.cellKey == cell)
    check('and omits the epoch rather than inventing one', sent.target.epoch == nil,
      'quoting an epoch we never received is the one thing the server rejects')
  end

  -- When we DO have one it must travel: that is what stops a mid-handoff hit landing on the
  -- wrong simulator.
  epoch = 42
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true })
  local sent2 = lastHit()
  check('a known epoch is quoted', sent2 ~= nil and sent2.target.epoch == 42,
    tostring(sent2 and sent2.target.epoch))

  -- A miss is a real outcome and must reach the victim too, or it plays on nobody.
  epoch = nil
  local before = #env.calls.events
  combat.onPuppetHit({ victim = victim, damage = {}, successful = false })
  check('a MISS is forwarded as well as a hit', #env.calls.events > before)
  check('and is not silently promoted to a hit', lastHit().successful == false)

  -- Genuinely unaddressable: no cell, nothing the server could route on.
  cell = nil
  local n = #env.calls.events
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true })
  check('a victim with no cell is still not sent', #env.calls.events == n)
end

-- ============================================ every server->client event reaches a handler
-- A server->client event with no `MP_<name>` handler is not an error anywhere: it arrives,
-- matches nothing, and is dropped in silence. The server half looks complete and tested while
-- the feature is simply dead. Two were found exactly this way, by diffing every `sendEvent` in
-- server/src against every handler in scripts/mp.
print('client -- server events that must not be dropped on the floor')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local s = io.open('./openmw/files/data/scripts/mp/social.lua'):read('*a')
  -- WorldTimeRefused: m7.ts refuses a Rest under [rules] timeSkip and says so on purpose --
  -- "a Rest that silently does nothing gets pressed again and then reported as a bug". The
  -- public world ships timeSkip = "off", so this is on the path of every visitor.
  check('global.lua forwards MP_WorldTimeRefused',
    g:find('MP_WorldTimeRefused', 1, true) ~= nil,
    'a refused Rest is silent again')
  check('social.lua tells the player why time did not pass',
    s:find('MP_WorldTimeRefused = function', 1, true) ~= nil)
  -- SocialNotice: kicked from a party, or the leader left and it disbanded.
  check('global.lua forwards MP_SocialNotice',
    g:find('MP_SocialNotice', 1, true) ~= nil,
    'a party can evaporate with nobody told why')
  check('social.lua tells the player about it',
    s:find('MP_SocialNotice = function', 1, true) ~= nil)
end

-- ================================== container refusals are explained, and stay explained
-- A refused container op UNDOES the optimistic local take, so the item disappears out of the
-- player's inventory a moment after they picked it up. Silence there reads as the game eating
-- your loot. `rolling` is the sharpest case: with party loot rolls on, grabbing a rare item is
-- REFUSED and a roll starts instead, so the most interesting thing the feature does looked
-- exactly like a bug.
--
-- The reason list is read out of the SERVER source rather than hardcoded here, so adding a
-- refusal reason server-side and forgetting the client fails this test instead of shipping.
print('objects.lua -- every container refusal the server can send is worded')
do
  local ts = io.open('./server/src/core/worldstate.ts'):read('*a')
  local lua = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  local handler = lua:match('MP_ContainerOpResult = function%(data%)(.-)\nend')
  check('the client handler was found', handler ~= nil)
  local reasons, seen = {}, {}
  for r in ts:gmatch("reply%(false,%s*'([a-z_]+)'") do
    if not seen[r] then seen[r] = true; reasons[#reasons + 1] = r end
  end
  check('server refusal reasons were discovered', #reasons > 0, '#' .. #reasons)
  for _, r in ipairs(reasons) do
    -- Match the MAPPING ENTRY (`reason = '...'`), not the bare word. A plain substring search
    -- passes on any mention -- including the comment right above the table, which is how the
    -- first version of this test passed its own negative control.
    check('"' .. r .. '" is worded for the player',
      handler ~= nil and handler:find(r .. "%s*=%s*'") ~= nil,
      'the item vanishes from the inventory with nothing said')
  end
end

-- ================================ world.lua: the weather continuity handback is not an echo
-- A holder drops any WorldWeather for its own region, so it never applies its own echo back
-- onto itself. The server's CONTINUITY handback — the weather a region had before it went
-- dormant — is sent to the NEW HOLDER right after the grant, so that guard used to discard it
-- and the region kept whatever the client rolled at boot. Solo, that is a fresh roll every
-- session, which is the "weather is randomised on each load" report.
print('world.lua -- the weather handback survives the holder echo guard')
do
  local src = io.open('./openmw/files/data/scripts/mp/world.lua'):read('*a')
  local handler = src:match('handlers%.MP_WorldWeather = function%(data%)(.-)\nend')
  check('the handler was found', handler ~= nil)
  if handler then
    check('a holder still ignores its own echo',
      handler:find('isHolderOf(data.region)', 1, true) ~= nil)
    check('but honours the restore handback',
      handler:find('data.restore', 1, true) ~= nil,
      'the new holder discards the stored weather and re-rolls every session')
  end
end

print(string.format('\n%d passed, %d failed', pass, fail))
os.exit(fail == 0 and 0 or 1)
