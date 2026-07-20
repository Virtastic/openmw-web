-- Multiplayer PLAYER script: chat window + input, harness command poll (M0), and the
-- own-pose sampler (M1) that feeds PlayerMove/PlayerCellChange to the server.
-- T toggles the chat window (mouse is freed via the Interface UI mode); click the input
-- line, type, Enter sends. Incoming messages also pop as screen messages so chat is
-- visible without the window open.
local core = require('openmw.core')
local ui = require('openmw.ui')
local util = require('openmw.util')
local async = require('openmw.async')
local input = require('openmw.input')
local types = require('openmw.types')
local mp = require('openmw.mp')
local I = require('openmw.interfaces')
local self = require('openmw.self')

local json = require('scripts.mp.json')

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

-- --- M1: own-pose sampler -> PlayerMove (0x0100) + PlayerCellChange ---------------------
-- ~15 Hz real-time while moving, plus edge-triggered sends on jump and on stop. Kept well
-- under the server's 40 msg/s movement budget.
local SEND_INTERVAL = 1 / 15
local POSE_MIRROR_INTERVAL = 0.5 -- 2 Hz test-surface mirror

local lastSend = 0
local lastSentPos = nil
local lastSentYaw = nil
local wasMoving = false
local jumpQueued = false
local prevJumpCtl = false
local lastCellKey = nil
local lastPoseMirror = 0
local walkCmd = nil -- harness 'walk:<dx>,<dy>,<ms>' injection

local function cellKey()
    local cell = self.cell
    if not cell then return nil end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

local function poseFlags()
    local flags = 0
    if self.controls.run then flags = flags + 1 end -- bit0
    if self.controls.sneak then flags = flags + 2 end -- bit1
    if jumpQueued then flags = flags + 4 end -- bit2 jump-edge
    if not types.Actor.isOnGround(self) then flags = flags + 8 end -- bit3 inAir
    local stance = types.Actor.getStance(self)
    if stance == types.Actor.STANCE.Weapon then flags = flags + 16 end -- bit4
    if stance == types.Actor.STANCE.Spell then flags = flags + 32 end -- bit5
    return flags
end

local function sendPose(now)
    local pos = self.position
    local yaw = self.rotation:getYaw()
    local walkSpeed = types.Actor.getWalkSpeed(self)
    local animVel = walkSpeed > 0 and (types.Actor.getCurrentSpeed(self) / walkSpeed) or 0
    mp.sendMove({
        x = pos.x,
        y = pos.y,
        z = pos.z,
        yaw = yaw,
        pitch = self.rotation:getPitch(),
        flags = poseFlags(),
        animVel = animVel,
    })
    jumpQueued = false
    lastSend = now
    lastSentPos = pos
    lastSentYaw = yaw
end

local function movementTick()
    if mp.status().state ~= 'Joined' then
        lastCellKey = nil -- rejoin resends PlayerCellChange (required to become visible)
        return
    end
    local now = core.getRealTime()

    -- PlayerCellChange: immediately once Joined (before it we are invisible and receive no
    -- batches), then on every cell change.
    local key = cellKey()
    if key and key ~= lastCellKey then
        lastCellKey = key
        local pos = self.position
        mp.sendEvent('PlayerCellChange', { cellKey = key, x = pos.x, y = pos.y, z = pos.z })
    end

    -- Jump edge: send the same frame the jump control rises.
    local jumpCtl = self.controls.jump
    if jumpCtl and not prevJumpCtl then
        jumpQueued = true
        sendPose(now)
    elseif now - lastSend >= SEND_INTERVAL then
        local pos = self.position
        local yaw = self.rotation:getYaw()
        local moving = lastSentPos == nil
            or (pos - lastSentPos):length2() > 0.25
            or math.abs(yaw - (lastSentYaw or yaw)) > 0.005
        if moving or wasMoving then -- 'wasMoving and not moving' = the stop-edge send
            sendPose(now)
        end
        wasMoving = moving
    end
    prevJumpCtl = jumpCtl

    if now - lastPoseMirror >= POSE_MIRROR_INTERVAL then
        lastPoseMirror = now
        local p = self.position
        mp.testSet('pose', json.encode({ x = p.x, y = p.y, z = p.z }))
    end
end

-- Harness walk injection: overrides the omw input controls for the duration so the two
-- writers can't fight over self.controls (I.Controls.overrideMovementControls).
local function walkTick()
    if not walkCmd then return end
    if core.getRealTime() >= walkCmd.stopAt then
        self.controls.movement = 0
        self.controls.sideMovement = 0
        I.Controls.overrideMovementControls(false)
        walkCmd = nil
        return
    end
    self.controls.movement = walkCmd.dy
    self.controls.sideMovement = walkCmd.dx
    self.controls.run = walkCmd.run
end

local function pollHarness()
    local cmd = mp.testPollCommand()
    if type(cmd) == 'string' then
        local text = cmd:match('^chat:(.*)$')
        if text and text ~= '' then
            core.sendGlobalEvent('mpChatSend', { text = text })
        end
        if cmd == 'cam:3p' then -- visual scenarios: put own avatar in frame
            local camera = require('openmw.camera')
            camera.setMode(camera.MODE.ThirdPerson)
        end
        local dx, dy, ms = cmd:match('^walk:(-?[%d.]+),(-?[%d.]+),(%d+)$')
        if dx then
            walkCmd = {
                dx = tonumber(dx),
                dy = tonumber(dy),
                run = false,
                stopAt = core.getRealTime() + tonumber(ms) / 1000,
            }
            I.Controls.overrideMovementControls(true)
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
        onFrame = function() -- runs while paused too — the harness must not stall in menus
            pollHarness()
            walkTick()
            movementTick()
        end,
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
