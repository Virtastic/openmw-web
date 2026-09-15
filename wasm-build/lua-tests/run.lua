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

-- THE GATE IS SHUT UNTIL WE KNOW WHAT THIS CHARACTER IS. Before a restore has applied or
-- chargen has finished, the engine's player is the raw TEMPLATE -- every attribute 30, every
-- skill 5, hand-to-hand 100 -- and broadcasting that made the server store it OVER the real
-- character. It never healed: the next restore re-applied the template doc and the client
-- reported it straight back. Reported as a Nord Barbarian whose stats were a flat 30 on relog.
identity.tick(0)
identity.tick(1.0)
check('nothing persistent is broadcast before the baseline is known',
  #acquiredEvents(env.calls) == 0,
  'the template would be stored over the real character, permanently')

identity.markBaselineReady()   -- chargen finished (or the restore landed)
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

-- ------------------------------------------------------------ identity.lua: a heal sticks
-- While the peer reports our bars, a potion raises the local bar between two reports and the
-- next report puts it back; the 4 Hz diff seldom saw it. The per-frame gain is claimed on
-- top of the peer's last word instead.
print('identity.lua — client heal claimed over the peer report')
local function dynEvents(calls)
  local out = {}
  for _, c in ipairs(calls.events) do
    if c.name == 'PlayerStatsDynamic' then out[#out + 1] = c.body end
  end
  return out
end
fresh()
env = stubs.install({})
identity = require('scripts.mp.identity')
identity.markBaselineReady()
env.dyn.health.current = 60
identity.notePeerBars(60)      -- the peer says 60/100
identity.tick(0)               -- seeds: 60
local n0 = #dynEvents(env.calls)
env.dyn.health.current = 75    -- frame: the potion ticked (+15)
identity.tick(0.05)
identity.notePeerBars(60)      -- the peer's next report resets the bar...
env.dyn.health.current = 60
identity.tick(0.10)
env.dyn.health.current = 62    -- ...and the potion keeps ticking (+2)
identity.tick(0.30)            -- past the 0.25 s diff
local got = dynEvents(env.calls)
check('the heal is claimed as peer + local gain, not the reset bar',
  #got == n0 + 1 and got[#got].hp.c == 77, 'events=' .. #got .. ' hp=' .. tostring(got[#got] and got[#got].hp.c))
identity.notePeerBars(40)      -- the peer hurts us: a report LOWER than local
env.dyn.health.current = 40
identity.tick(0.60)
got = dynEvents(env.calls)
check('a peer-authored drop is neither re-claimed nor echoed', #got == n0 + 1, 'events=' .. #got)
identity.notePeerBars(nil, 50, nil) -- the peer says magicka 50/50
env.dyn.magicka.current = 50
identity.tick(0.90)
env.dyn.magicka.current = 30       -- frame: we cast (-20)
identity.tick(0.95)
identity.notePeerBars(nil, 50, nil) -- the avatar never cast: its report refills the bar
env.dyn.magicka.current = 50
identity.tick(1.20)
got = dynEvents(env.calls)
check('the cost of a cast survives the refill from the avatar', got[#got].mp.c == 30, 'mp=' .. tostring(got[#got].mp.c))
identity.notePeerBars(40, nil, nil)
env.dyn.health.current = 40
identity.tick(1.50)                -- settle: base said = 100
local n1 = #dynEvents(env.calls)
env.dyn.health.base = 110          -- level-up: the maximum rises, current does not
identity.tick(1.80)
got = dynEvents(env.calls)
check('a raised maximum is claimed even with no change in current', #got == n1 + 1 and got[#got].hp and got[#got].hp.b == 110,
  'events=' .. #got .. ' b=' .. tostring(got[#got] and got[#got].hp and got[#got].hp.b))

-- ==================================================== social.lua: refusal text for the player
-- SocialResult carries a WIRE CODE. It was rendered straight into the UI, so a refused op
-- said things like "InviteSend: blocked" and a successful one said "InviteSend: ok".
--
-- These tables are pure Lua with no engine dependency, so unlike the rest of social.lua they can
-- be lifted out and actually EXECUTED rather than pattern-matched.
print('social.lua -- SocialResult is rendered in English')
do
  local f = io.open('./openmw/files/data/scripts/mp/social.lua')
  local src = f:read('*a'):gsub('\r\n', '\n'); f:close() -- a Windows checkout (autocrlf) hands back CRLF
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
                            'too_many_requests', 'no_request', 'not_online', 'private' }) do
      local t = socialText('InviteAccept', false, code)
      check('"' .. code .. '" reads as a sentence', not t:find(code, 1, true), t)
    end
    -- Success is a sentence too. The old one was "InviteSend: ok".
    check('a sent invite says so', socialText('InviteSend', true, 'ok') == 'Invitation sent.',
      socialText('InviteSend', true, 'ok'))
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
  local handler = src:match('MP_SocialResult = function%(data%)(.-)mp%.set')
  check('MP_SocialResult calls socialText', handler ~= nil and handler:find('socialText(', 1, true) ~= nil,
    'the handler is still building its own message')
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
    ownCellKeyFn = function() return cell end,
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

  -- Phase 4C closed form: a REAL client swing is NEVER forwarded -- the peer's avatar
  -- resolves every melee natively. Only a TEST-hook swing (mpTest) rides the relay, which
  -- is what keeps s51/s58 as its regression guard. This also closes the mid-handoff double
  -- damage: there is no window where a real swing both forwards AND the avatar hits.
  epoch = nil
  local n0 = #env.calls.events
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true })
  check('a real swing is NOT forwarded (the peer avatar computes melee)',
    #env.calls.events == n0, 'a real client swing must be cancel-only in the one-peer model')

  -- The test hook still travels, and carries the cell so the server can route it. With no
  -- epoch yet it omits it rather than inventing one (the server proves presence by proximity).
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true, mpTest = true })
  local sent = lastHit()
  check('a test-hook swing (mpTest) is forwarded', sent ~= nil,
    'the relay must still carry mpTest hits for s51/s58')
  if sent then
    check('it carries the cell so the server can route it', sent.target.cellKey == cell)
    check('and omits the epoch rather than inventing one', sent.target.epoch == nil,
      'quoting an epoch we never received is the one thing the server rejects')
  end

  -- A known epoch travels on the test hook: that is what stops a mid-handoff hit landing on
  -- the wrong simulator.
  epoch = 42
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true, mpTest = true })
  local sent2 = lastHit()
  check('a known epoch is quoted', sent2 ~= nil and sent2.target.epoch == 42,
    tostring(sent2 and sent2.target.epoch))

  -- A test-hook MISS is a real outcome and must reach the victim too, or it plays on nobody.
  epoch = nil
  local before = #env.calls.events
  combat.onPuppetHit({ victim = victim, damage = {}, successful = false, mpTest = true })
  check('a test-hook MISS is forwarded as well as a hit', #env.calls.events > before)
  check('and is not silently promoted to a hit', lastHit().successful == false)

  -- Genuinely unaddressable even for a test hook: no cell, nothing the server could route on.
  cell = nil
  local n = #env.calls.events
  combat.onPuppetHit({ victim = victim, damage = { health = 7 }, successful = true, mpTest = true })
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
  -- "a Rest that silently does nothing gets pressed again and then reported as a bug".
  check('global.lua forwards MP_WorldTimeRefused',
    g:find('MP_WorldTimeRefused', 1, true) ~= nil,
    'a refused Rest is silent again')
  -- Backlog 213/214/216/218: the engine's script notes are drained once joined and reach
  -- the three consumers; the object's OWN cell key travels; a scripted teleport lands on
  -- the holder; a persisted re-enable is applied at cell entry.
  local ob = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  check('global.lua drains mp.takeScriptNotes inside the Joined tick',
    g:find("if net.state == 'Joined' then.-scriptNotesTick%(%)") ~= nil and g:find('pcall(mp.takeScriptNotes)', 1, true) ~= nil)
  check("objects.onScriptNote sends ObjectEnabled under the OBJECT's cell key",
    ob:find("sendAddressed('ObjectEnabled', obj, { enabled = on, cellKey = n.cellKey })", 1, true) ~= nil)
  check('objects.onScriptNote asks the server for a scripted actor spawn',
    ob:find("mp.sendEvent%('ObjectSpawnRequest', {%s*tempId = 0, actor = true") ~= nil)
  check('WorldCellState applies persisted re-enables', ob:find('for _, refKey in ipairs(data.enabled or {}) do', 1, true) ~= nil)
  check('actors.notePosition rides ActorAI and the holder teleports on it',
    ac:find('position = { cell = tostring(cellName or ', 1, true) ~= nil and ac:find("obj:teleport(tostring(p.cell or ''), util.vector3(p.x", 1, true) ~= nil)
  check('mpQuestSpawn places a forwarded PlaceAtPC at its spot',
    g:find("if type(data.x) == 'number' then", 1, true) ~= nil and g:find('world.getCellByName(key)', 1, true) ~= nil)
  -- EVERY SCRIPT MUST PARSE. A script with a syntax error is silently not attached by the
  -- engine ("Can't start ... avatar.lua: '}' expected"), and the body it belongs to just does
  -- nothing -- which read as a gameplay bug for an hour. The runner's Lua is 5.1 and the
  -- engine's 5.4, so this catches structure (a stray `end`), not every 5.4-only construct.
  for _, f in ipairs({ 'global', 'player', 'identity', 'world', 'actors', 'avatar', 'companion', 'puppet', 'combat', 'social', 'objects', 'net', 'admin', 'menu', 'quests', 'interp' }) do
    local fh = io.open('./openmw/files/data/scripts/mp/' .. f .. '.lua')
    if fh then
      local src = fh:read('*a'); fh:close()
      local fn, err = loadstring(src, f .. '.lua')
      check(f .. '.lua parses', fn ~= nil, tostring(err))
    end
  end
  -- The engine is Lua 5.4: math.atan2 / math.pow / unpack are gone there, and the runner's
  -- own Lua may still have them, so a script that passes here can still throw in the game.
  for _, f in ipairs({ 'global', 'player', 'identity', 'world', 'actors', 'avatar', 'companion', 'puppet', 'combat', 'social', 'objects', 'net' }) do
    local fh = io.open('./openmw/files/data/scripts/mp/' .. f .. '.lua')
    if fh then
      local src = fh:read('*a'); fh:close()
      check(f .. '.lua uses no Lua 5.1-only math/base functions (the engine is 5.4)',
        not src:find('math.atan2', 1, true) and not src:find('math.pow', 1, true)
        and not src:find('[^.]unpack%('))
    end
  end
  -- A dial refused by a world that is not ours must go HOME, not dead-end at "sign in again".
  local n = io.open('./openmw/files/data/scripts/mp/net.lua'):read('*a')
  check('net.lua hands an admission refusal to the go-home hook before the fresh-ticket ask',
    n:find("net.lastErrorDetail == 'this world is private' or net.lastErrorDetail == 'you were sent home') and net.onRefusedAway", 1, true) ~= nil
    and n:find('net.onRefusedAway', 1, true) < n:find("askPageForFreshTicket('credential refused", 1, true))
  check('global.lua wires net.onRefusedAway to the WorldClosed notice + switch home',
    g:find('net.onRefusedAway = function', 1, true) ~= nil and g:find("goHome({ reason = detail == 'you were sent home' and 'kicked' or 'not_open' })", 1, true) ~= nil)
  -- Self reconciliation must run ONCE PER FRAME against the newest sample, never per sample:
  -- a slow client receives the same pose many times between physics steps, and correcting on
  -- each one multiplied the gain into a runaway oscillation (300 units after one sword swing).
  local pl = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  check('player.lua reconciles the self pose in a per-frame tick, not in the MP_SelfState handler',
    pl:find('local function selfReconcileTick()', 1, true) ~= nil
    and pl:find('selfReconcileTick() -- Phase 3', 1, true) ~= nil
    and not pl:find('local function onSelfState%(e%).-mp%.correctSelf.-local function selfReconcileTick'))
  -- The baseline gate reopens on EVERY connection for a finished character, not just when
  -- chargenstate first flips: identity.reset() shuts it on every tick outside Joined.
  check('global.lua re-sends MP_ChargenDone to the player script on every connection',
    g:find("mp%.sendEvent%('ChargenComplete', {}%).-p:sendEvent%('MP_ChargenDone', {}%)%s*end%s*chargenReported = true") ~= nil)
  local idn = io.open('./openmw/files/data/scripts/mp/identity.lua'):read('*a')
  check('identity.reset clears the baselineReady mirror',
    idn:find("baselineReady = false%s+mp%.set%('baselineReady', '0'%)") ~= nil)
  -- The peer attaches avatar.lua INSTEAD of puppet.lua, so the equipment push must land there
  -- too, or every avatar fights bare-handed (it did, until s138 tried to draw a bow).
  local av = io.open('./openmw/files/data/scripts/mp/avatar.lua'):read('*a')
  check('avatar.lua applies MP_Equip on the avatar body (setEquipment is Self-gated)',
    av:find('MP_Equip = function', 1, true) ~= nil and av:find('pcall(types.Actor.setEquipment, self, slots)', 1, true) ~= nil)
  check('social.lua tells the player why time did not pass',
    s:find('MP_WorldTimeRefused = function', 1, true) ~= nil)
  -- ...and world.lua hands the adopted hours back, or the refused player lives ahead of
  -- everyone else until the next periodic WorldTime.
  local w = io.open('./openmw/files/data/scripts/mp/world.lua'):read('*a')
  check('global.lua hands a refused rest to world.lua before the notice',
    g:find('MP_WorldTimeRefused = function(data) worldmp.timeRefused()', 1, true) ~= nil)
  check('world.lua gives back the hours a refused rest adopted',
    w:find('function worldmp.timeRefused()', 1, true) ~= nil
    and w:find('targetAbs = targetAbs - pendingJump', 1, true) ~= nil)
  -- Backlog 144/152/154/155: a guildmate's crime expels; form and fangs change on the standing
  -- body instead of rebuilding it (the peer's avatar was torn down mid-fight); the Mark rides
  -- the doc through the same restore as everything else.
  check('global.lua MP_PlayerCrime expels from the victim faction',
    g:find("types.NPC.expel(player, data.faction)", 1, true) ~= nil)
  check('global.lua sets werewolf form / vampire spell in place on an appearance change',
    g:find('types.NPC.setWerewolf(body, data.isWerewolf == true)', 1, true) ~= nil
    and g:find("{ 'race', 'head', 'hair', 'isMale', 'class', 'birthsign', 'name' }", 1, true) ~= nil
    and g:find('types.Actor.spells(obj):add(app.vampireSpell)', 1, true) ~= nil)
  check('identity.lua carries the mark both ways, nil-guarded for older engines',
    idn:find("mp.sendEvent('PlayerMark', prog.mark)", 1, true) ~= nil
    and idn:find('record.mark and mp.setMark', 1, true) ~= nil
    and idn:find('if mp.getMark then', 1, true) ~= nil)
  -- SocialNotice: server-side notices worth surfacing.
  check('global.lua forwards MP_SocialNotice',
    g:find('MP_SocialNotice', 1, true) ~= nil,
    'a notice can evaporate with nobody told why')
  check('social.lua tells the player about it',
    s:find('MP_SocialNotice = function', 1, true) ~= nil)
  -- Backlog 136: pose bit 3 is USE on both ends. player.lua sent inAir there and puppet.lua
  -- read it as a swing, so every landing in degraded mode played a phantom chop.
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  check('player.lua puts the use control in pose bit 3, not inAir',
    pl:find('self.controls.use ~= 0) or core.getRealTime() < forceUseUntil then flags = flags + 8', 1, true) ~= nil
    and not pl:find('isOnGround(self) then flags = flags + 8', 1, true))
  check('puppet.lua reads pose bit 3 as the swing, on both edges',
    pp:find('local using = bit(target.flags, 3)', 1, true) ~= nil
    and pp:find('if using ~= prevUse then showSwing(not using) end', 1, true) ~= nil)
  -- Backlog 132: the movement-shaping effects reach the observer's puppet, or it pogos
  -- under a levitating friend.
  local vis = g:match('local VISIBLE_EFFECT = (%b{})')
  check('global.lua VISIBLE_EFFECT carries levitate, slowfall and waterwalking',
    vis ~= nil and vis:find('levitate = true', 1, true) ~= nil and vis:find('slowfall = true', 1, true) ~= nil
    and vis:find('waterwalking = true', 1, true) ~= nil, tostring(vis))
  -- Backlog 131: the cast the friend sees. The client sends it, and the field names are the
  -- ones server/src/core/combat.ts cast() validates.
  local cb = io.open('./openmw/files/data/scripts/mp/combat.lua'):read('*a')
  check('player.lua raises mpCombatCast on the use edge in the spell stance',
    pl:find("core.sendGlobalEvent('mpCombatCast', { spellId = spell.id })", 1, true) ~= nil)
  check('combat.lua sends CombatCast with spellId, casterId and kind',
    cb:find("mp.sendEvent('CombatCast', { spellId = data.spellId, casterId = id, kind = 'spell' })", 1, true) ~= nil
    and g:find('eventHandlers.mpCombatCast = combat.onCast', 1, true) ~= nil)
  -- Backlog 197-202, 205, 211: movement feel on a real link.
  check('player.lua reconciles against where it stood at lastInputSeq, not where it is now (197)',
    pl:find('posRing[inputSeq % POS_RING_N] = { seq = inputSeq, x = p.x, y = p.y, z = p.z }', 1, true) ~= nil
    and pl:find('local pos = posAt(e.lastInputSeq) or self.position', 1, true) ~= nil)
  check('avatar.lua latches the jump and use edges until onUpdate consumes them (198)',
    av:find('if bit(data.flags, 2) then jumpLatch = true end', 1, true) ~= nil
    and av:find('local jump = jumpLatch or bit(input.flags, 2)', 1, true) ~= nil
    and av:find('(useLatch or bit(input.flags, 3)) and 1 or 0', 1, true) ~= nil)
  check('avatar.lua holds the last input through a retransmit stall (205)',
    av:find('local INPUT_HOLD_S = 1.0', 1, true) ~= nil)
  local ob = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  check('objects.lua sends the intended door state at activation and keeps it over a stale echo (199)',
    ob:find('pending.sent = st == types.Door.STATE.Opening', 1, true) ~= nil
    and ob:find("if pending.sent ~= open then sendAddressed('DoorState', obj, { open = open }) end", 1, true) ~= nil
    and ob:find('pending.sent ~= data.open', 1, true) ~= nil)
  check('global.lua does not follow-teleport across an exterior border the body walked (200)',
    g:find('if walked then return end', 1, true) ~= nil
    and g:find('parseExteriorKey(prevCell) ~= nil and parseExteriorKey(data.cellKey) ~= nil', 1, true) ~= nil)
  check('identity.lua diffs active effects at 0.1 s (201)',
    idn:find('active = 0.1 }', 1, true) ~= nil)
  check('puppet.lua near-tier snap 256 and a held run flag (211)',
    pp:find('local SNAP_BY_TIER = { [0] = 256', 1, true) ~= nil
    and pp:find('self.controls.run = run or now < runUntil', 1, true) ~= nil)
end

-- ============================== every server->client event, generically, the same way
-- The two hand-checked above were found by a diff; this is the diff, kept. Every
-- sendEvent('X') / relayCell('X') / relayAll('X') in server/src must meet an MP_X handler
-- somewhere in scripts/mp (or a C++ MP_X in mwmp/). One with none is dropped in silence.
print('client -- every server->client event has an MP_ handler')
do
  local srv = {}
  local ls = io.popen("find ./server/src -name '*.ts' -not -path '*/test/*'")
  for path in ls:lines() do
    local f = io.open(path); if f then srv[#srv + 1] = f:read('*a'); f:close() end
  end
  ls:close()
  local sent, seen = {}, {}
  for _, src in ipairs(srv) do
    for name in src:gmatch("sendEvent%('([%w_]+)'") do if not seen[name] then seen[name] = true; sent[#sent + 1] = name end end
    for name in src:gmatch("relay%a*%([^)]-'([%u][%w_]+)'") do if not seen[name] then seen[name] = true; sent[#sent + 1] = name end end
  end
  local lua = {}
  local lsl = io.popen("find ./openmw/files/data/scripts/mp -name '*.lua'")
  for path in lsl:lines() do local f = io.open(path); if f then lua[#lua + 1] = f:read('*a'); f:close() end end
  lsl:close()
  local cpp = {}
  local lsc = io.popen("find ./openmw/apps/openmw/mwmp -name '*.cpp'")
  for path in lsc:lines() do local f = io.open(path); if f then cpp[#cpp + 1] = f:read('*a'); f:close() end end
  lsc:close()
  local all = table.concat(lua, string.char(10)) .. string.char(10) .. table.concat(cpp, string.char(10))
  local missing = {}
  for _, name in ipairs(sent) do
    if not all:find('MP_' .. name, 1, true) then missing[#missing + 1] = name end
  end
  check(#sent .. ' server->client events all have a handler', #sent > 20 and #missing == 0, table.concat(missing, ', '))
end

-- ================================== container refusals are explained, and stay explained
-- A refused container op UNDOES the optimistic local take, so the item disappears out of the
-- player's inventory a moment after they picked it up. Silence there reads as the game eating
-- your loot.
--
-- The reason list is read out of the SERVER source rather than hardcoded here, so adding a
-- refusal reason server-side and forgetting the client fails this test instead of shipping.
print('objects.lua -- every container refusal the server can send is worded')
do
  local ts = io.open('./server/src/core/worldstate.ts'):read('*a')
  local lua = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  -- PER SERVER HANDLER. containerOp's reasons must be worded in MP_ContainerOpResult and
  -- take's in MP_ObjectTakeResult: a 'gone' means different things in each, and the first
  -- version of this scan pooled every reply(false, ...) in the file and pointed them all at
  -- the container handler.
  local function reasonsIn(fnName)
    local body = ts:match('private async ' .. fnName .. '%(.-\10  }')
    local out, seen = {}, {}
    for r in (body or ''):gmatch("reply%(false,%s*'([a-z_]+)'") do
      if not seen[r] then seen[r] = true; out[#out + 1] = r end
    end
    return out
  end
  for _, pair in ipairs({ { 'containerOp', 'MP_ContainerOpResult' }, { 'take', 'MP_ObjectTakeResult' }, { 'spawn', 'MP_ObjectSpawnRefused' } }) do
    local fnName, luaHandler = pair[1], pair[2]
    local handler = lua:match(luaHandler .. ' = function%(data%)(.-)\10end')
    check(luaHandler .. ' was found', handler ~= nil)
    local reasons = reasonsIn(fnName)
    check(fnName .. '() refusal reasons were discovered', #reasons > 0, '#' .. #reasons)
    for _, r in ipairs(reasons) do
      -- Match the MAPPING ENTRY (`reason = '...'`), not the bare word. A plain substring search
      -- passes on any mention -- including the comment right above the table, which is how the
      -- first version of this test passed its own negative control.
      check(fnName .. ' "' .. r .. '" is worded for the player',
        handler ~= nil and handler:find(r .. "%s*=%s*'") ~= nil,
        'the item vanishes (or never moves) with nothing said')
    end
  end
end

-- ============================== objects.lua / player.lua: the barter window is a long window
-- Backlog 160/161/162. objects.lua needs types.Weapon.TYPE at load, which the stubs do not
-- carry, so these read the source: each check names the exact expression the fix hangs on.
print('objects.lua / player.lua -- a service window syncs for as long as it is open')
do
  local o = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  -- 160: a live (merchant) watch never expires on the chest's 15 s clock; onBarterClose ends it.
  check('a live watch has no expiry (until_ = math.huge), a chest keeps CONTAINER_WATCH_SECONDS',
    o:find('until_ = live and math.huge or (now + CONTAINER_WATCH_SECONDS)', 1, true) ~= nil,
    'a trade longer than 15 s stops syncing')
  check('onBarterClose still ends every live watch',
    (o:match('function objects%.onBarterClose%(%)(.-)\nend') or ''):find('containerWatch[id] = nil', 1, true) ~= nil)
  -- 161: record ids cross the container wire in net form, as the drop path does.
  local c2i = o:match('local function countsToItems%(counts%)(.-)\nend') or ''
  check('ContainerOpen contents / put-take ids go out through worldmp.toNet', c2i:find('worldmp.toNet(id)', 1, true) ~= nil)
  local sco = o:match('function objects%.sendContainerOp%(obj, op, itemId, n%)(.-)\nend') or ''
  check('sendContainerOp maps the item id toNet before it is pended and sent', sco:find('itemId = worldmp.toNet(itemId)', 1, true) ~= nil)
  local scc = o:match('local function setContainerContents%(obj, items%)(.-)\nend') or ''
  check('setContainerContents creates from worldmp.toLocal(entry.id)', scc:find('world.createObject(worldmp.toLocal(entry.id)', 1, true) ~= nil,
    "a friend's potion is created under the author's local id")
  local acd = o:match('local function applyContainerDelta%(obj, itemId, dn%)(.-)\nend') or ''
  check('applyContainerDelta maps the wire id toLocal', acd:find('itemId = worldmp.toLocal(itemId)', 1, true) ~= nil)
  -- 162: the dialogue lock survives Dialogue -> Barter/Training/... -> Dialogue.
  check('player.lua releases the dialogue lock only when leaving every talking mode',
    p:find("local function talking(m) return m == 'Dialogue' or GOLD_SERVICE_MODES[m] ~= nil end", 1, true) ~= nil
    and p:find('if talking(data.oldMode) and not talking(data.newMode) then', 1, true) ~= nil,
    'Dialogue -> Barter fires mpDialogueClosed and a second player can open the merchant mid-trade')
  check('player.lua no longer releases on the bare Dialogue edge',
    p:find("if data.oldMode == 'Dialogue' and data.newMode ~= 'Dialogue' then", 1, true) == nil)
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

-- ================================ world.lua: dayspassed is a function of the calendar
-- It used to be an offset learned from whatever this engine booted with, so every relog reset
-- it and no two engines agreed: DaysPassed-stamped timers (vampire incubation, lycanthropy)
-- misfired (backlog #150). Now: days since the vanilla start (16 Last Seed 3E 427 = day 1).
print('world.lua -- dayspassed counts from the vanilla start, on every engine alike')
do
  package.loaded['scripts.mp.world'] = nil
  stubs.install({})
  local okLoad, worldmp = pcall(require, 'scripts.mp.world')
  check('world.lua loads under the stubs', okLoad, tostring(worldmp))
  if okLoad then
    local d = worldmp.daysPassedOf
    check('the vanilla start is day 1', d({ year = 427, month = 8, day = 16, gameHour = 0 }) == 1,
      'got ' .. tostring(d({ year = 427, month = 8, day = 16, gameHour = 0 })))
    check('the hour does not move the day', d({ year = 427, month = 8, day = 16, gameHour = 23.9 }) == 1)
    check('the next morning is day 2', d({ year = 427, month = 8, day = 17, gameHour = 0 }) == 2)
    check('a month boundary counts the real month length (Last Seed has 31 days)',
      d({ year = 427, month = 9, day = 1, gameHour = 0 }) == 17)
    check('a year later is 366 (365-day calendar, no leap years)',
      d({ year = 428, month = 8, day = 16, gameHour = 0 }) == 366)
    check('before the start it clamps to 1, never 0 or negative',
      d({ year = 427, month = 1, day = 1, gameHour = 0 }) == 1)
  end
end

-- ============================================================ identity.lua: the spell restore REPLACES
-- Reported from live play: a Redguard carrying Ancestor Guardian, a DUNMER power. applyChargen
-- runs buildPlayer(), which clears the spellbook and grants this character's race powers,
-- birthsign powers and autocalc spells. Phase 2 then restored the saved set by ADDING it, so the
-- two were unioned and anything the slot used to own survived a race it no longer is. The diff
-- could not clean up after it either: broadcasts are suppressed while `restoring`, and last.spells
-- is re-seeded from the union, so the stale power never surfaced as a removal.
print('identity.lua -- the rejoin spell restore replaces rather than merges')
fresh()
env = stubs.install({})
local identity = require('scripts.mp.identity')

-- What chargen just granted (this slot was a Dunmer before it was rebuilt).
env.spellbook:add('ancestor_guardian')
-- What the character actually owns, per the server doc.
identity.applyRecord({ stats = {}, spells = { 'adrenaline_rush' } })
identity.equipRetryTick(1.0) -- past the 0.5 s settle

local function bookIds()
  local out = {}
  for _, sp in ipairs(env.spellbook) do out[#out + 1] = sp.id end
  table.sort(out)
  return out
end
local ids = bookIds()
check('the saved spell is restored', #ids == 1 and ids[1] == 'adrenaline_rush',
  'book=' .. table.concat(ids, ','))
check('the power from the race this slot no longer is does not survive',
  #ids == 1 and ids[1] ~= 'ancestor_guardian',
  'book=' .. table.concat(ids, ',') .. ' -- the restore unioned instead of replacing')

-- The guard: a record with NO spells must not wipe what chargen just granted, or a character
-- whose doc predates spell persistence is stripped of its racial powers on every rejoin.
fresh()
env = stubs.install({})
identity = require('scripts.mp.identity')
env.spellbook:add('adrenaline_rush')
identity.applyRecord({ stats = {}, spells = {} })
identity.equipRetryTick(1.0)
check('an empty saved set leaves the chargen grant alone', #env.spellbook == 1,
  '#book=' .. #env.spellbook)

-- ====================================== identity.lua: stale ability EFFECTS are purged on restore
-- The attribute climb. A level-1 Redguard Acrobat with the Lady's Favor birthsign was reported
-- holding Endurance 225 and Personality 205, then 275/255 minutes later. Read against the actual
-- game records: Lady's Favor grants "lady's grace" (Fortify Endurance 25) and "lady's favor"
-- (Fortify Personality 25), and 175 = 7x25 while 225 = 9x25 -- the SAME ability applied seven
-- times, then nine, which is why both attributes carried an identical offset while the other six
-- sat still. The sheet shows getModified(), and CreatureStats recomputes base fatigue from the
-- MODIFIED attributes, which is why the fatigue bar tracked the inflation instead of exposing it.
--
-- Cause: the restore rebuilds the character in place, and nothing took the OLD effects off.
-- Spells::clear() and removeSpell() touch the spell LIST only, and activeSpells:remove() refuses
-- anything without Flag_Temporary, so a constant-effect ability could not be removed from script.
-- Every rebuild layered one more copy on the last.
print('identity.lua -- the restore purges stale ability effects before re-adding')
fresh()
env = stubs.install({})
local identity = require('scripts.mp.identity')

identity.applyRecord({ stats = {}, spells = { 'lady_s_grace' } })
identity.equipRetryTick(1.0)

local seq = table.concat(env.calls.seq, ',')
check('the active effects are purged during the restore',
  seq:find('clearActive', 1, true) ~= nil,
  'seq=' .. seq .. ' -- without this the birthsign fortify stacks once per rejoin')
-- ORDER is the contract: purge first, then re-add, so the engine re-applies each ability exactly
-- once on its next update (guarded by isSpellActive). Purging afterwards would strip the copy it
-- had just applied.
check('the purge happens BEFORE the spells are re-added',
  seq:find('clearActive', 1, true) < (seq:find('add:', 1, true) or math.huge),
  'seq=' .. seq)

-- ================================ identity.lua: the restore reports a class it could not apply
-- The other half of the live report -- "the class too". applyChargen sets the class from
-- record.appearance.class, then phase 2 writes record.stats.attributes over the rebuilt character
-- as `.base`. The class bonus baked into those saved bases is whatever class was current when they
-- were CAPTURED and is never reconciled against the class now displayed, so the two can disagree
-- with nothing checking. The reported sheet read Acrobat (favoured Agility+Endurance) while its
-- bases carried the +10 pair on Strength+Agility, which only Crusader and Archer produce.
print('identity.lua -- a class the restore could not apply is reported, not hidden')
local function saidClassMismatch(env)
  for _, line in ipairs(env.calls.prints) do
    if line:find('CLASS MISMATCH', 1, true) then return line end
  end
  return nil
end

-- The stub character is a nightblade; the doc claims acrobat. That is the divergence.
fresh()
env = stubs.install({})
local identity = require('scripts.mp.identity')
identity.applyRecord({ stats = {}, appearance = { class = 'acrobat' } })
identity.equipRetryTick(1.0)
check('a class the engine did not end up with is reported',
  saidClassMismatch(env) ~= nil,
  'the sheet would show one class while the stats came from another, silently')

-- Self-silencing: agreeing class must say NOTHING, or the log is noise on every healthy restore.
fresh()
env = stubs.install({})
identity = require('scripts.mp.identity')
identity.applyRecord({ stats = {}, appearance = { class = 'nightblade' } })
identity.equipRetryTick(1.0)
check('an agreeing class is silent', saidClassMismatch(env) == nil,
  'got: ' .. tostring(saidClassMismatch(env)))

-- ============================================================ quests.lua: global sync fairness
-- Morrowind gates most quests on mwscript globals, and this loop is how they travel. It walked
-- pairs(store) -- an order Lua explicitly does not define -- and sent at most 24 per tick, so
-- above 24 changing globals WHICH ones got through was arbitrary and a quest global could sit
-- unsent indefinitely behind churning ones while the log showed a healthy rate-limited sync.
-- Reachable, not theoretical: the game ships scripts that set values every other frame.
print('quests.lua -- no global starves behind churning ones')
fresh()
env = stubs.install({})
local quests = require('scripts.mp.quests')
quests.init({ playerFn = function() return nil end })

local function globalUpdates(calls)
  local out = {}
  for _, c in ipairs(calls.events) do
    if c.name == 'GlobalVarUpdate' then out[#out + 1] = c.body.name end
  end
  return out
end

-- Seed: the first pass records what exists without broadcasting it.
for i = 1, 40 do env.setGlobal('churn' .. i, 0) end
env.setGlobal('quest_important', 0)
quests.tick(0)
check('the seeding pass broadcasts nothing', #globalUpdates(env.calls) == 0,
  'replaying every existing global on connect is not a change')

-- Now change far more than one tick can carry, including the one that matters.
for i = 1, 40 do env.setGlobal('churn' .. i, 1) end
env.setGlobal('quest_important', 1)

-- Drain over several ticks. DIFF_INTERVAL is 1s, so advance a second each time.
local seen = {}
for t = 1, 6 do
  quests.tick(t)
  for _, n in ipairs(globalUpdates(env.calls)) do seen[n] = true end
end
check('the quest global is not starved by 40 churning ones', seen['quest_important'] == true,
  'it can wait behind them forever when the send order is undefined')
local missing = 0
for i = 1, 40 do if not seen['churn' .. i] then missing = missing + 1 end end
check('every changed global eventually sends', missing == 0, missing .. ' never sent')

-- The rate limit must still hold, or this trades starvation for a packet flood.
fresh()
env = stubs.install({})
quests = require('scripts.mp.quests')
quests.init({ playerFn = function() return nil end })
for i = 1, 100 do env.setGlobal('g' .. i, 0) end
quests.tick(0)
for i = 1, 100 do env.setGlobal('g' .. i, 1) end
quests.tick(1)
check('one tick still respects the send budget', #globalUpdates(env.calls) <= 24,
  'sent ' .. #globalUpdates(env.calls) .. ' in a single tick')

-- ============================================================ quests.lua: dialogue lock edges
-- Source checks (the engine's UI and death paths cannot run here). A ForceGreeting opens the
-- window with no activation, so no lock was taken and every result of the conversation was
-- dropped as nobody's (backlog 226); an NPC killed mid-conversation left the window open on the
-- corpse (backlog 228); the interaction watch expired 6 s into a conversation so a dialogue
-- result's local writes never travelled (backlog 222).
print('quests.lua -- forced greetings take the lock, a dead partner closes the window, locals flush on release')
do
  local q = io.open('./openmw/files/data/scripts/mp/quests.lua'):read('*a')
  local pl = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  check('player.lua reports a Dialogue window that opened without an activation (mpDialogueForced)',
    pl:find("data.newMode == 'Dialogue' and not talking(data.oldMode) and data.arg", 1, true) ~= nil
    and pl:find("core.sendGlobalEvent('mpDialogueForced', { target = data.arg })", 1, true) ~= nil)
  check('global.lua routes mpDialogueForced to quests.onDialogueForced',
    g:find('mpDialogueForced = function(data)', 1, true) ~= nil and g:find('quests.onDialogueForced(data.target)', 1, true) ~= nil)
  check('quests.onDialogueForced requests the lock as forced, unless already held or pending',
    q:find('function quests.onDialogueForced(obj)', 1, true) ~= nil and q:find('requestLock(obj, true)', 1, true) ~= nil
    and q:find('if lockPending and lockPending.id == obj.id then return end', 1, true) ~= nil)
  check('a forced grant sets lockHeld/lockDisposition like the activation path and does not re-activate',
    q:find('lockAllowOnce = not forced and obj.id or nil', 1, true) ~= nil
    and q:find('if player and not forced then obj:activateBy(player) end', 1, true) ~= nil)
  check('a forced denial closes the window the other holder owns',
    q:find("if forced then%s+local player = playerObj%(%)%s+if player then pcall%(function%(%) player:sendEvent%('MP_CloseDialogue', {}%) end%) end") ~= nil)
  check('actors.lua hands every MP_ActorDeath to the quest layer',
    ac:find('if obj and deps.actorDeathFn then pcall(deps.actorDeathFn, obj) end', 1, true) ~= nil
    and g:find('actorDeathFn = function(obj) quests.onActorDeath(obj) end', 1, true) ~= nil)
  check('quests.onActorDeath closes the window on the lock holder and releases the lock',
    q:find("function quests.onActorDeath(obj)", 1, true) ~= nil
    and q:find("lockHeld:isValid%(%) and lockHeld.id == obj.id%) then return end%s+local player = playerObj%(%)%s+if player then pcall%(function%(%) player:sendEvent%('MP_CloseDialogue', {}%) end%) end%s+quests.releaseLock%('dead'%)") ~= nil)
  check('player.lua removes the Dialogue mode on MP_CloseDialogue',
    pl:find("MP_CloseDialogue = function()", 1, true) ~= nil and pl:find("I.UI.removeMode('Dialogue')", 1, true) ~= nil)
  check('the lock grant arms an open-ended member-var watch and the release flushes it',
    q:find('until_ = math.huge', 1, true) ~= nil and q:find('armLockWatch(obj)', 1, true) ~= nil
    and q:find('if obj:isValid() then pcall(flushMemberVars, watch) end', 1, true) ~= nil)
  check('the re-run activation does not shorten the conversation watch back to 6 s',
    q:find('if lockHeld and lockHeld.id == object.id and memberWatch[object.id] then return end', 1, true) ~= nil)
end
-- ============================================================ quests.lua: running global scripts (219)
print('quests.lua -- running global scripts are diffed, chargen never travels, the sync starts what is missing')
fresh()
package.loaded['scripts.mp.quests'] = nil -- fresh() keeps it; this needs a module bound to THIS stub
env = stubs.install({})
local running = { 'Sleepers', 'CharGenBed', 'Startup' }
env.mp.runningGlobalScripts = function() return running end
local startedIds = {}
env.mp.startGlobalScript = function(id) startedIds[#startedIds + 1] = id end
quests = require('scripts.mp.quests')
quests.init({ playerFn = function() return nil end })
local function scriptUpdates(calls)
  local out = {}
  for _, c in ipairs(calls.events) do if c.name == 'GlobalScriptsUpdate' then out[#out + 1] = c.body end end
  return out
end
quests.tick(0)
local ups = scriptUpdates(env.calls)
check('the first poll reports the full running list as started', #ups == 1 and #ups[1].started == 1 and ups[1].started[1] == 'sleepers',
  'a script started before the socket opened (Startup) would otherwise never be persisted')
check('chargen and startup scripts never travel', #ups == 1 and #ups[1].stopped == 0)
running = { 'Sleepers', 'VampireCheck' }
quests.tick(5)
ups = scriptUpdates(env.calls)
check('a newly started script is sent as started, nothing else', #ups == 2 and #ups[2].started == 1 and ups[2].started[1] == 'vampirecheck' and #ups[2].stopped == 0)
running = { 'VampireCheck' }
quests.tick(10)
ups = scriptUpdates(env.calls)
check('a script that ended is sent as stopped', #ups == 3 and ups[3].stopped[1] == 'sleepers' and #ups[3].started == 0)
quests.tick(15)
check('no change, no event', #scriptUpdates(env.calls) == 3)
quests.handlers.MP_GlobalScriptsSync({ running = { 'MoveMehra', 'chargenstate' } })
check('the join sync starts the campaign scripts and skips chargen ones', #startedIds == 1 and startedIds[1] == 'MoveMehra')

-- ============================================================ every mp script: declaration order
-- A `handlers.X = function ... end` placed ABOVE `local handlers = {}` does not assign into that
-- table. It indexes a GLOBAL called `handlers`, which is nil, and the whole module fails at LOAD
-- -- taking every script that requires it down with it. `loadfile` cannot see this: it compiles
-- the chunk and never runs the top level. This happened for real (objects.lua, the pickup veto:
-- the handler was written 200 lines above the declaration and parsed perfectly). Pure text, so
-- it runs without the engine, and it covers every local table, not just `handlers`.
print('scripts/mp/*.lua -- no local table is assigned into before it is declared')
local function assignedBeforeDeclared(src)
  local decl, bad, n = {}, {}, 0
  for line in (src .. '\n'):gmatch('(.-)\n') do
    n = n + 1
    local name = line:match('^local%s+([%a_][%w_]*)%s*=%s*{')
    if name and not decl[name] then decl[name] = n end
  end
  n = 0
  for line in (src .. '\n'):gmatch('(.-)\n') do
    n = n + 1
    local name = line:match('^%s*([%a_][%w_]*)%.[%a_][%w_]*%s*=')
    if name and decl[name] and n < decl[name] then bad[#bad + 1] = name .. ' at line ' .. n .. ' (declared at ' .. decl[name] .. ')' end
  end
  return bad
end
-- The guard must be able to FAIL: the exact shape of the real bug, inline.
local negative = assignedBeforeDeclared('local x = 1\nhandlers.foo = function() end\nlocal handlers = {}\nhandlers.bar = 1\n')
check('the scan catches an assignment above the declaration', #negative == 1 and negative[1]:find('^handlers at line 2') ~= nil,
  table.concat(negative, '; '))
local mpFiles = {}
local ls = io.popen('ls ./openmw/files/data/scripts/mp/*.lua 2>/dev/null')
if ls then for path in ls:lines() do mpFiles[#mpFiles + 1] = path end; ls:close() end
check('the mp scripts were found', #mpFiles >= 10, #mpFiles .. ' files')
for _, path in ipairs(mpFiles) do
  local f = io.open(path); local src = f:read('*a'); f:close()
  local bad = assignedBeforeDeclared(src)
  check(path:match('([^/]+)$') .. ' assigns into no table before declaring it', #bad == 0, table.concat(bad, '; '))
end

-- A `local function f` is nil above its own line: a call to it from an earlier function is a
-- runtime "attempt to call a nil value" the stubs only reach if that path executes. Caught
-- 2026-09-11 in quests.lua (npcAddr used by the member-var poller, declared 20 lines lower).
-- Static, so it needs no path to execute: every `local function NAME` in a file, and every
-- bare `NAME(` above that line that is not itself a declaration or a field access.
local function calledBeforeDeclared(src)
  local decl, bad, n = {}, {}, 0
  for line in (src .. '\n'):gmatch('(.-)\n') do
    n = n + 1
    local name = line:match('^local%s+function%s+([%a_][%w_]*)%s*%(')
    if name and not decl[name] then decl[name] = n end
  end
  n = 0
  for line in (src .. '\n'):gmatch('(.-)\n') do
    n = n + 1
    local code = line:gsub('%-%-.*$', '')
    for pre, name in code:gmatch('([^%w_%.:]?)([%a_][%w_]*)%s*%(') do
      if decl[name] and n < decl[name] and pre ~= '.' and pre ~= ':'
        and not code:match('^%s*local%s+function%s+' .. name .. '%s*%(')
        and not code:match('function%s+' .. name .. '%s*%(') then
        bad[#bad + 1] = name .. ' at line ' .. n .. ' (declared at ' .. decl[name] .. ')'
      end
    end
  end
  return bad
end
local negCall = calledBeforeDeclared('local function a()\n  return b()\nend\nlocal function b() return 1 end\n')
check('the scan catches a call above the local function declaration', #negCall == 1 and negCall[1]:find('^b at line 2') ~= nil,
  table.concat(negCall, '; '))
for _, path in ipairs(mpFiles) do
  local f = io.open(path); local src = f:read('*a'); f:close()
  local bad = calledBeforeDeclared(src)
  check(path:match('([^/]+)$') .. ' calls no local function above its declaration', #bad == 0, table.concat(bad, '; '))
end

-- ============================================ item states: one entry per stack (233, 234)
-- An index over stateful stacks was not an identity: one Soultrap kill on the peer filled all
-- three gems of a stack, two daggers of one record swapped conditions on every relog. Every
-- stack now sends {n=count,...}; the appliers walk the stacks in order and split a stack that
-- is bigger than its entry. A lockpick/probe/repair/light is tagged `own` (233): it wears only
-- on the client, so the server must not treat the drop as a raise-only refusal.
print('identity.lua -- item states carry n per stack, own for tools')
do
  fresh()
  env = stubs.install({})
  env.types.Lockpick = { name = 'Lockpick' }
  local id = require('scripts.mp.identity')
  id.markBaselineReady()
  env.setInventory({
    { recordId = 'pick_apprentice', count = 1, type = env.types.Lockpick, itemData = { condition = 10 } },
    { recordId = 'misc_soulgem_common', count = 1, itemData = { soul = 'scamp' } },
    { recordId = 'misc_soulgem_common', count = 2, itemData = {} },
    { recordId = 'gold_001', count = 40 },
  })
  id.tick(0)
  local inv
  for _, c in ipairs(env.calls.events) do if c.name == 'mpInventoryOut' then inv = c.body end end
  check('an inventory snapshot went out (mpInventoryOut, via global for the record registry)', inv ~= nil)
  local st = inv and inv.itemStates or {}
  local pick = st.pick_apprentice and st.pick_apprentice[1]
  check('a lockpick entry is tagged own with its condition and n',
    pick ~= nil and pick.own == true and pick.condition == 10 and pick.n == 1,
    pick and (tostring(pick.own) .. '/' .. tostring(pick.condition) .. '/' .. tostring(pick.n)) or 'nil')
  local gems = st.misc_soulgem_common or {}
  check('a filled gem and a stateless stack of two are two entries, in order',
    #gems == 2 and gems[1].n == 1 and gems[1].soul == 'scamp' and gems[2].n == 2 and gems[2].soul == nil,
    '#gems=' .. #gems)
  local gold = st.gold_001 or {}
  check('a stateless stack is a bare {n} (positions stay stable)', #gold == 1 and gold[1].n == 40 and gold[1].own == nil)
end

print('global.lua -- applyItemStates splits a stack to fit an entry; the peer report round-trips')
do
  local f = io.open('./openmw/files/data/scripts/mp/global.lua')
  local src = f:read('*a'):gsub('\r\n', '\n'); f:close()
  local applyChunk = src:match('(local function applyItemStates%(.-\nend\n)')
  local snapChunk = src:match('(local function snapAvatarItemStates%(.-\nend\n)')
  check('applyItemStates and snapAvatarItemStates were found', applyChunk ~= nil and snapChunk ~= nil)
  -- A fake inventory with the two engine behaviours that matter: split() hands back a NEW
  -- object carrying the same itemData and removes the count from the source only later in the
  -- frame (mwlua objectbindings.cpp: DelayedRemovalFn), and moveInto appends.
  local function fakeInventory(items)
    local inv = { items = items }
    function inv:getAll() return self.items end
    local function mk(recordId, count, data)
      local it = { recordId = recordId, count = count, itemData = data }
      function it:split(n)
        local copy = {}
        for k, v in pairs(self.itemData) do copy[k] = v end
        local piece = mk(self.recordId, n, copy)
        piece.fromSplit = self
        return piece
      end
      function it:moveInto(target)
        if self.fromSplit then self.fromSplit.count = self.fromSplit.count - self.count end
        target.items[#target.items + 1] = self
      end
      return it
    end
    for i, it in ipairs(items) do items[i] = mk(it.recordId, it.count, it.itemData or {}) end
    return inv
  end
  local ok, applyItemStates = pcall(function()
    return assert((loadstring or load)(applyChunk .. '\nreturn applyItemStates'))()
  end)
  check('applyItemStates loads', ok and type(applyItemStates) == 'function', tostring(applyItemStates))
  if type(applyItemStates) == 'function' then
    local inv = fakeInventory({ { recordId = 'misc_soulgem_common', count = 3 } })
    local n = applyItemStates(inv, 'misc_soulgem_common', { { n = 1, soul = 'scamp' }, { n = 2 } })
    check('one entry wrote a state', n == 1, 'n=' .. tostring(n))
    check('the stack of 3 became a souled 1 and an empty 2',
      #inv.items == 2 and inv.items[1].count == 2 and inv.items[1].itemData.soul == nil
        and inv.items[2].count == 1 and inv.items[2].itemData.soul == 'scamp',
      #inv.items .. ' stacks')
    -- Two daggers, two conditions: each lands on its own stack, none on both.
    local inv2 = fakeInventory({ { recordId = 'iron_dagger', count = 1 }, { recordId = 'iron_dagger', count = 1 } })
    applyItemStates(inv2, 'iron_dagger', { { n = 1, condition = 300 }, { n = 1, condition = 12 } })
    check('two same-record stacks keep their own conditions',
      inv2.items[1].itemData.condition == 300 and inv2.items[2].itemData.condition == 12)
    -- A pre-234 doc entry (no n) still takes the whole stack.
    local inv3 = fakeInventory({ { recordId = 'iron_dagger', count = 1 } })
    applyItemStates(inv3, 'iron_dagger', { { condition = 5 } })
    check('an entry without n applies to the whole stack, as before', inv3.items[1].itemData.condition == 5 and #inv3.items == 1)
    -- The peer's report of that inventory: exactly one filled entry, the empty stack kept as {n}.
    local ok2, snap = pcall(function()
      return assert((loadstring or load)('local types, worldmp = ...\n' .. snapChunk .. '\nreturn snapAvatarItemStates'))(
        { Actor = { inventory = function(obj) return obj end } }, {})
    end)
    check('snapAvatarItemStates loads', ok2 and type(snap) == 'function', tostring(snap))
    if type(snap) == 'function' then
      local states = snap(inv)
      local gems = states.misc_soulgem_common or {}
      local filled = 0
      for _, e in ipairs(gems) do if e.soul then filled = filled + 1 end end
      check('the peer reports the 3-stack as two entries with exactly one filled gem',
        #gems == 2 and filled == 1 and gems[1].n == 2 and gems[2].n == 1 and gems[2].soul == 'scamp',
        '#gems=' .. #gems .. ' filled=' .. filled)
    end
  end
  -- Wiring: the owner's copy is applied in the GLOBAL script (split() is global-context), and
  -- every applier goes through the one walker.
  check('MP_SelfItemStates applies in global.lua and no longer forwards to player.lua',
    src:find("MP_SelfItemStates = function(data)\n        local player = playerScript()", 1, true) ~= nil
      and not src:find("toPlayer('MP_SelfItemStates'", 1, true))
  local uses = 0
  for _ in src:gmatch('pcall%(applyItemStates, inventory') do uses = uses + 1 end
  check('avatar apply, relog restore and MP_SelfItemStates all use applyItemStates', uses == 3, 'uses=' .. uses)
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  check('player.lua no longer carries its own item-state applier', not p:find('d.enchantmentCharge = st.charge', 1, true))
  check("player.lua answers itemstates:<id> with every stack's state", p:find("'^itemstate(s?):(.+)$'", 1, true) ~= nil)
end

-- ============================================ mp.omwscripts: one line per script path
-- The engine keeps only the LAST line naming a path (components/lua/configuration.cpp), so
-- `NPC: x.lua` followed by `CREATURE: x.lua` attaches x.lua to creatures only. companion.lua
-- sat like that for weeks: no NPC ever carried it, and no companion ever followed anyone.
print('mp.omwscripts -- every script path is listed once')
do
  local f = io.open('./openmw/files/data/mp.omwscripts'); local cfg = f:read('*a'); f:close()
  local seen, dups = {}, {}
  for line in cfg:gmatch('[^' .. string.char(10) .. ']+') do
    line = line:gsub(string.char(13) .. '$', '')
    if not line:match('^%s*#') and not line:match('^%s*%+') then
      local path = line:match(':%s*(%S+%.lua)%s*$')
      if path then
        if seen[path] then dups[#dups + 1] = path end
        seen[path] = true
      end
    end
  end
  check('no script path appears on two lines (the first is silently dropped)', #dups == 0, table.concat(dups, ', '))
  -- ...AND EVERY PATH IS BAKED INTO THE NATIVE PEER. The browser bake copies scripts/mp/ whole
  -- (wasm-build/link-openmw.sh); the peer's resources/vfs come from files/data/CMakeLists.txt,
  -- one line per file. companion.lua was never added there: the peer ran without it for four
  -- days ("Resource 'scripts/mp/companion.lua' not found" in every Jenkins peer log), so the
  -- holder never reported a follow, a fight or a scripted travel, and the harness's script
  -- sync (which hid this locally) fails under Jenkins.
  local cm = io.open('./openmw/files/data/CMakeLists.txt'):read('*a')
  local missing = {}
  for path in pairs(seen) do
    if not cm:find(string.char(10) .. '%s*' .. path:gsub('%.', '%%.') .. '%s*' .. string.char(10)) then missing[#missing + 1] = path end
  end
  check('every mp.omwscripts path is listed in files/data/CMakeLists.txt (the peer image)', #missing == 0, table.concat(missing, ', '))
end

print(string.format('\n%d passed, %d failed', pass, fail))
os.exit(fail == 0 and 0 or 1)
