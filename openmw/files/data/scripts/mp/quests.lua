-- M6 quest-layer hub (GLOBAL context; wired from scripts/mp/global.lua).
-- See server/PROTOCOL.md §M6. Families: shared journal, MWScript globals, per-object
-- MWScript locals, factions, crime, and the one-at-a-time dialogue lock.
--
-- Why GLOBAL and not player: every writable end of this layer is global-gated in 0.52 —
--   types.Player.setCrimeLevel  -> "Only global scripts can change crime level"
--                                  (mwlua/types/player.cpp:429)
--   world.mwscript.*            -> openmw.world is a global-only package
--                                  (mwlua/worldbindings.cpp:164)
-- The one PLAYER-only piece is the `onQuestUpdate(questId, stage)` engine handler, which
-- lives in scripts/mp/player.lua and forwards here as `mpQuestUpdate`. Keeping the state
-- in one context means one echo guard instead of two.
--
-- ECHO GUARD (PROTOCOL.md §M6: "applying a received update MUST NOT re-broadcast it"):
-- every family keeps a diff cache that is written BEFORE the local apply, so the engine
-- signal the apply produces (a journal update, a changed global) matches the cache and is
-- swallowed. `applying` additionally covers the same-frame window.
local core = require('openmw.core')
local types = require('openmw.types')
local world = require('openmw.world')
local mp = require('openmw.mp')
local I = require('openmw.interfaces')

local json = require('scripts.mp.json')

local quests = {}

-- injected by global.lua at init: {playerFn, ownCellKeyFn, ownIdFn, noticeFn,
--                                  rosterNameFn, isMpPuppetFn}
local deps = nil

local DIFF_INTERVAL = 1.0 -- globals / factions / crime poll (PROTOCOL.md §M6: 1 s diff)
local MEMBER_WATCH_SECONDS = 6 -- MemberVarUpdate piggybacks on an interaction window
local MEMBER_POLL = 0.25
local MIRROR_INTERVAL = 0.5
local MAX_GLOBALS_PER_TICK = 24 -- stay well inside the server's 60 msg/s bucket

-- M7 owns the clock: these are excluded client-side too (the server drops them anyway,
-- quests.ts TIME_GLOBALS).
local TIME_GLOBALS = {
    gamehour = true, day = true, month = true, year = true, dayspassed = true,
}

-- --- state -------------------------------------------------------------------------------

local applying = false -- same-frame guard around a network apply

local journal = {} -- questId -> index (diff cache AND echo guard)
local journalSent = 0 -- JournalEntry broadcasts WE originated (echo-guard evidence)
local journalSynced = false -- MP_JournalSync consumed?
local pendingJournal = {} -- questId -> index observed locally before the sync landed
local pendingApply = {} -- inbound entries that arrived before the player object existed

local globals = {} -- name -> last seen value
local globalSeq = {} -- name -> last sequence WE stamped
local globalsSeeded = false
-- FIFO queue of globals waiting to be sent, plus a membership set so a variable that changes
-- again while queued keeps its ORIGINAL place rather than going to the back forever.
--
-- Without this the send order was pairs(store), which Lua explicitly does not define, capped at
-- MAX_GLOBALS_PER_TICK. Above that many churning globals -- and Morrowind has scripts that set
-- values every other frame -- WHICH ones got through was arbitrary each tick, so a quest global
-- could sit unsent indefinitely behind them while the log showed a healthy, rate-limited sync.
-- TES3MP hit the same class and solved it with a whitelist; a queue fixes the fairness without
-- needing to enumerate every global in the game.
local globalQueue = {} -- array of names, oldest first
local globalQueued = {} -- name -> true while it is in globalQueue

local factions = {} -- factionId -> fingerprint string
local factionsSeeded = false
local bounty = nil -- last seen crime level

local memberWatch = {} -- obj.id -> {obj=, script=, last={name->value}, nextPoll=, until_=}
local memberApplied = {} -- "<recordId>.<var>" -> value (inbound MemberVarUpdate mirror)

-- Dialogue lock (PROTOCOL.md §M6 DialogueLock/DialogueLockResult).
local lockPending = nil -- GameObject we asked for and have not heard back about
local lockHeld = nil -- GameObject we currently hold the conversation on
local lockAllowOnce = nil -- obj.id whose next activation must pass through unblocked
local lastLockMirror = nil

local nextDiffAt = 0
local lastMirror = 0
local scriptedCache = {} -- recordId -> first MWScript local name (mirror; slow refresh)
local scriptedAt = 0
local SCRIPTED_SCAN_INTERVAL = 5

-- --- helpers -----------------------------------------------------------------------------

local function playerObj()
    return deps.playerFn()
end

-- Server-side arbitration works on integers; LSER numbers are doubles.
local function asInt(v)
    if type(v) ~= 'number' then return nil end
    return math.floor(v + (v >= 0 and 0.5 or -0.5))
end

local function notice(text)
    if deps.noticeFn then deps.noticeFn(text) end
end

-- ================================================================== journal

local function applyJournalEntry(questId, index)
    -- Cache FIRST: the engine's onQuestUpdate for this apply arrives a frame later and is
    -- recognised as our own echo by value. Caching before the player-object check matters:
    -- JournalSync can land before world.players[1] exists, and an unseeded cache would make
    -- the first local quest signal look like a fresh local change.
    journal[questId] = index
    local player = playerObj()
    if not player then
        pendingApply[questId] = index -- retried from tick() once the player exists
        return false
    end
    local all = types.Player.quests(player)
    local quest = all[questId]
    if not quest then
        -- Not a Journal-type dialogue record in OUR content (mwlua/types/player.cpp:299).
        -- Reported, never swallowed: on mismatched content this is the real failure.
        print('[mp] journal: no quest record "' .. tostring(questId) .. '" in this content')
        return false
    end
    applying = true
    -- addJournalEntry writes the REAL entry text from the content records; quest.stage alone
    -- only moves the index (mwdialogue/quest.cpp:52 — "The index must be set even if no
    -- related journal entry was found"). MP boots as a fresh game and never loads a save, so
    -- the engine journal starts EMPTY every session and is rebuilt from JournalSync: with
    -- index-only, every player's journal read blank after a relog while their quests still
    -- gated correctly. Repeats are safe — Topic::addEntry dedupes by info id.
    local ok = pcall(function() quest:addJournalEntry(index) end)
    if not ok then
        -- No info record at this exact stage (common: the server stores the current index,
        -- not every stage passed through). The index still has to land.
        print('[mp] journal: no entry text for "' .. tostring(questId) .. '" @' .. tostring(index))
    end
    -- PROTECTED, AND `applying` RESET WHATEVER HAPPENS. This assignment used to sit outside any
    -- pcall between `applying = true` and `applying = false`, so one throw here left the flag
    -- stuck true for the rest of the session -- and onQuestUpdate early-returns on `applying`,
    -- which means the client would silently stop reporting ANY local quest progress from that
    -- moment on. No error, no recovery, and the player's quests simply stop travelling.
    -- belt and braces: never assume addEntry left the index where we want it.
    local okStage, stageErr = pcall(function() quest.stage = index end)
    applying = false
    if not okStage then
        print('[mp] journal: could not set stage for "' .. tostring(questId) .. '" @'
            .. tostring(index) .. ': ' .. tostring(stageErr))
        return false
    end
    return true
end

-- From player.lua's onQuestUpdate engine handler (PLAYER context) via mpQuestUpdate.
function quests.onQuestUpdate(questId, stage)
    stage = asInt(stage)
    if applying or type(questId) ~= 'string' or stage == nil then return end
    if journal[questId] == stage then return end -- echo of an applied entry
    journal[questId] = stage
    if not journalSynced then
        -- Broadcasting before the join-time sync would race the server's stored state.
        pendingJournal[questId] = stage
        return
    end
    journalSent = journalSent + 1
    mp.sendEvent('JournalEntry', { questId = questId, index = stage })
end

-- ================================================================== mwscript globals

local function globalStore()
    return world.mwscript.getGlobalVariables()
end

local function diffGlobals()
    local store = globalStore()
    -- 1. Notice every change and ENQUEUE it. Detection is not rate limited; only sending is,
    --    so a change can never be missed just because the tick's budget was already spent.
    for name, value in pairs(store) do
        if not TIME_GLOBALS[string.lower(name)] then
            if globals[name] ~= value then
                globals[name] = value
                if globalsSeeded and not globalQueued[name] then
                    globalQueued[name] = true
                    globalQueue[#globalQueue + 1] = name
                end
            end
        end
    end
    globalsSeeded = true

    -- 2. Drain the FRONT of the queue. Oldest waiting first, so nothing starves however many
    --    other globals are churning. The value sent is the CURRENT one, not the one that was
    --    current when it was queued -- the receiver wants where the variable ended up.
    local sent = 0
    while sent < MAX_GLOBALS_PER_TICK and #globalQueue > 0 do
        local name = table.remove(globalQueue, 1)
        globalQueued[name] = nil
        local value = store[name]
        if value ~= nil then
            local seq = (globalSeq[name] or 0) + 1
            globalSeq[name] = seq
            mp.sendEvent('GlobalVarUpdate', { name = name, value = value, seq = seq })
            sent = sent + 1
        end
    end
    if #globalQueue > 0 then mp.testSet('globalBacklog', tostring(#globalQueue)) end
end

-- ================================================================== factions / crime

local function factionFingerprint(rank, reputation, expelled)
    return string.format('%d|%d|%s', rank, reputation, tostring(expelled))
end

local function diffFactions()
    local player = playerObj()
    if not player then return end
    for _, rec in ipairs(core.factions.records) do
        local id = rec.id
        -- getFactionRank returns a 1-BASED rank and 0 when not a member
        -- (mwlua/types/npc.cpp:311). The wire carries that same 1-based number, so
        -- setFactionRank on the receiver is symmetric.
        local rank = types.NPC.getFactionRank(player, id)
        if rank and rank > 0 then
            local reputation = types.NPC.getFactionReputation(player, id) or 0
            local expelled = types.NPC.isExpelled(player, id) == true
            local fp = factionFingerprint(rank, reputation, expelled)
            if factions[id] ~= fp then
                factions[id] = fp
                if factionsSeeded then
                    mp.sendEvent('FactionUpdate', {
                        factionId = id, rank = rank, reputation = reputation, expelled = expelled,
                    })
                end
            end
        end
    end
    factionsSeeded = true
end

local function diffCrime()
    local player = playerObj()
    if not player then return end
    local level = types.Player.getCrimeLevel(player)
    if level == bounty then return end
    local first = bounty == nil
    bounty = level
    if not first then
        mp.sendEvent('CrimeUpdate', { bounty = level })
    end
end

-- ================================================================== mwscript locals

local function scriptVarSnapshot(script)
    local snap = {}
    for name, value in pairs(script.variables) do
        snap[name] = value
    end
    return snap
end

-- Called from the GLOBAL onActivate hook: an object with a local MWScript was touched, so
-- its locals may be about to change. Watch them for a short window and relay the deltas
-- (PROTOCOL.md §M6: MemberVarUpdate "piggybacked on object interaction").
function quests.onActivate(object, actor)
    local player = playerObj()
    if not player or not actor or actor.id ~= player.id then return end
    if not object.contentFile then return end -- runtime objects have no portable RefNum
    local script = world.mwscript.getLocalScript(object)
    if not script then return end
    memberWatch[object.id] = {
        obj = object,
        script = script,
        last = scriptVarSnapshot(script),
        nextPoll = core.getRealTime() + MEMBER_POLL,
        until_ = core.getRealTime() + MEMBER_WATCH_SECONDS,
    }
end

local function tickMemberVars(now)
    for id, watch in pairs(memberWatch) do
        if now > watch.until_ or not watch.obj:isValid() then
            memberWatch[id] = nil
        elseif now >= watch.nextPoll then
            watch.nextPoll = now + MEMBER_POLL
            local snap = scriptVarSnapshot(watch.script)
            for name, value in pairs(snap) do
                if watch.last[name] ~= value then
                    watch.last[name] = value
                    -- No cellKey in the body: the server infers it from our current cell.
                    mp.sendEvent('MemberVarUpdate', { ref = watch.obj, name = name, value = value })
                end
            end
        end
    end
end

-- ================================================================== dialogue lock

local function refName(obj)
    if not (obj and obj:isValid()) then return '?' end
    local rec = types.NPC.records[obj.recordId]
    return (rec and rec.name and rec.name ~= '' and rec.name) or obj.recordId
end

local function mirrorLock(state)
    lastLockMirror = state
    mp.testSet('dialogueLock', json.encode(state))
end

local function requestLock(obj)
    lockPending = obj
    mp.sendEvent('DialogueLock', {
        ref = obj, cellKey = deps.ownCellKeyFn(), want = true,
    })
end

function quests.releaseLock(why)
    local obj = lockHeld
    lockHeld = nil
    lockPending = nil
    lockAllowOnce = nil
    if not obj then return end
    mp.sendEvent('DialogueLock', { ref = obj, cellKey = deps.ownCellKeyFn(), want = false })
    mirrorLock({ ref = obj:isValid() and obj.recordId or '?', granted = false, why = why or 'released' })
end

-- I.Activation handler for NPCs: block the conversation until the server grants the lock.
-- Returning false cancels the activation entirely, so the dialogue window never opens.
function quests.onNpcActivate(obj, actor)
    local player = playerObj()
    if not player or not actor or actor.id ~= player.id then return end
    if deps.isMpPuppetFn and deps.isMpPuppetFn(obj) then return end -- remote players aren't NPCs to lock
    if not obj.contentFile then return end -- no portable ref: cannot be arbitrated
    if lockAllowOnce == obj.id then
        lockAllowOnce = nil
        return -- granted: let the engine open the dialogue window
    end
    if lockHeld and lockHeld:isValid() and lockHeld.id == obj.id then return end
    requestLock(obj)
    return false
end

-- ================================================================== network appliers

local handlers = {}

handlers.MP_JournalEntry = function(data)
    local index = asInt(data.index)
    if type(data.questId) ~= 'string' or index == nil then return end
    applyJournalEntry(data.questId, index)
end

handlers.MP_JournalSync = function(data)
    -- THE single decision point for whose journal is on screen.
    --
    -- Driven off the SYNC, never off a "leaving" event: this message is sent on every join
    -- (connection.ts handleReady), including a resume and a world switch, so a transition we
    -- miss repairs itself on the next one instead of leaving a guest holding someone else's
    -- campaign. Both engine calls are idempotent, so re-syncing the same world is a no-op.
    local player = playerObj()
    if player then
        if data.borrowed == true then
            -- Another player's campaign is about to be shown. Set ours aside WHOLE — entries,
            -- quests and topics — so nothing of ours leaks through, not even quests we are
            -- further along on than they are.
            if not types.Player.isJournalStashed(player) then
                types.Player.stashJournal(player)
                print('[mp] journal: stashed own campaign for a visit')
                -- SAY IT. A guest whose journal silently becomes someone else's reads it as
                -- lost progress, and a guest who does not realise the quests they are
                -- advancing are the HOST's is being quietly misled about what their evening
                -- earned them. Both are answered by one line at the moment it happens.
                notice("You are visiting this world's campaign — quests here advance the host's"
                    .. ' journal. Your own is set aside and comes back when you go home.')
            end
        elseif types.Player.isJournalStashed(player) then
            -- Home. The borrowed set is discarded and ours moves back as the same objects,
            -- so the restore is exact rather than a reconstruction.
            types.Player.unstashJournal(player)
            print('[mp] journal: restored own campaign')
            notice('Your own journal is back.')
        end
    end
    for questId, index in pairs(data.quests or {}) do
        local idx = asInt(index)
        if type(questId) == 'string' and idx then applyJournalEntry(questId, idx) end
    end
    journalSynced = true
    -- Anything we observed locally before the sync landed is now diffed AGAINST it.
    for questId, index in pairs(pendingJournal) do
        if journal[questId] ~= index then
            journal[questId] = index
            journalSent = journalSent + 1
            mp.sendEvent('JournalEntry', { questId = questId, index = index })
        end
    end
    pendingJournal = {}
    print('[mp] journal sync applied')
end

handlers.MP_GlobalVarUpdate = function(data)
    if type(data.name) ~= 'string' or type(data.value) ~= 'number' then return end
    if TIME_GLOBALS[string.lower(data.name)] then return end
    -- Cache first (echo guard), then write through to the engine.
    globals[data.name] = data.value
    if type(data.seq) == 'number' then globalSeq[data.name] = data.seq end
    applying = true
    -- new_index throws when the global does not exist here (mwscriptbindings.cpp:246):
    -- a content mismatch, which must be visible rather than swallowed.
    local ok, err = pcall(function() globalStore()[data.name] = data.value end)
    applying = false
    if not ok then
        print('[mp] global "' .. data.name .. '" not settable here: ' .. tostring(err))
    end
end

-- Phase 4: this CHARACTER's shadowed quest globals, restored at join. They never travel
-- between players (that is what stops two party members at different stages overwriting
-- each other), so this is the only way progress survives a relog or a world hop.
handlers.MP_GlobalVarSync = function(data)
    local n = 0
    for name, value in pairs(data.globals or {}) do
        if type(name) == 'string' and type(value) == 'number' and not TIME_GLOBALS[string.lower(name)] then
            globals[name] = value
            applying = true
            local ok = pcall(function() globalStore()[name] = value end)
            applying = false
            if ok then n = n + 1 end
        end
    end
    if n > 0 then print('[mp] restored ' .. tostring(n) .. ' character globals') end
end

-- Phase 4: a one-shot scripted encounter this character was owed. Morrowind fires these
-- once (Azura's Staada, the Tribunal Fabricants), so a player who was not there — or who
-- joined after the fight started — otherwise stands in an empty room with an active quest
-- entry, which is the single most reported co-op quest break.
handlers.MP_QuestSpawn = function(data)
    if type(data.recordId) ~= 'string' then return end
    core.sendGlobalEvent('mpQuestSpawn', {
        recordId = data.recordId, questId = tostring(data.questId or ''),
    })
end

handlers.MP_MemberVarUpdate = function(data)
    if type(data.name) ~= 'string' or type(data.value) ~= 'number' then return end
    local obj = data.ref
    local okValid, valid = pcall(function() return obj:isValid() end)
    if not (okValid and valid) then return end
    local script = world.mwscript.getLocalScript(obj)
    if not script then
        print('[mp] memberVar: no local script on ' .. tostring(obj.recordId))
        return
    end
    local watch = memberWatch[obj.id]
    if watch then watch.last[data.name] = data.value end -- never re-diff a network apply
    local ok, err = pcall(function() script.variables[data.name] = data.value end)
    if not ok then
        print('[mp] memberVar "' .. data.name .. '" not settable: ' .. tostring(err))
        return
    end
    memberApplied[obj.recordId .. '.' .. data.name] = data.value
end

handlers.MP_FactionUpdate = function(data)
    local player = playerObj()
    local rank = asInt(data.rank)
    if not player or type(data.factionId) ~= 'string' or rank == nil then return end
    local id = data.factionId
    local reputation = asInt(data.reputation) or 0
    local expelled = data.expelled == true
    -- Cache first (echo guard) so the next diff sees no change.
    factions[id] = factionFingerprint(rank, reputation, expelled)
    -- joinFaction/setFactionRank/setFactionReputation/expel are all writable from a global
    -- script (mwlua/types/npc.cpp:333/406/443/473 gate on "local scripts may modify only
    -- self"); setFactionRank additionally REQUIRES membership and a 1..ranksCount value.
    local ok, err = pcall(function()
        if rank > 0 then
            types.NPC.joinFaction(player, id)
            types.NPC.setFactionRank(player, id, rank)
        else
            types.NPC.leaveFaction(player, id)
        end
        if data.reputation ~= nil then types.NPC.setFactionReputation(player, id, reputation) end
        if data.expelled ~= nil then
            if expelled then types.NPC.expel(player, id) else types.NPC.clearExpelled(player, id) end
        end
    end)
    if not ok then
        print('[mp] faction apply failed for ' .. id .. ': ' .. tostring(err))
    end
end

handlers.MP_CrimeUpdate = function(data)
    local player = playerObj()
    local level = asInt(data.bounty)
    if not player or level == nil then return end
    if data.byId ~= nil and data.byId == deps.ownIdFn() then return end -- own echo
    bounty = level -- echo guard
    types.Player.setCrimeLevel(player, level) -- global-only setter; we ARE global
end

-- REJOIN RESTORE for standing. The server records faction rank/reputation/expulsion and
-- crime bounty on the character doc and sends the whole doc back as playerRecord — but
-- nothing ever applied them, so "your standing follows you" was written-only: recorded on
-- the way out, silently dropped on the way in.
--
-- Deliberately reuses the live appliers rather than repeating the engine calls, so the
-- restore path cannot drift from the update path (and inherits the same echo-guard caching,
-- which is what stops the first diff after a join re-uploading everything we just applied).
function quests.restoreStanding(record)
    if type(record) ~= 'table' then return end
    for id, st in pairs(record.factions or {}) do
        if type(st) == 'table' then
            handlers.MP_FactionUpdate({
                factionId = id, rank = st.rank,
                reputation = st.reputation, expelled = st.expelled,
            })
        end
    end
    if record.bounty ~= nil then handlers.MP_CrimeUpdate({ bounty = record.bounty }) end
end

handlers.MP_DialogueLockResult = function(data)
    local obj = data.ref
    local okValid, valid = pcall(function() return obj:isValid() end)
    if not (okValid and valid) then return end
    if not lockPending or lockPending.id ~= obj.id then
        return -- a want=false acknowledgement, or a result we no longer care about
    end
    lockPending = nil
    if data.granted then
        lockHeld = obj
        lockAllowOnce = obj.id
        mirrorLock({ ref = obj.recordId, granted = true })
        -- Re-run the activation we cancelled; this time the handler lets it through.
        local player = playerObj()
        if player then obj:activateBy(player) end
    else
        local holder = data.holderId and deps.rosterNameFn and deps.rosterNameFn(data.holderId)
        local who = holder or (data.holderId and ('player ' .. string.format('%.0f', data.holderId)))
            or 'someone else'
        mirrorLock({ ref = obj.recordId, granted = false,
            holderId = data.holderId and string.format('%.0f', data.holderId) or nil, holder = who })
        notice(refName(obj) .. ' is talking to ' .. who .. ' — wait your turn')
    end
end

quests.handlers = handlers

-- ================================================================== lifecycle

function quests.onCellChanged()
    -- Walking away ends the conversation (the server releases on cell change too).
    if lockHeld then quests.releaseLock('cellchange') end
end

local function mirror()
    local j = {}
    for id, idx in pairs(journal) do j[id] = idx end
    mp.testSet('journal', json.encode(j))
    -- Whose campaign is on screen. Mirrored so a visit can be OBSERVED end to end rather
    -- than inferred: the stash is engine-side state with no other outward signal.
    local pl = playerObj()
    mp.testSet('journalStashed',
        tostring(pl ~= nil and types.Player.isJournalStashed(pl) == true))
    mp.testSet('journalSynced', tostring(journalSynced))
    mp.testSet('journalSent', string.format('%.0f', journalSent))
    -- The ENGINE's own journal (types.Player.quests pairs over MWBase::Journal), not our
    -- cache: scenarios assert the real game state, and the two disagreeing is a bug.
    local engineJournal = {}
    local player0 = playerObj()
    if player0 then
        local okj = pcall(function()
            for id, quest in pairs(types.Player.quests(player0)) do
                engineJournal[id] = quest.stage
            end
        end)
        if not okj then engineJournal = {} end
    end
    mp.testSet('journalEngine', json.encode(engineJournal))
    local g = {}
    for name, value in pairs(globals) do g[name] = value end
    mp.testSet('globalVars', json.encode(g))
    local f = {}
    for id, fp in pairs(factions) do f[id] = fp end
    mp.testSet('factions', json.encode(f))
    mp.testSet('bounty', bounty and string.format('%.0f', bounty) or '')
    if lastLockMirror == nil then mp.testSet('dialogueLock', '') end
    -- NPC records in our own cell, sorted: gives the scenarios a deterministic, shared
    -- target to lock (world.activeActors order differs per client).
    local player = playerObj()
    local names = {}
    if player and player.cell then
        local ok, list = pcall(function() return player.cell:getAll(types.NPC) end)
        if ok then
            local seen = {}
            for _, obj in ipairs(list) do
                if obj.contentFile and not seen[obj.recordId]
                    and not (deps.isMpPuppetFn and deps.isMpPuppetFn(obj)) then
                    seen[obj.recordId] = true
                    names[#names + 1] = obj.recordId
                end
            end
            table.sort(names)
        end
    end
    mp.testSet('cellNpcs', json.encode(names))
    mp.testSet('memberVars', json.encode(memberApplied))
    -- Scripted content objects in our cell (recordId -> first local var name), so a
    -- scenario can pick a MemberVarUpdate target that exists on BOTH clients. Walking
    -- every object in an exterior cell is not free: refresh it on a slow timer.
    local scripted = scriptedCache
    if player and player.cell and core.getRealTime() >= scriptedAt then
        scriptedAt = core.getRealTime() + SCRIPTED_SCAN_INTERVAL
        scripted = {}
        local okc, list = pcall(function() return player.cell:getAll() end)
        if okc then
            for _, obj in ipairs(list) do
                if obj.contentFile and not scripted[obj.recordId] then
                    local oks, script = pcall(function() return world.mwscript.getLocalScript(obj) end)
                    if oks and script then
                        for varName in pairs(script.variables) do
                            scripted[obj.recordId] = varName
                            break
                        end
                    end
                end
            end
        end
        scriptedCache = scripted
    end
    mp.testSet('cellScripted', json.encode(scripted))
end

function quests.tick(now)
    if next(pendingApply) and playerObj() then
        local retry = pendingApply
        pendingApply = {}
        for questId, index in pairs(retry) do applyJournalEntry(questId, index) end
    end
    if now >= nextDiffAt then
        nextDiffAt = now + DIFF_INTERVAL
        diffGlobals()
        diffFactions()
        diffCrime()
    end
    tickMemberVars(now)
    if now - lastMirror >= MIRROR_INTERVAL then
        lastMirror = now
        mirror()
    end
end

function quests.reset()
    journal = {}
    journalSent = 0
    journalSynced = false
    pendingJournal = {}
    pendingApply = {}
    globals = {}
    globalSeq = {}
    globalsSeeded = false
    factions = {}
    factionsSeeded = false
    bounty = nil
    memberWatch = {}
    memberApplied = {}
    lockPending = nil
    lockHeld = nil
    lockAllowOnce = nil
end

-- ================================================================== test hooks

-- Drive a quest stage through the REAL engine path (setJournalIndex -> onQuestUpdate ->
-- quests.onQuestUpdate -> JournalEntry), i.e. exactly what a dialogue result does.
function quests.testSetQuestStage(questId, stage)
    local player = playerObj()
    if not player then return end
    local all = types.Player.quests(player)
    local quest = all[questId]
    if not quest then
        print('[mp] testSetQuestStage: no quest "' .. tostring(questId) .. '"')
        return
    end
    quest.stage = stage
end

function quests.testSetGlobal(name, value)
    local ok, err = pcall(function() globalStore()[name] = value end)
    if not ok then print('[mp] testSetGlobal ' .. name .. ': ' .. tostring(err)) end
end

function quests.testSetBounty(n)
    local player = playerObj()
    if player then types.Player.setCrimeLevel(player, n) end
end

function quests.testJoinFaction(id, rank)
    local player = playerObj()
    if not player then return end
    local ok, err = pcall(function()
        types.NPC.joinFaction(player, id)
        types.NPC.setFactionRank(player, id, rank)
    end)
    if not ok then print('[mp] testJoinFaction ' .. id .. ': ' .. tostring(err)) end
end

-- Activate an NPC by record id through the engine's activation pipeline, so the dialogue
-- lock is exercised by the same handler a mouse click would hit.
function quests.testActivateNpc(recordId)
    local player = playerObj()
    if not (player and player.cell) then return false end
    local ok, list = pcall(function() return player.cell:getAll(types.NPC) end)
    if not ok then return false end
    for _, obj in ipairs(list) do
        if obj.recordId == recordId and obj:isValid() and obj.contentFile then
            obj:activateBy(player)
            return true
        end
    end
    print('[mp] testActivateNpc: no NPC "' .. tostring(recordId) .. '" in cell')
    return false
end

-- Arm the interaction watch on a scripted cell object and then change one of its locals
-- through the engine bridge: the SAME path a vanilla script write takes, so the relay is
-- produced by the watch rather than by a bespoke send.
function quests.testSetMemberVar(recordId, name, value)
    local player = playerObj()
    if not (player and player.cell) then return end
    local ok, list = pcall(function() return player.cell:getAll() end)
    if not ok then return end
    for _, obj in ipairs(list) do
        if obj.recordId == recordId and obj.contentFile then
            local script = world.mwscript.getLocalScript(obj)
            if script then
                quests.onActivate(obj, player)
                local okw, err = pcall(function() script.variables[name] = value end)
                if not okw then print('[mp] testSetMemberVar: ' .. tostring(err)) end
                return
            end
        end
    end
    print('[mp] testSetMemberVar: no scripted object "' .. tostring(recordId) .. '" in cell')
end

function quests.init(d)
    deps = d
    -- Real blocking path: an activation handler that returns false cancels the activation
    -- (files/data/scripts/omw/activationhandlers.lua), so no dialogue window opens.
    I.Activation.addHandlerForType(types.NPC, function(obj, actor)
        return quests.onNpcActivate(obj, actor)
    end)
end

return quests
