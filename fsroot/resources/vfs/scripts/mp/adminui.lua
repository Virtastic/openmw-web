-- Multiplayer ADMIN window (Phase E3, PLAYER context). G opens it.
--
-- The menu is built from the SERVER's own /help reply, which returns exactly the commands
-- the caller's rank permits (core/admin.ts helpLines). That is the whole design: the client
-- never stores or reasons about rank, so the menu cannot drift out of step with the gate
-- that actually enforces it. A player with no privileges opens this and sees only the
-- public commands, without the client having been told anything about ranks.
--
-- The server gate remains the authority regardless. Hiding a row is a convenience; every
-- action still goes through the same rank-checked, audited registry as the /slash path, and
-- a refusal comes back as text we display verbatim.
local core = require('openmw.core')
local ui = require('openmw.ui')
local util = require('openmw.util')
local async = require('openmw.async')
local input = require('openmw.input')
local mp = require('openmw.mp')
local I = require('openmw.interfaces')

local json = require('scripts.mp.json')

-- See social.lua: the open flag must not be the element slot, or destroy() indexes a
-- boolean and the handler throws with every mirror already updated.
local isOpen = false
local element = nil
local commands = {} -- array of {usage, help} parsed from the server's /help
local players = {} -- array of {id, name, rank, cell} parsed from /who
local lastResult = ''
local draft = ''
local selected = nil -- usage string of the command awaiting an argument

-- MyGUI reads '#' as a colour escape ("#RRGGBB"), so any text containing one is silently
-- mangled: /list output like "#1 ui-a-ms1ytyfi" rendered as green "-ms1ytyfi" because
-- "#1 ui-" was eaten as a colour. '##' is MyGUI's literal '#'. This matters beyond ids —
-- a player whose NAME contains '#' would corrupt every row it appears in.
local function escape(text)
    return (tostring(text):gsub('#', '##'))
end

local function row(text, onClick)
    local r = { template = I.MWUI.templates.textNormal, props = { text = escape(text) } }
    if onClick then r.events = { mouseClick = async:callback(onClick) } end
    return r
end

local function destroy()
    if element then
        element:destroy()
        element = nil
    end
end

local function send(cmd, args)
    core.sendGlobalEvent('mpAdminCommand', { cmd = cmd, args = args or {} })
end

local function render()
    if not isOpen then return end
    destroy()
    local rows = {}
    rows[#rows + 1] = row('-- Server admin --')
    if #commands == 0 then
        rows[#rows + 1] = row('  (asking the server what you may do...)')
    end

    for _, c in ipairs(commands) do
        -- usage looks like "/ban <account> [reason]"; the verb is the first token.
        local verb = c.usage:match('^/(%a+)')
        local needsArg = c.usage:find('<') ~= nil
        local label = '  ' .. c.usage .. '  — ' .. c.help
        rows[#rows + 1] = row(label, function()
            if needsArg then
                selected = verb
                lastResult = 'type an argument for /' .. verb .. ' and press Enter'
            else
                send(verb, {})
            end
            render()
        end)
    end

    if #players > 0 then
        rows[#rows + 1] = row('-- Players --')
        for _, p in ipairs(players) do
            rows[#rows + 1] = row('  ' .. p)
        end
    end

    if selected then
        rows[#rows + 1] = row('-- argument for /' .. selected .. ' (click, type, Enter) --')
        rows[#rows + 1] = {
            template = I.MWUI.templates.textEditLine,
            props = { text = '', size = util.vector2(400, 0) },
            events = {
                textChanged = async:callback(function(text) draft = text end),
                keyPress = async:callback(function(e)
                    if e.code == input.KEY.Enter and draft ~= '' then
                        -- Split on spaces: "/give someone gold_001 5" is three args.
                        local args = {}
                        for word in draft:gmatch('%S+') do args[#args + 1] = word end
                        send(selected, args)
                        draft = ''
                        selected = nil
                        render()
                    end
                end),
            },
        }
    end

    if lastResult ~= '' then
        rows[#rows + 1] = row('-- server --')
        for line in tostring(lastResult):gmatch('[^\n]+') do rows[#rows + 1] = row('  ' .. line) end
    end
    rows[#rows + 1] = row('[ close ]', function()
        isOpen = false
        destroy()
        I.UI.removeMode('Interface')
    end)

    I.UI.setMode('Interface', { windows = {} })
    element = ui.create {
        layer = 'Windows',
        template = I.MWUI.templates.boxSolid,
        props = { position = util.vector2(60, 60) },
        content = ui.content {
            { type = ui.TYPE.Flex, props = { horizontal = false, autoSize = true }, content = ui.content(rows) },
        },
    }
end

local function open()
    isOpen = true
    commands = {}
    players = {}
    lastResult = ''
    selected = nil
    render()
    -- Ask the server what this player may do, and who is here. The reply drives the menu.
    send('help', {})
    send('list', {})
end

local function toggle()
    if isOpen then
        isOpen = false
        destroy()
        I.UI.removeMode('Interface')
    else
        open()
    end
end

-- The server answers /help with one "usage — help" line per permitted command, and /who
-- with one line per player (the registry calls it /list, not /who). Both arrive through the same MP_AdminResult, so they are told
-- apart by shape rather than by a request id: a usage line starts with '/'.
local function absorb(text)
    local usages, who = {}, {}
    for line in tostring(text):gmatch('[^\n]+') do
        -- Split on the FIRST ' — ' with a plain find, not a Lua pattern. Lua patterns are
        -- byte-based and the separator is a 3-byte em-dash, so a character class like
        -- [^—] means "none of these three bytes" rather than "not this character" — it
        -- parsed nothing and the menu came back empty.
        local sepA, sepB = line:find(' — ', 1, true)
        local usage = line:sub(1, 1) == '/' and sepA and line:sub(1, sepA - 1) or nil
        local help = usage and line:sub(sepB + 1) or nil
        if usage then
            usages[#usages + 1] = { usage = usage:gsub('%s+$', ''), help = help }
        elseif line:match('^#%d+') then
            who[#who + 1] = line
        end
    end
    if #usages > 0 then commands = usages end
    if #who > 0 then players = who end
    if #usages == 0 and #who == 0 then lastResult = text end
    mp.testSet('adminMenu', json.encode({ commands = commands, players = players }))
end

return {
    engineHandlers = {
        onKeyPress = function(key)
            if key.symbol == 'g' and not I.UI.getMode() then toggle() end
        end,
    },
    eventHandlers = {
        MP_AdminMenuResult = function(data)
            absorb(data.text or '')
            render()
        end,
        -- Test-only: the harness cannot drive SDL keys (PLAYTEST.md 9), so the window has
        -- to be openable without one for any automated UI check to be possible at all.
        MP_AdminUiOpen = function()
            open()
        end,
    },
}
