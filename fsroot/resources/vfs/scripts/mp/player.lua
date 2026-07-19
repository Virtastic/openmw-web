-- Multiplayer PLAYER script (M0): chat window + input, and the harness command poll.
-- T toggles the chat window (mouse is freed via the Interface UI mode); click the input
-- line, type, Enter sends. Incoming messages also pop as screen messages so chat is
-- visible without the window open.
local core = require('openmw.core')
local ui = require('openmw.ui')
local util = require('openmw.util')
local async = require('openmw.async')
local input = require('openmw.input')
local mp = require('openmw.mp')
local I = require('openmw.interfaces')

local HISTORY_MAX = 8

local history = {} -- array of display strings, newest last
local chatElement = nil
local draft = ''

local function formatMessage(data)
    local text = tostring(data.text or '')
    if data.channel == 'server' then
        return '* ' .. text
    elseif data.channel == 'whisper' then
        return '[whisper] ' .. tostring(data.from or '?') .. ': ' .. text
    end
    return tostring(data.from or '?') .. ': ' .. text
end

local function destroyChat()
    if chatElement then
        chatElement:destroy()
        chatElement = nil
    end
end

local function submit()
    if draft ~= '' then
        core.sendGlobalEvent('mpChatSend', { text = draft })
        draft = ''
    end
    destroyChat()
    I.UI.removeMode('Interface')
end

local function historyContent()
    local lines = {}
    for _, line in ipairs(history) do
        lines[#lines + 1] = {
            template = I.MWUI.templates.textNormal,
            props = { text = line },
        }
    end
    if #lines == 0 then
        lines[1] = {
            template = I.MWUI.templates.textNormal,
            props = { text = '(no messages — click the line below, type, Enter to send)' },
        }
    end
    return lines
end

local function createChat()
    local rows = historyContent()
    rows[#rows + 1] = { template = I.MWUI.templates.interval }
    rows[#rows + 1] = {
        template = I.MWUI.templates.textEditLine,
        props = {
            text = draft,
            size = util.vector2(400, 0),
        },
        events = {
            textChanged = async:callback(function(text) draft = text end),
            keyPress = async:callback(function(e)
                if e.code == input.KEY.Enter then submit() end
            end),
        },
    }
    chatElement = ui.create {
        layer = 'Windows',
        template = I.MWUI.templates.boxSolid,
        props = {
            position = util.vector2(40, 60),
        },
        content = ui.content {
            {
                type = ui.TYPE.Flex,
                props = {
                    horizontal = false,
                    autoSize = true,
                },
                content = ui.content(rows),
            },
        },
    }
end

local function toggleChat()
    if chatElement then
        destroyChat()
        I.UI.removeMode('Interface')
    else
        I.UI.setMode('Interface', { windows = {} })
        createChat()
    end
end

local function pushMessage(data)
    local line = formatMessage(data)
    history[#history + 1] = line
    if #history > HISTORY_MAX then table.remove(history, 1) end
    mp.testSet('lastChatLine', line)
    ui.showMessage(line)
    if chatElement then
        destroyChat()
        createChat()
    end
end

local function pollHarness()
    local cmd = mp.testPollCommand()
    if type(cmd) == 'string' then
        local text = cmd:match('^chat:(.*)$')
        if text and text ~= '' then
            core.sendGlobalEvent('mpChatSend', { text = text })
        end
    end
end

return {
    engineHandlers = {
        onKeyPress = function(key)
            if key.symbol == 't' and not I.UI.getMode() then
                toggleChat()
            end
        end,
        onFrame = pollHarness, -- runs while paused too — the harness must not stall in menus
    },
    eventHandlers = {
        MP_UiChatMessage = pushMessage,
        UiModeChanged = function(data)
            -- Esc (or any other window) closed our Interface mode -> drop the chat window.
            if chatElement and data.newMode == nil then
                destroyChat()
            end
        end,
    },
}
