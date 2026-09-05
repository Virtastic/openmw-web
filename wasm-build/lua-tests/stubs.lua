-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- Minimal stand-ins for the engine APIs the mp/ client scripts require, so their LOGIC can be
-- exercised without a wasm build.
--
-- WHY THIS EXISTS. The 42 browser scenarios are the real client gate, and they need a built
-- engine — deps/ is a maintainer artifact. That left every client-side change in this tree
-- with no executed test at all, which for Lua is the worst case: a mistake there does not
-- crash, it makes one handler throw and silently disables a whole subsystem while the server
-- suite stays green. This does not replace the scenarios. It means the logic has been RUN.
local M = {}

-- The scripts report anomalies through print(), and several of those lines ARE the
-- behaviour under test (the self-silencing restore diagnostics). Capture once and keep the
-- original, so repeated install() calls cannot nest wrappers.
local realPrint = print

function M.install(opts)
  opts = opts or {}
  local calls = { events = {}, json = {}, testSet = {}, connects = 0, disconnects = 0, prints = {}, seq = {} }
  _G.print = function(...)
    local parts = {}
    for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    calls.prints[#calls.prints + 1] = table.concat(parts, ' ')
    realPrint(...)
  end

  local mp = {
    _calls = calls,
    sendEvent = function(name, body) calls.events[#calls.events + 1] = { name = name, body = body } end,
    sendJson = function(obj) calls.json[#calls.json + 1] = obj end,
    set = function(k, v) calls.testSet[k] = v end, -- the page mirror (window.omw.state)
    emit = function() end,
    pollCommands = function() return nil end,
    -- Engine primitive (mwmp/luabindings.cpp): purge every active effect on the player.
    -- Recorded in the same sequence log as the spellbook so ORDER can be asserted.
    clearActiveSpells = function() calls.seq[#calls.seq + 1] = 'clearActive' end,
    -- The engine mirror of the connection state; the C++ side owns it, so here it just records.
    _setState = function(v) calls.testSet['_state'] = v end,
    connect = function() calls.connects = calls.connects + 1; return true end,
    disconnect = function() calls.disconnects = calls.disconnects + 1 end,
    getUrl = function() return opts.url or 'ws://host/ws' end,
    getName = function() return opts.name or 'tester' end,
    getPassword = function() return opts.password or '' end,
    getEngineHash = function() return opts.engineHash or 'abcdef123456' end,
    getResumeToken = function() return opts.resumeToken or '' end,
    setResumeToken = function() end,
    getLoginTicket = function() return opts.loginTicket or '' end,
    getBootCharacter = function() return opts.character or '' end,
    isSystem = function() return opts.system == true end,
  }

  local realTime = 0
  local core = {
    getRealTime = function() return realTime end,
    -- Two skills is enough: the progression snapshot only has to be STABLE, so that its diff
    -- never fires and cannot be mistaken for the acquisition event under test.
    stats = { Skill = { records = { { id = 'longblade' }, { id = 'destruction' } } } },
    contentFiles = { list = opts.contentFiles or { 'builtin.omwscripts', 'morrowind.esm' } },
    sendGlobalEvent = function(name, data) calls.events[#calls.events + 1] = { name = name, body = data, global = true } end,
  }

  -- Inventory the identity scan reads. Mutable so a test can "pick something up".
  local inventory = {}
  -- Enough of types.* for the identity scan to run end to end. Deliberately plain values: the
  -- point is to exercise the DIFF logic, and a stat that never changes is exactly what keeps
  -- an unrelated broadcast from muddying the assertion under test.
  local function stat(v) return { getModified = function() return v end, base = v, current = v } end
  local dyn = { health = stat(100), magicka = stat(50), fatigue = stat(80) }
  local attrs, skills = {}, {}
  for _, a in ipairs({ 'strength', 'intelligence', 'willpower', 'agility',
                       'speed', 'endurance', 'personality', 'luck' }) do attrs[a] = stat(30) end

  local spellbook = setmetatable({}, { __index = {
    add = function(self, id)
      calls.seq[#calls.seq + 1] = 'add:' .. tostring(id)
      for _, sp in ipairs(self) do if sp.id == id then return end end
      self[#self + 1] = { id = id }
    end,
    clear = function(self)
      calls.seq[#calls.seq + 1] = 'clear'
      for i = #self, 1, -1 do self[i] = nil end
    end,
  } })

  local types = {
    Actor = {
      inventory = function() return { getAll = function() return inventory end } end,
      getEquipment = function() return {} end,
      setEquipment = function() end,
      isDead = function() return false end,
      -- Stateful spellbook: an ARRAY of {id=...} (so pairs() yields spell records the way
      -- snapSpells expects) with add/clear on a metatable, kept off the array part.
      spells = function() return spellbook end,
      stats = {
        dynamic = { health = function() return dyn.health end,
                    magicka = function() return dyn.magicka end,
                    fatigue = function() return dyn.fatigue end },
        attributes = setmetatable({}, { __index = function(_, k)
          return function() return attrs[k] or stat(30) end end }),
        level = function() return stat(1) end,
      },
      EQUIPMENT_SLOT = {},
    },
    NPC = {
      record = function() return {
        race = 'dark elf', head = 'h', hair = 'x', isMale = true, class = 'nightblade',
        name = 'tester',
      } end,
      records = { villager_00 = { race = 'dark elf', head = 'h', hair = 'x' } },
      stats = { skills = setmetatable({}, { __index = function(_, k)
        return function() return skills[k] or stat(15) end end }) },
      classes = { records = {} },
    },
    Player = {
      stashJournal = function() end,
      unstashJournal = function() end,
      isJournalStashed = function() return false end,
    },
  }

  -- GLOBAL-CONTEXT stubs. quests.lua and global.lua are global scripts: they require
  -- openmw.world and openmw.interfaces, which nothing here provided, so that whole half of the
  -- client -- journal, factions, crime, mwscript globals -- had no coverage at all.
  local globalVars = opts.globals or {}
  local world = {
    mwscript = {
      getGlobalVariables = function() return globalVars end,
      getLocalScript = function() return nil end,
    },
    players = {},
    activeActors = {},
  }
  local interfaces = {
    -- quests.init registers an activation handler; the tests drive quests.onNpcActivate
    -- directly, so recording the registration is enough.
    Activation = { addHandlerForType = function() end },
  }
  package.loaded['openmw.world'] = world
  package.loaded['openmw.interfaces'] = interfaces
  package.loaded['openmw.core'] = core
  package.loaded['openmw.mp'] = mp
  package.loaded['openmw.self'] = { id = 'self' }
  package.loaded['openmw.types'] = types
  package.loaded['openmw.util'] = {
    vector2 = function(a, b) return { a, b } end,
    vector3 = function(a, b, c) return { x = a, y = b, z = c } end,
  }
  -- combat.lua pulls threat in at load; nothing in the combat tests exercises it.
  package.loaded['scripts.mp.threat'] = { onHitTaken = function() end, note = function() end }

  return {
    mp = mp, core = core, types = types, calls = calls,
    advance = function(sec) realTime = realTime + sec end,
    now = function() return realTime end,
    setInventory = function(items) inventory = items end,
    spellbook = spellbook,
    world = world,
    globals = globalVars,
    setGlobal = function(name, value) globalVars[name] = value end,
  }
end

return M
