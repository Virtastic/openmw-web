-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- Logic tests for the mp/ CLIENT scripts. Run with:
--   docker run --rm -v "$PWD:/repo" alpine:3 sh -c \
--     'apk add --no-cache lua5.1 >/dev/null && cd /repo && lua5.1 wasm-build/lua-tests/run.lua'
package.path = './openmw/files/data/?.lua;./wasm-build/lua-tests/?.lua;' .. package.path

local stubs = require('stubs')
-- A Windows checkout (core.autocrlf) hands the source checks CRLF files; the checks look for
-- '\n'-delimited hunks. Normalise every read here so a check means the same on both hosts.
do
  local rawOpen = io.open
  io.open = function(path, mode)
    local f = rawOpen(path, mode)
    if not f or (mode and mode:find('w')) then return f end
    return setmetatable({}, { __index = function(_, k)
      if k == 'read' then return function(_, ...) local s = f:read(...); return type(s) == 'string' and s:gsub('\r\n', '\n') or s end end
      local v = f[k]; if type(v) == 'function' then return function(_, ...) return v(f, ...) end end; return v
    end })
  end
end
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

-- ===================================================== combat.lua: magic hits, per effect
-- Backlog 249/250/251/254: the veto and the application are per EFFECT of the record, the
-- spell id crosses as a net id, a scroll's item id resolves through its enchantment, and a
-- reflection is not reflected again.
print('combat.lua -- a spell hit names which effects, and the owner applies only those')
do
  local env = stubs.install({})
  local core = require('openmw.core')
  local types = require('openmw.types')
  core.magic.spells.records['fire_bite'] = { id = 'fire_bite', effects = { { id = 'firedamage' }, { id = 'restorehealth' } } }
  core.magic.enchantments.records['sc_ench'] = { id = 'sc_ench', effects = { { id = 'firedamage' } } }
  types.Book = { record = function(id) return id == 'sc_fireball' and { enchant = 'sc_ench' } or nil end }
  local added = nil
  types.Actor.activeSpells = function() return { add = function(_, o) added = o end } end
  package.loaded['scripts.mp.world'] = nil
  local combat = dofile('./openmw/files/data/scripts/mp/combat.lua')
  local pvp = true
  combat.init({
    playerFn = function() return { id = 'me' } end,
    ownIdFn = function() return 1 end,
    puppetObjOf = function() return nil end,
    epochOf = function() return nil end,
    isHolderOf = function() return true end,
    cellKeyOfObj = function() return '0,0' end,
    isPvpEnabled = function() return pvp end,
  })
  local function lastSpell()
    for i = #env.calls.events, 1, -1 do
      if env.calls.events[i].name == 'CombatSpellHit' then return env.calls.events[i].body end
    end
    return nil
  end
  local mixed = { { id = 'firedamage', magnitude = 5, duration = 0, index = 0, beneficial = false },
                  { id = 'restorehealth', magnitude = 5, duration = 0, index = 1, beneficial = true } }
  combat.onPuppetSpellHit({ playerId = 2, effects = mixed, spellId = 'fire_bite', beneficial = false, ignoreReflect = true })
  local sent = lastSpell()
  check('the indexes that hit travel with the cast (250)',
    sent ~= nil and #sent.indexes == 2 and sent.indexes[1] == 0 and sent.indexes[2] == 1)
  check('and so does the reflect word (254)', sent ~= nil and sent.ignoreReflect == true)
  check('a mixed cast is not beneficial (249)', sent ~= nil and sent.beneficial == false)

  pvp = false
  local n0 = #env.calls.events
  combat.onPuppetSpellHit({ playerId = 2, effects = mixed, spellId = 'fire_bite', beneficial = false })
  sent = lastSpell()
  check('PvP off keeps the heal and drops the burn, not the whole cast (249)',
    #env.calls.events > n0 and sent.beneficial == true and #sent.indexes == 1 and sent.indexes[1] == 1
    and #sent.effects == 1 and sent.effects[1].id == 'restorehealth', tostring(sent and #sent.effects))
  n0 = #env.calls.events
  combat.onPuppetSpellHit({ playerId = 2, effects = { mixed[1] }, spellId = 'fire_bite', beneficial = false })
  check('an all-harmful cast at a player is vetoed under PvP off', #env.calls.events == n0)
  pvp = true

  -- Receive: only the named indexes, the record found through the item's enchantment.
  local me = { isValid = function() return true end }
  combat.init({
    playerFn = function() return me end, ownIdFn = function() return 1 end,
    puppetObjOf = function() return nil end, epochOf = function() return nil end,
    isHolderOf = function() return true end, cellKeyOfObj = function() return '0,0' end,
    isPvpEnabled = function() return true end,
  })
  added = nil
  combat.handlers.MP_CombatSpellHit({ target = { playerId = 1 }, spellId = 'fire_bite', indexes = { 1 }, ignoreReflect = true })
  check('the owner applies only the indexes that hit (250)',
    added ~= nil and #added.effects == 1 and added.effects[1] == 1 and added.id == 'fire_bite')
  check('and does not reflect a reflection (254)', added ~= nil and added.ignoreReflect == true)
  added = nil
  combat.handlers.MP_CombatSpellHit({ target = { playerId = 1 }, spellId = 'fire_bite' })
  check('no indexes = the whole record, as before', added ~= nil and #added.effects == 2 and added.ignoreReflect == false)
  added = nil
  combat.handlers.MP_CombatSpellHit({ target = { playerId = 1 }, spellId = 'fire_bite', indexes = { 7 } })
  check('an index past the record applies nothing', added == nil)
  added = nil
  combat.handlers.MP_CombatSpellHit({ target = { playerId = 1 }, spellId = 'sc_fireball' })
  check('a scroll resolves through its enchantment, by the item id (251)',
    added ~= nil and added.id == 'sc_fireball' and #added.effects == 1, tostring(added and added.id))
  local cb = io.open('./openmw/files/data/scripts/mp/combat.lua'):read('*a')
  check('the spell id crosses as a net id both ways (251)',
    cb:find('spellId = worldmp.toNet(data.spellId or effects[1].id)', 1, true) ~= nil
    and cb:find('local spellId = worldmp.toLocal(data.spellId)', 1, true) ~= nil)
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  check('puppet.lua words the cast beneficial only when EVERY hit is (249)',
    pp:find('if h.beneficial ~= true then beneficial = false end', 1, true) ~= nil)
  types.Book = nil
end

-- ====================================== global.lua: a restore lands once on a ruled body
-- Backlog 248: the bar channel already carries what a Restore Health / Magicka or a Damage
-- Magicka did; mirroring the effect as well landed it twice.
print('global.lua -- restore/damage H/M effects are not mirrored (the bars carry them)')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local bc = g:match('local BAR_CARRIED_EFFECT = (%b{})')
  check('global.lua BAR_CARRIED_EFFECT drops restorehealth, restoremagicka and damagemagicka only',
    bc ~= nil and bc:find('restorehealth = true', 1, true) ~= nil and bc:find('restoremagicka = true', 1, true) ~= nil
    and bc:find('damagemagicka = true', 1, true) ~= nil and bc:find('fatigue', 1, true) == nil
    and bc:find('damagehealth', 1, true) == nil, tostring(bc))
  check('applied on both mirrors: MP_AvatarActiveSpells (peer) and MP_SelfActiveSpells (owner)',
    g:find('if localId then effects = withoutBarCarried(localId, effects) end', 1, true) ~= nil
    and g:find('local effects = localId and withoutBarCarried(localId, sp.effects or {}) or {}', 1, true) ~= nil)
  -- The helper itself, run: the record's restore index goes, the rest stay.
  local src = g:match('(local function magicRecordOf.-\nend)') .. '\n'
    .. g:match('(local BAR_CARRIED_EFFECT = .-local function withoutBarCarried.-\nend)')
    .. '\nreturn withoutBarCarried'
  stubs.install({})
  local core = require('openmw.core')
  core.magic.spells.records['heal_and_light'] = { effects = { { id = 'restorehealth' }, { id = 'light' }, { id = 'restorefatigue' } } }
  local f, lerr = loadstring(src)
  check('the helper loads on its own', f ~= nil, tostring(lerr))
  if f then
    local env = setmetatable({ core = core, ipairs = ipairs, pcall = pcall, types = require('openmw.types') }, { __index = _G })
    setfenv(f, env)
    local without = f()
    local kept = without('heal_and_light', { 0, 1, 2 })
    check('the restore index is dropped, light and fatigue stay', #kept == 2 and kept[1] == 1 and kept[2] == 2)
    local unknown = without('no_such_record', { 0, 1 })
    check('an unknown record is left alone', #unknown == 2)
  end
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
  -- Backlog 359: the same record from the same owner never stacks on the avatar (eight adds
  -- of one Fortify Health custom spell were eight times the effect); distinct records still do.
  check('global.lua MP_AvatarActiveSpells stacks only distinct records per owner',
    g:find('local stack = (ownerActive[data.id][localId] or 0) <= 1', 1, true) ~= nil
      and g:find('caster = p.obj, stackable = stack,', 1, true) ~= nil
      and g:find('caster = p.obj, stackable = true,', 1, true) == nil,
    'a repeated active-effect add stacks again')
  -- Backlog 213/214/216/218: the engine's script notes are drained once joined and reach
  -- the three consumers; the object's OWN cell key travels; a scripted teleport lands on
  -- the holder; a persisted re-enable is applied at cell entry.
  local ob = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  -- Backlog 391: a minted test spell must clear the server's cost floor (#360, m7.ts
  -- minSpellCost = max(1, floor(mag x max(dur,1) / 100))) or s147/s148/s156 never register.
  check('global.lua mpMintSpell prices the spell at the server cost floor',
    g:find('cost = math.max(1, math.floor(data.magnitude * math.max(1, data.duration or 1) / 100)),', 1, true) ~= nil
      and g:find('cost = 1,', 1, true) == nil,
    'a minted spell costs 1 and the cost floor refuses it')
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
  -- Backlog 275: a request or invite from someone in ANOTHER world only ever arrives in the
  -- FriendList snapshot, which rebuilt the panel in silence. Noticed once per acct.
  local fl = s:match('MP_FriendList = function%(data%)(.-)MP_FriendRequestReceived')
  check('social.lua MP_FriendList notices a newly present friend request and invite',
    fl ~= nil and fl:find("if not requestsSaid[acct] then", 1, true) ~= nil
    and fl:find("notice(tostring(name) .. ' sent you a friend request (O)')", 1, true) ~= nil
    and fl:find("if not invitesSaid[acct] then", 1, true) ~= nil
    and fl:find("notice(tostring(iv.name) .. ' invited you to join them (O)')", 1, true) ~= nil,
    'a cross-world request or invite is silent again')
  -- Backlog 276: AUTH_FAILED is not always a wrong password; the detail says which.
  check("global.lua does not blame every AUTH_FAILED on the password",
    g:find("AUTH_FAILED = 'sign-in was refused'", 1, true) ~= nil
    and g:find('if detail == why then detail = nil end', 1, true) ~= nil)
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
    and g:find("actorDeathFn = function%(obj%)%s+quests.onActorDeath%(obj%)") ~= nil)
  check('#110 an essential NPC death names sKilledEssential on every client, inside pcall',
    g:find("pcall%(function%(%)%s+if types.NPC.objectIsInstance%(obj%) and types.NPC.record%(obj%).isEssential then%s+notice%(core.getGMST%('sKilledEssential'%)%)") ~= nil)
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
  check('...and names its kind (t) so the server can check it (340)', pick ~= nil and pick.t == 'Lockpick', tostring(pick and pick.t))
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
  -- `types` is the chunk's only upvalue, in the engine's shape: Item.itemData(obj) is a FUNCTION
  -- on types.Item. Every reader used `obj.itemData`, which is nil on a real GameObject, so no
  -- condition, charge or soul ever left a client (s160 nil/nil/nil in #105).
  local fakeTypes = { Item = { itemData = function(it) return it.itemData end }, Actor = { inventory = function(obj) return obj end } }
  local ok, applyItemStates = pcall(function()
    return assert((loadstring or load)('local types = ...\n' .. applyChunk .. '\nreturn applyItemStates'))(fakeTypes)
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
      return assert((loadstring or load)('local types, worldmp = ...\n' .. snapChunk .. '\nreturn snapAvatarItemStates'))(fakeTypes, {})
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
  -- THE API SHAPE. mwlua/itemdata.cpp binds itemData as a function on types.Item; `obj.itemData`
  -- on a GameObject is nil, and every reader used that form (#105: s160 probed nil/nil/nil, the
  -- setcond: write threw inside its pcall, no wear/charge/soul ever reached the doc or a drop).
  local propReads = {}
  for _, f in ipairs({ 'global', 'identity', 'objects', 'player', 'avatar', 'puppet', 'actors', 'world' }) do
    local fh = io.open('./openmw/files/data/scripts/mp/' .. f .. '.lua')
    if fh then
      local body = fh:read('*a'); fh:close()
      for line in body:gmatch('[^\n]+') do
        local stripped = line:gsub('%-%-.*$', ''):gsub('types%.Item%.itemData', '')
        if stripped:find('%.itemData') then propReads[#propReads + 1] = f .. ': ' .. line end
      end
    end
  end
  check('every item-state reader calls types.Item.itemData(obj), never obj.itemData', #propReads == 0, table.concat(propReads, ' | '))
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

-- ============================================ backlog 453: the Follow activation gate
-- AiFollow::execute only ever turns mActive ON, and only while the leader is within
-- followDistance + 384 and in line of sight. A claim that arrives after the player has walked
-- off leaves the package permanently inactive and the companion rooted -- the peer log showed
-- "dest 1025 away; pos=(-12239,-70993,93)" repeating forever. companion.lua re-issues the
-- package once the leader is back in range; these pin the condition AND its bound, because an
-- unbounded re-issue would restart the package every poll for every NPC in every cell.
print('companion.lua -- a stalled Follow is re-issued when the leader comes back in range (453)')
do
  local cp = io.open('./openmw/files/data/scripts/mp/companion.lua'):read('*a')
  check('companion.lua re-issues a Follow only while the actor has NOT moved and the leader is in range',
    cp:find('local function reissueStalledFollow()', 1, true) ~= nil
      and cp:find('if moved then return end', 1, true) ~= nil
      and cp:find('if not okd or dist >= REISSUE_RANGE then return end', 1, true) ~= nil
      and cp:find("I.AI.startPackage({ type = 'Follow', target = target })", 1, true) ~= nil)
  check('the re-issue is bounded: MP only, at most one every few seconds, under the engine range',
    cp:find('if not (mpapi.isEnabled and mpapi.isEnabled()) then return end', 1, true) ~= nil
      and cp:find('if lastReissue and now - lastReissue < REISSUE_EVERY then return end', 1, true) ~= nil
      and tonumber(cp:match('local REISSUE_EVERY = (%d+)')) >= 2
      and tonumber(cp:match('local REISSUE_RANGE = (%d+)')) <= 450)
  check('it is driven from the 1 Hz poll, not from a bare onUpdate', cp:find('nextPoll = now + POLL', 1, true) < cp:find('            reissueStalledFollow()', 1, true))
  -- Escort is NOT re-issued: aiescort.cpp re-tests isInEscortRange every frame, so it resumes
  -- by itself -- and re-issuing it from here would need the destination, which only the
  -- holder's original claim carries.
  check('Escort is left alone (it has no activation latch, and its destination lives upstream)',
    cp:find("startPackage({ type = 'Escort'", 1, true) == nil)
end

print('actors.lua / global.lua -- scale: one actor scan per tick, chunked batches, a detach without the script is a no-op')
do
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  -- Backlog 267: the holder bucketed nothing and rescanned every active actor once per held
  -- cell per tick, with a fresh pcall closure per actor per read.
  check('actors.tick buckets activeActors by cell ONCE and hands each held cell its list',
    ac:find('local byCell = next(held) and actorsByCell() or nil', 1, true) ~= nil
    and ac:find('broadcastCell(cellKey, cell.epoch, cell, now, byCell[cellKey] or {})', 1, true) ~= nil
    and ac:find('local function broadcastCell(cellKey, epoch, cell, now, live)', 1, true) ~= nil)
  check('actorPose pcalls module-level functions, not per-actor closures',
    ac:find('pcall(speedsOf, obj)', 1, true) ~= nil
    and ac:find('pcall(stanceOf, obj)', 1, true) ~= nil
    and not ac:find('local function actorPose(obj).-pcall%(function'))
  -- Backlog 271: the wire count is a u8; a cell of 256+ actors left the rest frozen.
  check('broadcastCell sends a big cell as several batches of at most 255',
    ac:find('for i = 1, #batch, 255 do', 1, true) ~= nil
    and ac:find('mp.sendActorMoveBatch(epoch, { table.unpack(batch, i, math.min(i + 254, #batch)) })', 1, true) ~= nil)
  -- s125 (#90/#91): removeScript threw on a creature that no longer had puppet.lua.
  check('mpPuppetDetached is a no-op on a body without puppet.lua',
    g:find("obj:hasScript('scripts/mp/puppet.lua') then", 1, true) ~= nil
    and g:find("pcall(obj.removeScript, obj, 'scripts/mp/puppet.lua')", 1, true) ~= nil)
end

-- ============================================ backlog 256-263: the information layer
print('information layer -- journal dates, map memory, menus, levels (backlog 256-263)')
do
  local q = io.open('./openmw/files/data/scripts/mp/quests.lua'):read('*a')
  local w = io.open('./openmw/files/data/scripts/mp/world.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  -- 257: the dated log is replayed in order, through the stamping binding when it exists.
  check('JournalSync replays journalLog with ipairs before the quest map',
    (q:find("for _, e in ipairs(data.journalLog or {})", 1, true) or math.huge)
      < (q:find("for questId, index in pairs(data.quests or {})", 1, true) or 0))
  check('applyJournalEntry stamps through mp.addJournalEntryAt when present, else addJournalEntry',
    q:find('if stamp and mp.addJournalEntryAt then', 1, true) ~= nil
      and q:find('mp.addJournalEntryAt(questId, index, stamp.d, stamp.m, stamp.dm)', 1, true) ~= nil
      and q:find('quest:addJournalEntry(index)', 1, true) ~= nil)
  check('a pre-player entry keeps its stamp and order through the retry',
    q:find('for _, e in ipairs(retry) do applyJournalEntry(e.q, e.i, e.stamp) end', 1, true) ~= nil)
  -- 259: only a named exterior becomes a visited location.
  local h = w:match('handlers%.MP_WorldMapExplored = function%(data%)(.-)\nend')
  check('MP_WorldMapExplored skips unnamed cells', h ~= nil
    and h:find("local name = okc and cell and cell.name or ''", 1, true) ~= nil
    and h:find("if name ~= '' then", 1, true) ~= nil and not h:find('local name = key', 1, true))
  -- 260: the welcome record's explored keys ride the same handler.
  check('the rejoin restore replays record.explored through MP_WorldMapExplored',
    g:find('worldmp.handlers.MP_WorldMapExplored({ cellKeys = record.explored })', 1, true) ~= nil)
  -- 263: the use bit is masked in a menu; the harness's forced press is not.
  check('inputTick masks the use bit while a UI mode is open',
    p:find('pcall(function() inMenu = I.UI.getMode() ~= nil end)', 1, true) ~= nil
      and p:find('if (c.use and c.use ~= 0 and not inMenu) or now < forceUseUntil then flags = flags + 8 end', 1, true) ~= nil)
  -- 256: the harness can spend a level.
  check("player.lua answers levelup:<a,b,c> with mp.applyLevelup",
    p:find("cmd:match('^levelup:(.+)$')", 1, true) ~= nil and p:find('mp.applyLevelup(attrs)', 1, true) ~= nil)
end

print('actors.lua / objects.lua -- NPC fidelity: run bit from motion, the dead skip the grant, pitch streams, peer polls doors')
do
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  local ob = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  -- #286: types.Actor.isRunning does not exist; bit 0 comes from speed vs walk speed.
  check('actorPose sets the run bit from animVel, never from a nonexistent isRunning',
    ac:find('if animVel > 1.05 then flags = flags + 1 end', 1, true) ~= nil
    and not ac:find('pcall(isRunning', 1, true))
  -- #287: a dead snapshot entry is not teleported + re-killed at every re-anchor.
  check('the authority grant loop skips dead snapshot entries',
    ac:find('local obj = (not a.dead) and actorOf(a) or nil', 1, true) ~= nil)
  -- #291: the wire carries pitch; a flyer's pitch is read, not zeroed.
  check('actorPose streams the actor pitch',
    ac:find('pitch = obj.rotation:getPitch()', 1, true) ~= nil
    and not ac:find('pitch = 0,', 1, true))
  -- #289: the peer's 1 Hz poll reads door state over held cells and mutes network applies.
  check('the peer polls getDoorState over held cells and the DoorState apply mutes the poll',
    ob:find("sendAddressed('DoorState', obj, { open = open })", 1, true) ~= nil
    and ob:find('for _, c in ipairs(deps.heldCellsFn()) do addCell(c) end', 1, true) ~= nil
    and ob:find('doorStateWatch[obj.id] = data.open', 1, true) ~= nil
    and ac:find('function actors.heldCells()', 1, true) ~= nil)
end

print('melee depth -- armour/block progression rides the avatar, the stagger keeps the tap, the bar drop plays the blow (307, 309, 310)')
do
  local av = io.open('./openmw/files/data/scripts/mp/avatar.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  local cl = io.open('./openmw/files/data-mw/scripts/omw/combat/local.lua'):read('*a')
  local clm = io.open('./fsroot/resources/vfs-mw/scripts/omw/combat/local.lua'):read('*a')
  -- #307: the engine's combat script asks the avatar interface when it has no SkillProgression.
  check('omw/combat/local.lua routes an armour use to I.MPAvatar when SkillProgression is absent',
    cl:find('elseif I.MPAvatar then', 1, true) ~= nil and cl:find('I.MPAvatar.skillUsed(skillid, 0)', 1, true) ~= nil)
  check('the fsroot mirror of combat/local.lua is the same file', cl == clm)
  check('avatar.lua provides the MPAvatar interface and takes _onSkillUse',
    av:find("interfaceName = 'MPAvatar'", 1, true) ~= nil and av:find('skillUsed = forwardSkillUse', 1, true) ~= nil
    and av:find('_onSkillUse = forwardSkillUse', 1, true) ~= nil)
  local fam = av:match('local SKILL_USE_FORWARDED = (%b{})')
  check('avatar.lua forwards the armour/block family only',
    fam ~= nil and fam:find('block = true', 1, true) ~= nil and fam:find('unarmored = true', 1, true) ~= nil
    and fam:find('heavyarmor = true', 1, true) ~= nil and not fam:find('blade', 1, true)
    and av:find('if not SKILL_USE_FORWARDED[skillid] then return end', 1, true) ~= nil, tostring(fam))
  check('global.lua sends the use to the server as AvatarSkillUse with the owner id',
    g:find("mp.sendEvent('AvatarSkillUse', { id = id, skill = data.skill, useType = data.useType or 0 })", 1, true) ~= nil)
  check('player.lua counts MP_SelfSkillUse through I.SkillProgression',
    p:find('MP_SelfSkillUse = function(data)', 1, true) ~= nil
    and p:find('pcall(I.SkillProgression.skillUsed, data.skill, { useType = data.useType or 0 })', 1, true) ~= nil)
  -- #309: the use latch survives a stagger.
  check('avatar.lua keeps useLatch armed while the body is knocked down or in hit recovery',
    av:find('if not (mp.isKnockedDown and mp.isKnockedDown(self.object)) then useLatch = false end', 1, true) ~= nil
    and not av:find('\n            useLatch = false\n', 1, true))
  -- #310: the feel comes from the bar drop, never from the local roll.
  check('puppet.lua no longer plays the local roll (no miss sound at all)',
    not pp:find("playSound3d('miss'", 1, true) and pp:find('lastSwingAt = core.getRealTime()', 1, true) ~= nil)
  check('puppet.lua plays Health Damage on an hp drop and a hand-to-hand hit on a fatigue-only drop after a swing',
    pp:find("if hpDrop then", 1, true) ~= nil and pp:find("core.sound.playSound3d('Health Damage', self)", 1, true) ~= nil
    and pp:find("elseif ftDrop and recent then", 1, true) ~= nil
    and pp:find("'Hand To Hand Hit' or 'Hand To Hand Hit 2'", 1, true) ~= nil
    and pp:find('if recent and lastSwingPos and I.Combat and I.Combat.spawnBloodEffect then', 1, true) ~= nil)
  -- #325: the peer rules follow the LAST SimReady, not the join-time flag.
  check('global.lua peer rules read the last SimReady (325)',
    g:find('if lastSimReady ~= nil then simulated = lastSimReady end', 1, true) ~= nil
    and g:find('lastSimReady = (data and data.ready) == true', 1, true) ~= nil
    and g:find('lastSimReady = nil', 1, true) ~= nil)
  -- #328: a degraded puppet keeps its script and cancels every swing.
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  check('puppet.lua stays attached in degraded mode with the hit intercept armed (328)',
    pp:find('if degraded then return false end', 1, true) ~= nil
    and pp:find('MP_Detach = function(data)', 1, true) ~= nil
    and pp:find('degraded = data and data.degraded == true', 1, true) ~= nil
    and pp:find('if degraded then return end', 1, true) ~= nil
    and pp:find('actorKey = actorKey or degradedKey', 1, true) ~= nil
    and ac:find('for key in pairs(held) do detachActorPuppetsInCell(key, true) end', 1, true) ~= nil
    and ac:find("sendEvent('MP_Detach', { degraded = degraded == true })", 1, true) ~= nil)
  -- #330: the peer's per-player tables shrink on leave.
  check('global.lua drops avatarDocs and remoteIdentity on MP_PlayerLeaveWorld (330)',
    g:find('avatarDocs[data.id] = nil', 1, true) ~= nil and g:find('remoteIdentity[data.id] = nil', 1, true) ~= nil)
end

print('global.lua -- a stored cell that no longer exists falls back to the Welcome respawn (backlog 317)')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  check('restoreTick checks the stored cell exists before the teleport, and falls back to flags.respawn',
    g:find('if record.position and not cellExists(record.position.cellKey) then', 1, true) ~= nil
    and g:find('local fb = net.flags and net.flags.respawn', 1, true) ~= nil
    and (g:find('local function cellExists(cellKey)', 1, true) or math.huge)
      < (g:find('local function restoreTick()', 1, true) or 0))
  check('cellExists pcalls both the exterior and the named lookup',
    g:find('if gx then return world.getExteriorCell(gx, gy) end', 1, true) ~= nil
    and g:find('return world.getCellByName(cellKey)', 1, true) ~= nil)
  check('the player is told where they were moved',
    g:find("notice('Your last location no longer exists (a mod was removed); you were moved to '", 1, true) ~= nil)
end

-- Backlog 333-346 (adversarial review of the parallel commits): the client halves.
print('client -- review fixes 335/336/340/341/342/343/346 (source checks)')
do
  local q = io.open('./openmw/files/data/scripts/mp/quests.lua'):read('*a')
  local idn = io.open('./openmw/files/data/scripts/mp/identity.lua'):read('*a')
  local w = io.open('./openmw/files/data/scripts/mp/world.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local av = io.open('./openmw/files/data/scripts/mp/avatar.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  -- 335: the echo guard is a per-quest SET of applied stages, not one slot.
  check('quests.lua keeps a per-quest set of applied stages and drops their echoes (335)',
    q:find('applied[questId][index] = true', 1, true) ~= nil
    and q:find('if applied[questId] and applied[questId][stage] then return end', 1, true) ~= nil
    and q:find('\n    applied = {}\n', 1, true) ~= nil)
  -- 336: a refused declaration is forgotten at most 3 times per kind while it stands still.
  check('identity.lua caps forgetDeclared at 3 per kind until the fingerprint changes (336)',
    idn:find('local MAX_FORGETS = 3', 1, true) ~= nil and idn:find('if f.n > MAX_FORGETS then return end', 1, true) ~= nil
    and idn:find('\n    forgets = {}\n', 1, true) ~= nil)
  check('world.lua waits on a dependency only when it is in flight, and refuses an unsharable kind once (336)',
    w:find('if inFlight(enchant) then', 1, true) ~= nil and w:find('unsharable[localId] = true', 1, true) ~= nil
    and w:find('if unsharable[localId] or inFlight(localId) then return nil end', 1, true) ~= nil)
  -- 340: the item-state entry names its kind for the server.
  check('identity.lua sends the own-wear kind as t (340)', idn:find('st.t = OWN_WEAR_TYPES[t]', 1, true) ~= nil)
  -- 341: the ground read is an LObject call in avatar.lua; global.lua only prints.
  check('avatar.lua reads isOnGround on self and reports the landing (341)',
    av:find('pcall(types.Actor.isOnGround, self)', 1, true) ~= nil
    and av:find("core.sendGlobalEvent('mpAvatarLanded', { obj = self.object, top = fallTop, z = z })", 1, true) ~= nil
    and av:find('\n            fallProbe()\n', 1, true) ~= nil)
  check('global.lua no longer calls isOnGround on a GObject and prints from mpAvatarLanded (341)',
    not g:find('pcall(types.Actor.isOnGround, p.obj)', 1, true) and g:find('mpAvatarLanded = avatarLanded', 1, true) ~= nil
    and g:find("'[mp] avatar #%d landed from z=%d at z=%d (fell %d) hp=%s'", 1, true) ~= nil)
  -- 342: a player puppet is marked as such in the registry.
  check('puppet.lua marks a remote-player puppet with mp.setPlayerPuppet (342)',
    pp:find('if ok and on and playerId ~= nil and mp.setPlayerPuppet then', 1, true) ~= nil
    and pp:find('local playerId = nil', 1, true) < pp:find('local function markPuppet(on)', 1, true))
  -- 343: an arrest dialogue never asks for the conversation lock.
  check('player.lua skips mpDialogueForced for the Dialogue mode MP_PlayerArrest opened (343)',
    p:find('arrestDialoguePending = true', 1, true) ~= nil
    and p:find("if okNpc and isNpc and not arrest then core.sendGlobalEvent('mpDialogueForced'", 1, true) ~= nil)
  -- 346: `local net` no longer shadows the module in the out-mappers.
  check('global.lua has no `local net` shadowing the net module (346)',
    select(2, g:gsub('\n%s+local net = ', '')) == 0)
end

print('leftovers -- holder loss detaches everything, the holder\'s corpse is the loot, followers ride the retry, revive/effects/AI settings travel, the bark and the block (227, 229, 293-297, 312)')
do
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local ob = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  local q = io.open('./openmw/files/data/scripts/mp/quests.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local ws = io.open('./server/src/core/worldstate.ts'):read('*a')
  local lb = io.open('./openmw/apps/openmw/mwmp/luabindings.cpp'):read('*a')
  -- #295: a lost holder is the peer, gone everywhere: every puppet detaches, not one cell's.
  check('a holder-lost Info resets every puppet and the whole mirror',
    ac:find('for key in pairs(held) do detachActorPuppetsInCell(key, true) end', 1, true) ~= nil
    and ac:find("sendEvent('MP_Detach', { degraded = true })", 1, true) ~= nil)
  -- #297: the holder reports the corpse through the first-opener path the moment it dies.
  check('the death edge hands the corpse to objects.onCorpse, which arms a ContainerOpen',
    ac:find('if deps.corpseFn then pcall(deps.corpseFn, obj) end', 1, true) ~= nil
    and g:find('corpseFn = objects.onCorpse', 1, true) ~= nil
    and ob:find('function objects.onCorpse(obj)', 1, true) ~= nil
    and ob:find('containerOpenPending[obj.id] = { obj = obj, at = core.getRealTime() }', 1, true) ~= nil)
  -- #294: the retry carries the followers.
  check('tryTeleport takes onLanded and the retry tick fires it',
    g:find('local function tryTeleport(obj, cellArg, pos, onLanded)', 1, true) ~= nil
    and g:find('if t.onLanded then pcall(t.onLanded) end', 1, true) ~= nil
    and g:find('tryTeleport(p.obj, dest, util.vector3(data.x, data.y, data.z), carryFollowers)', 1, true) ~= nil)
  -- #293: the revive edge and its applier.
  check('the holder sends ActorRevive on the revive edge and clients apply it with mp.resurrect(obj)',
    ac:find("mp.sendEvent('ActorRevive', withAddr({ cellKey = cellKey, epoch = epoch }, obj))", 1, true) ~= nil
    and ac:find('actors.handlers.MP_ActorRevive = function(data)', 1, true) ~= nil
    and ac:find('pcall(mp.resurrect, obj)', 1, true) ~= nil
    and ws:find("'ActorDeath', 'ActorRevive'", 1, true) ~= nil
    and ws:find("if (name === 'ActorRevive') {", 1, true) ~= nil
    and lb:find('api["resurrect"] = [luaManager = context.mLuaManager](sol::optional<sol::object> who)', 1, true) ~= nil)
  -- #296: visible NPC magic travels by instance.
  check('the holder diffs visible actives into ActorEffects and puppets add/remove them',
    ac:find("mp.sendEvent('ActorEffects', withAddr({ cellKey = cellKey, epoch = epoch, add = add, remove = remove }, obj))", 1, true) ~= nil
    and ac:find('actors.handlers.MP_ActorEffects = function(data)', 1, true) ~= nil
    and ac:find('paralyze = true', 1, true) ~= nil
    and ws:find("'ActorCellChange', 'ActorEffects'", 1, true) ~= nil)
  -- #229: Fight/Flee/Alarm ride ActorDisposition from the holder and the talking client.
  check('AI settings ride ActorDisposition as `ai` and are applied to the base',
    ac:find('disposition = disp, ai = ai }', 1, true) ~= nil
    and ac:find('types.Actor.stats.ai[k](obj).base = math.floor(v)', 1, true) ~= nil
    and q:find('lockAi = deps.aiSettingsFn and deps.aiSettingsFn(obj) or nil', 1, true) ~= nil
    and q:find('deps.dispositionOutFn(obj, now, aiChanged and ai or nil)', 1, true) ~= nil
    and ws:find("const ai = body.get('ai');", 1, true) ~= nil)
  -- #227: the provoking shout on the puppet, through the new binding.
  check('MP_ActorAI combat rolls iVoiceAttackOdds into mp.say(obj, attack)',
    ac:find("mp.say(obj, 'attack')", 1, true) ~= nil and lb:find('api["say"]', 1, true) ~= nil)
  -- #385: the chargen sanctuary is the two vanilla cells by exact name, not any 'census'.
  check('isChargenCell exact-matches the two vanilla chargen cells in global.lua and objects.lua',
    g:find("return k == 'seyda neen, census and excise office' or k == 'imperial prison ship'", 1, true) ~= nil
    and ob:find("return k == 'seyda neen, census and excise office' or k == 'imperial prison ship'", 1, true) ~= nil
    and g:find("k:find('census', 1, true)", 1, true) == nil and ob:find("k:find('census', 1, true)", 1, true) == nil)
  -- #312: a block on the peer reaches the owner as a sound.
  check('the stats report drains mp.takeBlock and the owner plays it',
    g:find('mp.takeBlock and mp.takeBlock(p.obj)', 1, true) ~= nil
    and g:find('if entry.blk or avatarStatsLast[id] ~= key', 1, true) ~= nil
    and p:find("if type(data.blk) == 'string' then pcall(core.sound.playSound3d, data.blk, self) end", 1, true) ~= nil
    and lb:find('return takeBlockFor(ptr.getCellRef().getRefNum());', 1, true) ~= nil)
  -- #404: no MP_ChargenDone while a restore is still pending; the local is declared above it.
  check('chargenTick waits on pendingRestore, which is declared before it (404)',
    g:find('local pendingRestore = nil\n\nlocal function chargenTick()', 1, true) ~= nil
    and g:find('if pendingRestore then return end', 1, true) ~= nil
    and g:find('if pendingRestore then return end', 1, true) < g:find("mp.sendEvent('ChargenComplete', {})", 1, true)
    and select(2, g:gsub('local pendingRestore = nil', '')) == 1
    and p:find("if cmd == 'levelof' then", 1, true) ~= nil)
  -- #407: the first-dial grace is checked before UNREACHABLE gives up.
  local n = io.open('./openmw/files/data/scripts/mp/net.lua'):read('*a')
  check('UNREACHABLE_ATTEMPTS defers to the switchDeadline grace, 45 s on the first dial (407)',
    n:find('if not everJoined and reconnectAttempt >= UNREACHABLE_ATTEMPTS\n        and not (switchDeadline and core.getRealTime() < switchDeadline) then', 1, true) ~= nil
    and n:find('if switchDeadline == nil then switchDeadline = core.getRealTime() + 45 end', 1, true) ~= nil)
end

print('UX rows -- social OK lines reach the feed, the late host hears who went home, a guest\'s Rest is refused before the bed lies (29, 32, 262)')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local s = io.open('./openmw/files/data/scripts/mp/social.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a'):gsub('\r\n', '\n')
  local srv = io.open('./server/src/server.ts'):read('*a')
  -- #32: "Invitation sent." / "Sent home." / "Friend request sent." used to stay in the panel.
  local handler = s:match('MP_SocialResult = function%(data%)(.-)mp%.set')
  check('MP_SocialResult notices OK results too, machinery excepted',
    handler ~= nil and handler:find('if not SOCIAL_SILENT[data.op] then notice(status) end', 1, true) ~= nil
      and handler:find('if data.ok ~= true then notice(status) end', 1, true) == nil)
  -- #29: the grace expiry records the names; hostOf hands them to the owner once.
  check('server.ts records the guests the grace sent home and WorldMode carries them once to the owner',
    srv:find('guestsSentHome = { at: Date.now(), names }', 1, true) ~= nil
      and srv:find('if (sentHome) guestsSentHome = undefined;', 1, true) ~= nil)
  check('global.lua narrates the sent-home guests to the returning owner',
    g:find("notice('Your guests were sent home while you were away: ' .. table.concat(data.sentHome, ', ') .. '.')", 1, true) ~= nil)
  -- #262: WorldMode carries the rest rule; a guest's Rest window is refused on open and the
  -- pending level-up is offered instead (the sleep that would have offered it never happens).
  check('WorldMode carries timeSkip and global.lua forwards it to player.lua',
    srv:find('timeSkip: worldOwner === ', 1, true) ~= nil
      and g:find("toPlayer('MP_WorldMode', { isOwner = data and data.isOwner == true, timeSkip =", 1, true) ~= nil
      and p:find('MP_WorldMode = function(data)', 1, true) ~= nil)
  check("a guest's Rest under timeSkip=owner is closed with a notice and the level-up offered",
    p:find("if data.newMode == 'Rest' and restRefusedHere() then", 1, true) ~= nil
      and p:find("I.UI.removeMode('Rest')", 1, true) ~= nil
      and p:find("text = 'Only the world owner can rest for everyone.'", 1, true) ~= nil
      and p:find("types.Actor.stats.level(self).progress >= (tonumber(core.getGMST('iLevelUpTotal')) or 10)", 1, true) ~= nil
      and p:find("I.UI.addMode('LevelUp')", 1, true) ~= nil)
  -- The rule itself, executed: only a non-owner under owner/party is refused here.
  local chunk = p:match('(local restRule = .-\nend\n)')
  local restRefusedHere = chunk and assert((loadstring or load)(chunk .. '\nreturn function(o, t) restRule = { isOwner = o, timeSkip = t }; return restRefusedHere() end'))()
  check('restRefusedHere: guest+owner refused, owner never, anyone never',
    restRefusedHere ~= nil and restRefusedHere(false, 'owner') == true and restRefusedHere(false, 'party') == true
      and restRefusedHere(true, 'owner') == false and restRefusedHere(false, 'anyone') == false and restRefusedHere(false, 'off') == false)
end

print('recv watchdog, the dead do not talk, svc:open, threat.lua gone, same-cell snap is not a door, revive in place (31, 33, 34, 76, 138, 231)')
do
  local n = io.open('./openmw/files/data/scripts/mp/net.lua'):read('*a')
  local idn = io.open('./openmw/files/data/scripts/mp/identity.lua'):read('*a')
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  -- #31: a half-open socket never fires onClose; the client hangs up itself when nothing
  -- has arrived for 75 s, and onClose (state == Joined) redials.
  check('net.lua stamps lastRecvAt on open and on every frame, and hangs up after 75 s of silence while Joined',
    n:find('local RECV_TIMEOUT_SECONDS = 75', 1, true) ~= nil
    and n:find('function net.onOpen()\n    lastRecvAt = core.getRealTime()', 1, true) ~= nil
    and n:find('function net.onJson(str)\n    lastRecvAt = core.getRealTime()', 1, true) ~= nil
    and n:find("if net.state ~= 'Joined' then return end\n    if now - lastRecvAt > RECV_TIMEOUT_SECONDS then", 1, true) ~= nil
    and n:find('mp.disconnect() -- onClose sees state == Joined and schedules the redial', 1, true) ~= nil)
  -- #33: the death edge closes the conversation client-side; the server drops the lock too
  -- (quests.test.ts "the holder dying releases the lock").
  check('identity.lua closes the Dialogue window on the death edge',
    idn:find("mp.sendEvent('PlayerDeath', {})", 1, true) ~= nil
    and idn:find("mp.sendEvent('PlayerDeath', {})", 1, true) < idn:find("pcall(function() I.UI.removeMode('Dialogue') end)", 1, true))
  -- #34: svc:open:<Mode>[:<recordId>] / svc:close:<Mode>; barter:open/close stay as aliases.
  check('player.lua opens any service window through svc:open and keeps barter:open as its alias',
    p:find('local SERVICE_MODES = { Barter = true, Training = true, Travel = true, SpellCreation = true, Enchanting = true }', 1, true) ~= nil
    and p:find("if cmd == 'barter:open' then svcMode = 'Barter'", 1, true) ~= nil
    and p:find("svcMode, wantMerchant = cmd:match('^svc:open:(%a+):?(.*)$')", 1, true) ~= nil
    and p:find('I.UI.addMode(svcMode, { target = best })', 1, true) ~= nil
    and p:find("local closeMode = cmd == 'barter:close' and 'Barter' or cmd:match('^svc:close:(%a+)$')", 1, true) ~= nil
    and p:find('I.UI.removeMode(closeMode)', 1, true) ~= nil)
  -- #76: threat.lua was dead code (the relayed CombatHit shape never matched); gone with its
  -- call sites and its CMake entry.
  local cm = io.open('./openmw/files/data/CMakeLists.txt'):read('*a')
  check('threat.lua is gone and nothing requires it',
    io.open('./openmw/files/data/scripts/mp/threat.lua') == nil
    and cm:find('threat.lua', 1, true) == nil)
  for _, f in ipairs({ 'actors', 'combat', 'global', 'player', 'quests', 'puppet', 'avatar' }) do
    local src = io.open('./openmw/files/data/scripts/mp/' .. f .. '.lua'):read('*a')
    check(f .. ".lua does not require('scripts.mp.threat')", src:find("require('scripts.mp.threat')", 1, true) == nil)
  end
  -- #231/#74: a same-cell snap within SNAP_DIST is walked, not a door: no tryTeleport, so no
  -- land(false) zeroing the avatar's fall height mid-fall.
  check('MP_PlayerCellChange treats a same-cell snap within SNAP_DIST as walked',
    g:find('local sameCell = prevCell == data.cellKey', 1, true) ~= nil
    and g:find('local walked = (sameCell or (parseExteriorKey(prevCell) ~= nil and parseExteriorKey(data.cellKey) ~= nil))\n                    and (from - util.vector3(data.x, data.y, data.z)):length2() <= 256 * 256', 1, true) ~= nil
    and g:find('if walked then return end', 1, true) ~= nil)
  -- #138: revive in place through the per-actor resurrect (#293), on the peer and on clients.
  check('revivePuppet resurrects the standing body, moves it to the pose, clears the dead latch and pushes the bars',
    g:find('local function revivePuppet(id, cellArg, pose)', 1, true) ~= nil
    and g:find('pcall(mp.resurrect, p.obj)\n    if pose then tryTeleport(p.obj, cellArg, util.vector3(pose.x, pose.y, pose.z)) end\n    pcall(function() p.obj:sendEvent(\'MP_Revive\', {}) end)\n    pushStatsToPuppet(id)', 1, true) ~= nil
    and g:find('revivePuppet(data.id, remoteCell[data.id] and inviteCellArg(remoteCell[data.id]), pose)', 1, true) ~= nil
    and g:find('revivePuppet(data.id, destCellArg(), lastPose[data.id])', 1, true) ~= nil
    and g:find('THERE IS NO PER-ACTOR RESURRECT', 1, true) == nil)
end

-- ============================================================ net.lua: locker sha256 (backlog 299)
-- A locker boot knows each plugin's sha256 (the page hands them over as name=sha pairs); the
-- SessionHello manifest must carry them, matched case-insensitively, and omit the field for
-- anything the page could not hash so `names` worlds see exactly the old shape.
print('net.lua — manifest sha256 from the page')
do
  fresh()
  local env = stubs.install({ contentFiles = { 'builtin.omwscripts', 'Morrowind.esm', 'TR_Mainland.esm' },
    contentHashes = 'morrowind.esm=' .. string.rep('a', 64) .. ';tr_mainland.esm=' .. string.rep('b', 64) })
  local net = require('scripts.mp.net')
  local json = require('scripts.mp.json')
  net.onOpen()
  local hello
  for _, raw in ipairs(env.calls.json) do local m = json.decode(raw); if m.t == 'SessionHello' then hello = m end end
  check('SessionHello was sent', hello ~= nil)
  local m = hello and hello.manifest or {}
  check('a hashed plugin carries its sha256 regardless of name case',
    m[2] and m[2].name == 'Morrowind.esm' and m[2].sha256 == string.rep('a', 64)
    and m[3] and m[3].sha256 == string.rep('b', 64), hello and json.encode(m) or 'no hello')
  check('an unhashed file carries no sha256 field', m[1] and m[1].name == 'builtin.omwscripts' and m[1].sha256 == nil)
  fresh()
  env = stubs.install({ contentFiles = { 'Morrowind.esm' } })
  net = require('scripts.mp.net')
  net.onOpen()
  local plain
  for _, raw in ipairs(env.calls.json) do local d = json.decode(raw); if d.t == 'SessionHello' then plain = d end end
  check('no page hashes = the old manifest shape', plain and plain.manifest[1].sha256 == nil)
end

print('creature swings, peer-run scripts, topics/talked-to persisted, AI done, avatar factions, crime witnesses (288, 217, 51, 230, 221, 145, 146)')
do
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local q = io.open('./openmw/files/data/scripts/mp/quests.lua'):read('*a')
  local idn = io.open('./openmw/files/data/scripts/mp/identity.lua'):read('*a')
  local ws = io.open('./server/src/core/worldstate.ts'):read('*a')
  local qs = io.open('./server/src/core/quests.ts'):read('*a')
  local ps = io.open('./server/src/core/playerstate.ts'):read('*a')
  local lb = io.open('./openmw/apps/openmw/mwmp/luabindings.cpp'):read('*a')
  local snd = io.open('./openmw/apps/openmw/mwscript/soundextensions.cpp'):read('*a')
  local ai = io.open('./openmw/apps/openmw/mwmechanics/aisequence.cpp'):read('*a')
  local mm = io.open('./openmw/apps/openmw/mwmechanics/mechanicsmanagerimp.cpp'):read('*a')
  local cb = io.open('./openmw/apps/openmw/mwmechanics/combat.cpp'):read('*a')
  -- #288: the holder samples the AI's attack window into bit 3; creature puppets swing attack1..3.
  check('the holder sets the use bit from mp.isAttacking/spellcast and creature puppets play attack1..3',
    ac:find('if okU and using then flags = flags + 8 end', 1, true) ~= nil
    and ac:find("isPlaying(obj, 'spellcast')", 1, true) ~= nil
    and lb:find('api["isAttacking"]', 1, true) ~= nil
    and pp:find("anim.hasGroup(self, 'attack' .. i)", 1, true) ~= nil
    and pp:find("startKey = 'max attack', stopKey = 'stop'", 1, true) ~= nil)
  -- #217: the peer watches every scripted object in a held cell; a scripted Say is relayed.
  check('the peer arms open-ended member watches over held cells, with the cell key on the wire',
    g:find('heldCellsFn = function() return actors.heldCells() end, -- #217', 1, true) ~= nil
    and q:find('local function armHeldWatches(now)', 1, true) ~= nil
    and q:find('poll = HELD_WATCH_POLL, until_ = math.huge,', 1, true) ~= nil
    and q:find('value = value, cellKey = watch.cellKey }', 1, true) ~= nil
    and qs:find("(player.system === true && str(body.get('cellKey'))) || player.cellKey", 1, true) ~= nil)
  check('OpSay on the peer becomes ActorSay and puppets core.sound.say the line',
    snd:find('MWMP::recordScriptNote({ "say"', 1, true) ~= nil
    and g:find("elseif n.kind == 'say' then", 1, true) ~= nil
    and ac:find("mp.sendEvent('ActorSay', body)", 1, true) ~= nil
    and ac:find('actors.handlers.MP_ActorSay = function(data)', 1, true) ~= nil
    and ac:find('pcall(core.sound.say, data.file, obj', 1, true) ~= nil
    and ws:find("'ActorEffects', 'ActorSay'", 1, true) ~= nil)
  -- #51: topics persist on the journal's doc and ride JournalSync through applyTopics.
  check('TopicsLearned is persisted (doc.topics) and JournalSync replays it via applyTopics',
    qs:find('doc.topics = [...set].slice(-MAX_TOPICS);', 1, true) ~= nil
    and qs:find("sendEvent('JournalSync', { quests, borrowed, journalLog, topics })", 1, true) ~= nil
    and q:find("if type(data.topics) == 'table' then quests.applyTopics(data.topics) end", 1, true) ~= nil)
  -- #230: TalkedToPc read/written through the binding, persisted, re-applied by object id.
  check('talked-to NPCs are reported, persisted and re-flagged on relog',
    lb:find('api["talkedTo"]', 1, true) ~= nil and lb:find('api["setTalkedTo"]', 1, true) ~= nil
    and idn:find("mp.sendEvent('PlayerTalkedTo', { list = fresh })", 1, true) ~= nil
    and idn:find('elseif ok and not said and talkedTo[obj.id] then', 1, true) ~= nil
    and idn:find('function identity.applyTalkedTo(list)', 1, true) ~= nil
    and ps:find('PlayerTalkedTo: handleTalkedTo,', 1, true) ~= nil
    and g:find('MP_SelfTalkedTo = function(data)', 1, true) ~= nil)
  -- #221: the holder's package completion reaches the puppet's flag.
  check('AiSequence completion is noted on the holder and written onto puppets',
    ai:find('{ "aidone", actor.getCellRef().getRefNum()', 1, true) ~= nil
    and ac:find('function actors.noteAiDone(n)', 1, true) ~= nil
    and ac:find('if puppetActors[refKeyOf(obj)] and mp.setAiPackageDone then pcall(mp.setAiPackageDone, obj) end', 1, true) ~= nil
    and lb:find('api["setAiPackageDone"]', 1, true) ~= nil)
  -- #145: disposition toward an avatar reads the avatar; the doc's factions land on it.
  check('getFightTerm reads disposition toward the avatar and AvatarState applies factions',
    cb:find('getDerivedDisposition(actor, avatar ? target : MWWorld::Ptr())', 1, true) ~= nil
    and mm:find('MWWorld::Ptr playerPtr = towardAvatar ? toward : getPlayer();', 1, true) ~= nil
    and lb:find('api["setAvatarFactions"]', 1, true) ~= nil
    and g:find('mp.setAvatarFactions(obj, list)', 1, true) ~= nil)
  -- #146: a witness that picked a fight on the thief's client is claimed to the holder.
  check("a client's crime-combat witness is claimed as ActorAI combat+crime and the server admits it",
    mm:find('MWMP::recordScriptNote({ "crimecombat"', 1, true) ~= nil
    and ac:find('combat = me, crime = true }, obj)', 1, true) ~= nil
    and ws:find("const crime = body.get('crime') === true;", 1, true) ~= nil
    and ws:find('(!crime && this.dialogueHolder?.(ref.key) !== player.id)', 1, true) ~= nil)
end

print('#413 script notes are metered, not drained in one burst')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  check('scriptNotesTick queues notes and sends at most NOTE_SENDS_PER_SEC a second',
    g:find('local NOTE_SENDS_PER_SEC = 20', 1, true) ~= nil
    and g:find('for _, n in ipairs(notes) do pendingNotes[#pendingNotes + 1] = n end', 1, true) ~= nil
    and g:find('while #pendingNotes > 0 and noteSendCount < NOTE_SENDS_PER_SEC do', 1, true) ~= nil)
  local c = io.open('./openmw/apps/openmw/mwmp/puppets.cpp'):read('*a')
  check('recordScriptNote keeps one pending aidone per ref',
    c:find('if (pending.mKind == "aidone" && pending.mRef == note.mRef)', 1, true) ~= nil)
end

print('#414 armHeldWatches probes script.variables with pairs, never next')
do
  local q = io.open('./openmw/files/data/scripts/mp/quests.lua'):read('*a')
  check('quests.lua never calls next() on script.variables (userdata)', q:find('next(script.variables)', 1, true) == nil
    and q:find('for _ in pairs(script.variables) do hasVars = true; break end', 1, true) ~= nil)
end

print('#430 the peer body cannot die and never claims a fight for a cell it does not hold')
do
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  check('player.lua keeps the system peer in god mode from inputTick',
    p:find("local dbg = require('openmw.debug')", 1, true) ~= nil
    and p:find('if not dbg.isGodMode() then dbg.toggleGodMode() end', 1, true) ~= nil)
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  check('noteCombat: a non-holder "fights ME" claim never leaves the system peer',
    ac:find('if foeId == nil or foeId ~= own or (mp.isSystem and mp.isSystem()) then return end', 1, true) ~= nil)
end

print('#431 a fresh holder streams no bars for a cell until the world record has answered')
do
  local ac = io.open('./openmw/files/data/scripts/mp/actors.lua'):read('*a')
  check('broadcastCell gates ActorStatsDynamic on cell.recorded',
    ac:find('if cell.recorded and (not tracked.nextStats or now >= tracked.nextStats) then', 1, true) ~= nil)
  check('noteCellDeaths marks the cell recorded only after the post-load ResyncRequest',
    ac:find('if held[cellKey] and held[cellKey].resynced then held[cellKey].recorded = true end', 1, true) ~= nil)
  local ob = io.open('./openmw/files/data/scripts/mp/objects.lua'):read('*a')
  check('MP_WorldCellState hands the record to the holder even with no deaths in it',
    ob:find('if deps.cellDeathsFn then deps.cellDeathsFn(data.cellKey, data.deaths or {}) end', 1, true) ~= nil
    and ob:find('#data.deaths > 0 then deps.cellDeathsFn', 1, true) == nil)
end

print('#432 the peer says what a forwarded spell hit did')
do
  local c = io.open('./openmw/files/data/scripts/mp/combat.lua'):read('*a')
  check('MP_CombatSpellHit prints resolved victim and hp on the system peer',
    c:find('[mp] CombatSpellHit on peer: spell=%s net=%s ref=%s cell=%s resolved=%s hp=%s', 1, true) ~= nil)
end

print('#460 the harness rest reports what it healed, so the claim needs no read (s150 in #111/#114/#115/#116)')
do
  -- Three tries. Inline, the rest lost to the MP_SelfStats write queued earlier in the frame;
  -- queued (addAction) it lost to the write queued LATER in the same frame one time in three
  -- (#116: own bar 35, claim 35+0). Either way the read that measures the raise sees the
  -- report. So restHours runs inline on the real stat and RETURNS the raise; player.lua banks
  -- it into identity (bankGain) and nothing is read.
  local lb = io.open('./openmw/apps/openmw/mwmp/luabindings.cpp'):read('*a')
  local pl = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local body = lb:match('api%["restHours"%](.-)api%["getLoginTicket"%]')
  check('mp.restHours rests inline and returns the hp/mp/ft it healed',
    body ~= nil and body:find('luaManager->addAction(', 1, true) == nil
    and body:find('getMechanicsManager()->rest(1, sleep)', 1, true) ~= nil
    and body:find('res["hp"] = stats.getHealth().getCurrent() - hp0', 1, true) ~= nil)
  check('player.lua banks what the rest healed into the claim',
    pl:find('local ok, healed = pcall(function() return mp.restHours(tonumber(sleepHours), true) end)', 1, true) ~= nil
    and pl:find("if ok and type(healed) == 'table' then identity.bankGain(healed) end", 1, true) ~= nil)
end
print('#461 a client heal reaches the avatar in full: the claim carries the GAIN, not the bar')
do
  -- THE LADDER (s165: a 10x5 restore landed +6..+10 of 50; s150: a rest +0). identity.lua
  -- claimed `last report + gain`; the server applied a claim only if it was ABOVE the doc.
  -- After the first raise landed, every claim until the avatar's next report came back was
  -- built on the OLD report -- below the doc, ignored as an echo -- and the client had
  -- already zeroed the gain it was built from. Here the real identity.lua runs against a
  -- model of the peer round trip (report on change, LAT frames each way) and a server that
  -- applies `d` on top of its doc; the heal must land whole, and a peer-authored drop
  -- between two claims must not be undone by them.
  fresh()
  env = stubs.install({})
  identity = require('scripts.mp.identity')
  identity.markBaselineReady()
  local LAT, dt = 2, 0.2
  local doc, avatar, reports, restores, t = 35, 35, {}, {}, 0
  local lastKey, lastAt = nil, -10
  env.dyn.health.base = 95
  env.dyn.health.current = 35
  local function serverApply(body)
    local hp = body.hp
    if not hp then return end
    -- playerstate.ts raise(): `d` on top of the doc when present, else the absolute bar
    local want = math.min(hp.d ~= nil and (doc + math.max(0, hp.d)) or hp.c, 95)
    if want > doc + 0.5 then doc = want; restores[#restores + 1] = { at = t + LAT * dt, hp = doc } end
  end
  local function frame(heal)
    identity.tick(t)
    for _, c in ipairs(env.calls.events) do if c.name == 'PlayerStatsDynamic' then serverApply(c.body) end end
    env.calls.events = {}
    if heal then env.dyn.health.current = math.min(95, env.dyn.health.current + heal) end
    for i = #restores, 1, -1 do if restores[i].at <= t then avatar = restores[i].hp; table.remove(restores, i) end end
    local key = string.format('%.1f', avatar)
    if key ~= lastKey or t - lastAt >= 3 then lastKey, lastAt = key, t; reports[#reports + 1] = { at = t + 2 * LAT * dt, hp = avatar } end
    for i = #reports, 1, -1 do
      if reports[i].at <= t then
        identity.notePeerBars(reports[i].hp, 50, 100); env.dyn.health.current = reports[i].hp; table.remove(reports, i)
      end
    end
    t = t + dt; env.advance(dt)
  end
  for _ = 1, 10 do frame() end
  for _ = 1, 25 do frame(2) end -- a 10/s restore for 5 s at 5 fps: +50
  for _ = 1, 30 do frame() end
  check('a 50-point restore over 5 s reaches the avatar whole (461: it landed +6..+10)',
    avatar >= 84 and avatar <= 86, 'avatar=' .. tostring(avatar))
  -- The peer hurts us between two claims: the report is lower, and the next local gain is
  -- claimed on top of the BITE, not on top of the bar we had before it.
  avatar = 60; doc = 60
  for _ = 1, 20 do frame() end
  for _ = 1, 5 do frame(2) end -- +10 local
  for _ = 1, 20 do frame() end
  check('a peer-authored drop stays, and the gain after it lands on the dropped bar', avatar >= 69 and avatar <= 71, 'avatar=' .. tostring(avatar))
  -- s150's shape: one +24 in a frame the peer's word has gone stale (a long rest frame, no
  -- report processed for PEER_RULES_S). The client-authoritative snapshot used to zero the
  -- gain; it must carry it as `d` too, since the server may still be inside its own window.
  fresh()
  env = stubs.install({})
  identity = require('scripts.mp.identity')
  identity.markBaselineReady()
  env.dyn.health.base = 95
  env.dyn.health.current = 35
  identity.notePeerBars(35, 50, 100)
  identity.tick(0)
  env.calls.events = {}
  env.advance(6); env.dyn.health.current = 59 -- the rest landed; the last report is 6 s old
  identity.tick(6)
  local snap
  for _, c in ipairs(env.calls.events) do if c.name == 'PlayerStatsDynamic' then snap = c.body end end
  check('the stale-peer snapshot says the gain too (460: the rest\'s +24 was zeroed unsaid)',
    snap ~= nil and snap.hp and snap.hp.c == 59 and snap.hp.d == 24, snap and snap.hp and ('c=' .. tostring(snap.hp.c) .. ' d=' .. tostring(snap.hp.d)) or 'no snapshot')
  check('the mirror names the last hp claim for the scenarios', env.calls.testSet['hpClaim'] == '59+24', tostring(env.calls.testSet['hpClaim']))
  -- #116's shape (460, third try): the rest and a peer report land in the SAME frame, and
  -- the report's write wins the local bar before any read sees the raise -- the local bar
  -- reads 35 after a rest that healed 24. restHours returns what it healed and player.lua
  -- banks it; the claim must carry the 24 with nothing to measure.
  fresh()
  env = stubs.install({})
  identity = require('scripts.mp.identity')
  identity.markBaselineReady()
  env.dyn.health.base = 95
  env.dyn.health.current = 35
  identity.notePeerBars(35, 50, 100)
  identity.tick(0)
  env.calls.events = {}
  identity.bankGain({ hp = 24, mp = 0, ft = 12 }) -- the rest, as restHours reported it
  identity.notePeerBars(35, 50, 100) -- the same-frame report: the local bar stays 35
  env.dyn.health.current = 35
  env.advance(0.3); identity.tick(0.3)
  local banked
  for _, c in ipairs(env.calls.events) do if c.name == 'PlayerStatsDynamic' then banked = c.body end end
  check('a banked rest is claimed although the local bar never showed it (460, #116: 35+0)',
    banked ~= nil and banked.hp and banked.hp.d == 24, banked and banked.hp and ('c=' .. tostring(banked.hp.c) .. ' d=' .. tostring(banked.hp.d)) or 'no claim')
  -- ...and once: the per-frame tracker must not count the same raise again when it does see it.
  env.calls.events = {}
  identity.notePeerBars(59, 50, 100) -- the AvatarRestore came back (noted, THEN written, as MP_SelfStats does)
  env.dyn.health.current = 59
  env.advance(0.3); identity.tick(0.6)
  local twice = false
  for _, c in ipairs(env.calls.events) do if c.name == 'PlayerStatsDynamic' and c.body.hp and (c.body.hp.d or 0) > 0 then twice = true end end
  check('the banked gain is not claimed a second time', not twice)
end

print('#480 a puppet stops following after a far teleport: only the tracked body answers, and it stands in a loaded cell')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  local pp = io.open('./openmw/files/data/scripts/mp/puppet.lua'):read('*a')
  check('puppet.lua names the asking body on every mpSnapRequest',
    pp:find('{ id = playerId, actorKey = actorKey, obj = self.object, x = target.x', 1, true) ~= nil)
  check('global.lua mpSnapRequest ignores a snap from a body it does not track',
    g:find('if p and data.obj ~= nil and p.obj ~= data.obj then return end', 1, true) ~= nil)
  check('despawnPuppet retries a remove() refused mid-teleport instead of forgetting the body',
    g:find('if p.obj:isValid() and not pcall(function() p.obj:remove() end) then', 1, true) ~= nil
    and g:find('removeRetry[p.obj] = core.getRealTime() + 30', 1, true) ~= nil
    and g:find('removeRetryTick(now) -- a despawn refused mid-teleport lands now (480)', 1, true) ~= nil)
  check('spawnPuppet skips a pose outside the loaded neighbourhood (a lagging avatar two cells back)',
    g:find('if not poseInView(pose) then return end', 1, true) ~= nil
    and g:find("visibleFrom(ownCellKeyCache, math.floor(pose.x / 8192) .. ',' .. math.floor(pose.y / 8192))", 1, true) ~= nil)
  -- The cell arithmetic itself, run: floor, not truncation, or every negative cell is off by one.
  local key = function(x, y) return math.floor(x / 8192) .. ',' .. math.floor(y / 8192) end
  check('the pose cell key floors like ESM::positionToExteriorCellLocation',
    key(-12288, -69632) == '-2,-9' and key(-12500, -53100) == '-2,-7' and key(-1, -1) == '-1,-1' and key(0, 8191) == '0,0')
end

print('#481 the overlay hold leaves the engine in Interface when on and off drain in one frame')
do
  -- The REAL omw/ui.lua against a model of the engine's deferral: _setUiModeStack is a delayed
  -- action (uibindings.cpp addAction) and the _onUiModeChanged callback lands after it, so
  -- I.UI's own stack mirror learns of a setMode only on the next frame.
  local engine, queued = {}, {}
  local uiStub = {
    _getAllUiModes = function() return { Interface = 'Interface', Dialogue = 'Dialogue' } end,
    _getAllWindowIds = function() return {} end,
    _getAllowedWindows = function() return {} end,
    _setWindowDisabled = function() end,
    _setUiModeStack = function(modes) local c = {}; for i, m in ipairs(modes) do c[i] = m end; queued[#queued + 1] = c end,
    _getUiModeStack = function() return engine end,
  }
  local saved = {}
  for _, m in ipairs({ 'openmw.ui', 'openmw.util', 'openmw.self', 'openmw.core', 'openmw.ambient' }) do saved[m] = package.loaded[m] end
  package.loaded['openmw.ui'] = uiStub
  package.loaded['openmw.util'] = { makeReadOnly = function(t) return t end, makeStrictReadOnly = function(t) return t end }
  package.loaded['openmw.self'] = { sendEvent = function() end }
  package.loaded['openmw.core'] = { sendGlobalEvent = function() end }
  package.loaded['openmw.ambient'] = { playSound = function() end, isSoundPlaying = function() return false end }
  local omwui = assert(loadfile('./openmw/files/data/scripts/omw/ui.lua'))()
  for m, v in pairs(saved) do package.loaded[m] = v end
  local function frame()
    if #queued == 0 then return end
    engine = queued[#queued]; queued = {}
    omwui.engineHandlers._onUiModeChanged(true)
  end
  -- player.lua's own uimode handler, cut from the source so the test runs what ships.
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local s = p:find("local ui_mode = cmd:match('^uimode:(%a+)$')", 1, true)
  local _, e = p:find("I.UI.removeMode('Interface') end", s, true)
  local src = p:sub(s, e)
  local function runner(chunkSrc)
    return function(cmd)
      local env = { I = { UI = omwui.interface }, cmd = cmd, pcall = pcall }
      setfenv(assert(loadstring(chunkSrc)), env)()
    end
  end
  local run = runner(src)
  run('uimode:on'); frame()
  check('uimode:on puts the engine in Interface', engine[1] == 'Interface' and omwui.interface.getMode() == 'Interface')
  -- Escape, then O, then Escape, all before the next frame drains the queue (s99 step 4 in
  -- #117 at the harness frame rate; a quick T-Escape in play).
  run('uimode:off'); run('uimode:on'); run('uimode:off'); frame()
  check('off/on/off in one frame leaves no mode on the engine', #engine == 0 and omwui.interface.getMode() == nil)
  run('uimode:on'); run('uimode:off'); frame()
  check('on/off in one frame leaves no mode on the engine', #engine == 0 and omwui.interface.getMode() == nil)
  -- The regression, run: the setMode this replaced never told the mirror, so the same drain
  -- stuck the engine in Interface.
  local stuck = runner((src:gsub("I%.UI%.addMode%('Interface'", "I.UI.setMode('Interface'")))
  stuck('uimode:on'); stuck('uimode:off'); frame()
  check("(proof) setMode + removeMode in one frame left the engine in Interface -- the #117 trace",
    engine[1] == 'Interface')
  omwui.interface.setMode(); frame()
  -- A window the engine had open underneath (a reconnect hold over a dialogue) is kept.
  engine = { 'Dialogue' }; omwui.engineHandlers._onUiModeChanged(false)
  run('uimode:on'); frame()
  check('the hold stacks on an engine window instead of replacing it', omwui.interface.getMode() == 'Interface' and engine[1] == 'Dialogue')
  run('uimode:off'); frame()
  check('releasing the hold hands the engine window back', omwui.interface.getMode() == 'Dialogue' and #engine == 1)
end

print('#482 snapto lands on the ground: a hard-coded z under the terrain no longer drops the body into the sea')
do
  local p = io.open('./openmw/files/data/scripts/mp/player.lua'):read('*a')
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  -- The snapto handler, cut from the source and run against a recording core.
  local s = p:find("local snX, snY, snZ = cmd:match('^snapto:", 1, true)
  local _, e = p:find("onGround = true })\n        end", s, true)
  local sent = {}
  local env = { tonumber = tonumber, cmd = 'snapto:-12500,-53100,512',
    core = { sendGlobalEvent = function(name, body) sent[#sent + 1] = { name = name, body = body } end } }
  setfenv(assert(loadstring(p:sub(s, e))), env)()
  check('snapto asks the global snap for onGround (s170 SPOT z=512 is 360 u under the LAND surface)',
    #sent == 1 and sent[1].name == 'mpSelfSnap' and sent[1].body.onGround == true
    and sent[1].body.x == -12500 and sent[1].body.y == -53100 and sent[1].body.z == 512)
  check('mpSelfSnap hands onGround to the engine teleport (World::adjustPosition force=true)',
    g:find('player:teleport(player.cell, util.vector3(data.x, data.y, data.z), { onGround = data.onGround == true })', 1, true) ~= nil)
  check('tpz: keeps a deliberate fall (no onGround)',
    p:find("core.sendGlobalEvent('mpSelfSnap', { x = pos.x, y = pos.y, z = pos.z + tonumber(tdz) })", 1, true) ~= nil)
  check('the reconciliation snap keeps a levitating pose (no onGround)',
    p:find("core.sendGlobalEvent('mpSelfSnap', { x = e.x, y = e.y, z = e.z })", 1, true) ~= nil)
end

print('#484 the sim peer ignores PlayerLeaveView: every player is in its view, the avatar stays')
do
  local g = io.open('./openmw/files/data/scripts/mp/global.lua'):read('*a')
  -- The handler, cut from the source and run twice: as the peer and as a client.
  local s = g:find('MP_PlayerLeaveView = function(data)', 1, true)
  local _, e = g:find('lastPose[data.id] = nil\n    end,', s, true)
  local function run(system)
    local despawned = {}
    local env = { remoteCell = { [3] = '-3,-9' }, lastPose = { [3] = { x = 1, y = 2, z = 3 } },
      despawnPuppet = function(id) despawned[#despawned + 1] = id end,
      mp = { isSystem = function() return system end } }
    setfenv(assert(loadstring('local handlers = {' .. g:sub(s, e) .. '}\nhandlers.MP_PlayerLeaveView({ id = 3 })')), env)()
    return despawned, env.remoteCell[3], env.lastPose[3]
  end
  local despawned, cell, pose = run(true)
  check('on the peer LeaveView removes nothing and keeps remoteCell/lastPose (the next MoveBatch could not respawn without them)',
    #despawned == 0 and cell == '-3,-9' and pose ~= nil)
  despawned, cell, pose = run(false)
  check('on a client LeaveView still despawns the puppet and forgets the player',
    #despawned == 1 and despawned[1] == 3 and cell == nil and pose == nil)
end

print(string.format('\n%d passed, %d failed', pass, fail))
os.exit(fail == 0 and 0 or 1)
