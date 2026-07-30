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
local identity = require('scripts.mp.identity')

local HISTORY_MAX = 8

-- Chat is presented by the HTML overlay (index.html), not MyGUI. This script is the BRIDGE:
-- it keeps a rolling log of recent messages mirrored to JS (window.__omwMP.chatLog + a bumped
-- chatSeq the overlay polls) and, on the T key, raises an openChat signal the overlay polls.
-- Outgoing lines come back from the overlay as 'chatx:<channel>:<to>:<text>' commands, parsed
-- in pollHarness. Raw fields are mirrored (channel/from/to/text) so the HTML formats/colours.
local CHAT_LOG_MAX = 50
local chatHistory = {}
local chatSeq = 0
local chatOpenSeq = 0

local function pushMessage(data)
    chatHistory[#chatHistory + 1] = {
        channel = tostring(data.channel or 'say'),
        from = data.from and tostring(data.from) or nil,
        to = data.to and tostring(data.to) or nil,
        text = tostring(data.text or ''),
    }
    if #chatHistory > CHAT_LOG_MAX then table.remove(chatHistory, 1) end
    chatSeq = chatSeq + 1
    mp.testSet('chatLog', json.encode(chatHistory))
    -- testSet is (string, string) ONLY — a number here THROWS, and a throwing handler
    -- disables its whole subsystem (this exact line killed chat + T until s99 caught it).
    mp.testSet('chatSeq', tostring(chatSeq))
    -- lastChatLine keeps its long-standing contract: the FORMATTED line as shown, carrying
    -- the sender's attribution (s03-chat asserts on it). The HTML overlay renders from
    -- chatLog's structured fields instead; this mirror is for the harness and legacy checks.
    local ch = tostring(data.channel or 'say')
    local line
    if ch == 'server' then
        line = '* ' .. tostring(data.text or '')
    elseif ch == 'whisper' and data.to and data.to ~= '' then
        line = '-> ' .. tostring(data.to) .. ': ' .. tostring(data.text or '')
    else
        line = tostring(data.from or '?') .. ': ' .. tostring(data.text or '')
    end
    mp.testSet('lastChatLine', line)
end

-- T raises a signal; the HTML overlay owns the input, focus and cursor. No MyGUI window.
local function toggleChat()
    chatOpenSeq = chatOpenSeq + 1
    mp.testSet('openChat', tostring(chatOpenSeq)) -- testSet takes strings only
end

-- --- M7: server-pushed GUI (PROTOCOL.md §M7 GuiMessageBox/GuiInputDialog/GuiListBox) ----
-- openmw.ui is PLAYER context, so the global hub routes the body here and the answer goes
-- back out through it. Every dialog is answered exactly once: the server settles a guiId on
-- reply, timeout or disconnect, and a second reply for the same id is dropped there.
local guiElement = nil
local guiCurrent = nil -- {guiId=, kind=, items=}
local guiDraft = ''

local function destroyGui()
    if guiElement then
        guiElement:destroy()
        guiElement = nil
    end
    guiCurrent = nil
    guiDraft = ''
    I.UI.removeMode('Interface')
    mp.testSet('gui', '')
end

local function guiAnswer(data)
    if not guiCurrent then return end
    core.sendGlobalEvent('mpGuiReply', { guiId = guiCurrent.guiId, data = data })
    mp.testSet('guiAnswered', json.encode({ guiId = guiCurrent.guiId, data = data }))
    destroyGui()
end

local function guiRow(text, onClick)
    local row = {
        template = I.MWUI.templates.textNormal,
        props = { text = text },
    }
    if onClick then
        row.events = { mouseClick = async:callback(onClick) }
    end
    return row
end

local function showGui(data)
    destroyGui()
    guiCurrent = { guiId = data.guiId, kind = data.kind, items = data.items }
    local rows = {}
    if data.kind == 'messagebox' then
        rows[#rows + 1] = guiRow(tostring(data.text or ''))
        local buttons = data.buttons or {}
        if #buttons == 0 then buttons = { 'OK' } end
        for i, label in ipairs(buttons) do
            rows[#rows + 1] = guiRow('[ ' .. tostring(label) .. ' ]', function()
                guiAnswer({ button = i - 1, label = tostring(label) }) -- 0-based: plugin convention
            end)
        end
    elseif data.kind == 'input' then
        rows[#rows + 1] = guiRow(tostring(data.label or ''))
        rows[#rows + 1] = {
            template = I.MWUI.templates.textEditLine,
            props = { text = '', size = util.vector2(400, 0) },
            events = {
                textChanged = async:callback(function(text) guiDraft = text end),
                keyPress = async:callback(function(e)
                    if e.code == input.KEY.Enter then guiAnswer({ text = guiDraft }) end
                end),
            },
        }
    elseif data.kind == 'list' then
        rows[#rows + 1] = guiRow(tostring(data.label or ''))
        for i, item in ipairs(data.items or {}) do
            rows[#rows + 1] = guiRow(i .. '. ' .. tostring(item), function()
                guiAnswer({ index = i - 1, item = tostring(item) })
            end)
        end
    else
        return
    end
    I.UI.setMode('Interface', { windows = {} })
    guiElement = ui.create {
        layer = 'Windows',
        template = I.MWUI.templates.boxSolid,
        props = { position = util.vector2(200, 200) },
        content = ui.content {
            {
                type = ui.TYPE.Flex,
                props = { horizontal = false, autoSize = true },
                content = ui.content(rows),
            },
        },
    }
    mp.testSet('gui', json.encode({
        guiId = data.guiId, kind = data.kind,
        text = data.text or data.label or '',
        items = data.items or data.buttons or {},
    }))
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
local pendingTestEquip = nil -- harness 'equip:<id>:<slot>': equip once the grant lands

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
        identity.reset() -- and the identity diffs re-upload
        return
    end
    local now = core.getRealTime()
    identity.tick(now) -- M2: appearance/equipment/stats/inventory diff broadcasts
    identity.equipRetryTick(now)

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

local function testEquipTick()
    if not pendingTestEquip then return end
    local now = core.getRealTime()
    for _, item in ipairs(types.Actor.inventory(self):getAll()) do
        if item.recordId == pendingTestEquip.id then
            types.Actor.setEquipment(self, { [pendingTestEquip.slot] = pendingTestEquip.id })
            pendingTestEquip = nil
            return
        end
    end
    if now > pendingTestEquip.until_ then
        print('[mp] test equip timed out waiting for ' .. pendingTestEquip.id)
        pendingTestEquip = nil
    end
end

local function pollHarness()
    local cmd = mp.testPollCommand()
    if type(cmd) == 'string' then
        -- Phase C: 'social:<Op>:<arg>'. The arg is a display NAME for FriendRequest and
        -- BlockAdd (what a player types) and an ACCOUNT KEY for everything else, matching
        -- the server contract.
        local sop, sarg = cmd:match('^social:([%a]+):(.*)$')
        if sop then
            local byName = (sop == 'FriendRequest' or sop == 'BlockAdd')
            -- The arg does NOT always belong in name/acct. PresenceMode reads `mode` and
            -- SetAvailability reads `state` on the server, so routing their argument into
            -- `acct` meant the server saw an empty value and refused with no_such_player --
            -- silently, because SocialResult is not surfaced. The privacy control had
            -- therefore never worked. Route by what each op actually reads.
            local FIELD = { PresenceMode = 'mode', SetAvailability = 'state', PartyTravel = 'target' }
            local field = FIELD[sop]
            local body = { op = sop }
            if field then body[field] = sarg
            elseif byName then body.name = sarg
            else body.acct = sarg end
            core.sendGlobalEvent('mpSocial', body)
        end

        local uiWhich = cmd:match('^openui:(%a+)$')
        if uiWhich then core.sendGlobalEvent('mpOpenUi', { which = uiWhich }) end

        -- Test hook: switch the Social hub's tab. The harness cannot click, so without this
        -- the Worlds tab could only ever be verified by reading state, never by looking at
        -- what a player would actually see.
        local socialTab = cmd:match('^socialtab:(%a+)$')
        if socialTab then core.sendGlobalEvent('mpSocialTab', { tab = socialTab }) end

        -- Test hook: create a world through the same uplink the Worlds tab's button uses.
        -- The harness cannot type into the name field, so without this the create path
        -- could only be tested at the protocol level, never as the player experiences it.
        -- Test hook: press the Worlds tab's "join" button for a world by id. The harness
        -- cannot click, and the join path (disconnect + redial a different world) is the
        -- one thing about the tab a player would notice most if it were broken.
        -- Test hook: drop the transport without killing the server, so the AUTOMATIC redial
        -- can be observed. s92 kills the server instead; here the world must stay up,
        -- because the question is WHICH world the client comes back to.
        if cmd == 'netdrop' then core.sendGlobalEvent('mpNetDrop', {}) end

        -- Test hook for the multiplayer console gate. Goes through the engine's own
        -- executeAction(A_Console) — the same entry point the keybind uses — then mirrors
        -- what the ENGINE says about console state, so the assertion is on real state and
        -- not on how a screenshot looks.
        if cmd == 'console:request' then
            mp.requestConsole()
            mp.testSet('consoleOpen', tostring(mp.isConsoleOpen()))
        end

        local joinId = cmd:match('^worldjoin:([%w_-]+)$')
        if joinId then core.sendGlobalEvent('mpSocialJoinById', { id = joinId }) end

        local wcId, wcMode = cmd:match('^worldcreate:([%w_-]+):(%a+)$')
        if wcId then
            core.sendGlobalEvent('mpSocial', { op = 'WorldCreate', id = wcId, mode = wcMode })
        end

        -- Character slots + party travel test hooks: the same uplinks the Characters tab
        -- and the Party tab's travel buttons use.
        local ccName = cmd:match('^charcreate:(.+)$')
        if ccName then core.sendGlobalEvent('mpCharCreate', { name = ccName }) end
        local csId = cmd:match('^charswitch:(%w+)$')
        if csId then core.sendGlobalEvent('mpCharSwitch', { id = csId }) end
        if cmd == 'chars' then core.sendGlobalEvent('mpChars', {}) end
        -- Party voice: the JS mesh emits 'voice:<acct>:<kind>:<payload>' through the same
        -- command channel the harness uses. Payload is SDP/ICE JSON and may contain
        -- colons, so it is captured greedily as the remainder.
        local vAcct, vKind, vPayload = cmd:match('^voice:([^:]+):([^:]+):(.*)$')
        if vAcct then
            core.sendGlobalEvent('mpSocial', {
                op = 'VoiceSignal', acct = vAcct, kind = vKind, payload = vPayload,
            })
        end
        local voiceOp = cmd:match('^voicectl:(%a+)$')
        if voiceOp then core.sendGlobalEvent('mpVoice', { op = voiceOp }) end

        local ptTarget = cmd:match('^partytravel:(%a+)$')
        if ptTarget then core.sendGlobalEvent('mpSocial', { op = 'PartyTravel', target = ptTarget }) end

        local text = cmd:match('^chat:(.*)$')
        if text and text ~= '' then
            core.sendGlobalEvent('mpChatSend', { text = text })
        end

        -- HTML overlays drive these through the same command channel. 'chatx:<channel>:<to>:
        -- <text>' carries the chat channel selector + whisper target; text is greedy (may
        -- contain colons). Empty `to` for non-whisper channels.
        local cxCh, cxTo, cxText = cmd:match('^chatx:([%a]+):([^:]*):(.*)$')
        if cxCh and cxText ~= '' then
            core.sendGlobalEvent('mpChatSend', { text = cxText, channel = cxCh, to = cxTo })
        end
        -- Where-am-I switcher (solo/party/public/online/offline).
        local whereMode = cmd:match('^where:(%a+)$')
        if whereMode then core.sendGlobalEvent('mpWhere', { mode = whereMode }) end
        -- Availability toggle.
        local availState = cmd:match('^avail:(%a+)$')
        if availState then core.sendGlobalEvent('mpSocial', { op = 'SetAvailability', state = availState }) end
        -- Onboarding: pick the public handle. 'profile:<email>:<username>' — email first
        -- because a username can never contain ':' (validUsername) while an email can't
        -- either, and the email is echoed back from what the server already told us.
        local pEmail, pUser = cmd:match('^profile:([^:]*):(.+)$')
        if pUser then
            core.sendGlobalEvent('mpProfileSetup', { email = pEmail, username = pUser })
        end

        -- Cross-world join a friend.
        local jfAcct = cmd:match('^joinfriend:(.+)$')
        if jfAcct then core.sendGlobalEvent('mpSocial', { op = 'JoinFriend', acct = jfAcct }) end
        -- Owner in-place Solo<->Party flip of their own world.
        local wmMode = cmd:match('^worldmode:(%a+)$')
        if wmMode then core.sendGlobalEvent('mpSocial', { op = 'SetWorldMode', mode = wmMode }) end
        -- Cursor handshake for the HTML overlays: when the overlay opens it asks the engine to
        -- enter Interface mode (frees the mouse cursor + suspends game input, no pause); on
        -- close it restores. This is what lets clicking/typing in the HTML panel not also drive
        -- the game behind it.
        local ui_mode = cmd:match('^uimode:(%a+)$')
        if ui_mode == 'on' then I.UI.setMode('Interface', { windows = {} })
        elseif ui_mode == 'off' then I.UI.removeMode('Interface') end
        -- Opt-in pause for an overlay that must stop the world, used by the pre-chargen intro.
        -- disableMenuPause() below turns pause OFF for every mode because pausing only your own
        -- client while the server and everyone else keep moving is wrong in multiplayer. That
        -- reasoning does not hold before character creation: you are alone in your own private
        -- world, and a modal you cannot dismiss while something walks up to you is worse.
        -- Paired with uimode, so the pause can never outlive the overlay that asked for it.
        local pause_mode = cmd:match('^pause:(%a+)$')
        if pause_mode == 'on' then
            I.UI.setPauseOnMode('Interface', true)
            I.UI.setMode('Interface', { windows = {} })
        elseif pause_mode == 'off' then
            I.UI.removeMode('Interface')
            I.UI.setPauseOnMode('Interface', false)
        end
        if cmd == 'cam:3p' then -- visual scenarios: put own avatar in frame
            local camera = require('openmw.camera')
            camera.setMode(camera.MODE.ThirdPerson)
        end
        -- M2 test hooks. equip:<recordId>:<slot> grants (via global) then equips; sethp:<n>
        -- drives the death path (0 = die); applyrace:<race>:<head>:<hair> exercises the
        -- chargen rebuild for the identity scenarios.
        local grantId, grantSlot = cmd:match('^equip:([^:]+):(%d+)$')
        if grantId then
            core.sendGlobalEvent('mpGrantItem', { id = grantId })
            pendingTestEquip = { id = grantId, slot = tonumber(grantSlot), until_ = core.getRealTime() + 5 }
        end
        if cmd == 'equiptest' then -- demo content has no items; global creates one
            core.sendGlobalEvent('mpTestItem', {})
        end
        local hp = cmd:match('^sethp:(-?[%d.]+)$')
        if hp then
            types.Actor.stats.dynamic.health(self).current = tonumber(hp)
        end
        local race, head, hair = cmd:match('^applyrace:([^:]+):([^:]+):([^:]*)$')
        if race then
            mp.applyChargen({ race = race, head = head, hair = hair, isMale = true })
        end
        -- M3 test hooks (world objects; all resolved in the GLOBAL script).
        local dropId = cmd:match('^drop:(.+)$')
        if dropId then core.sendGlobalEvent('mpDropItem', { id = dropId }) end
        local takeNet = cmd:match('^takenet:(%d+)$')
        if takeNet then core.sendGlobalEvent('mpTakeNet', { netId = tonumber(takeNet) }) end
        if cmd == 'chest:spawn' then core.sendGlobalEvent('mpSpawnChest', {}) end
        local openNet = cmd:match('^chest:open:?(%d*)$')
        if openNet then core.sendGlobalEvent('mpChestOpen', { netId = tonumber(openNet) }) end
        local putId = cmd:match('^chest:put:(.+)$')
        if putId then core.sendGlobalEvent('mpChestPut', { id = putId }) end
        -- netId FIRST (may be empty = "my own chest"): record ids can contain colons
        -- (dynamic records are named like "Generated:0x0").
        local takeChestNet, takeId = cmd:match('^chesttake:(%d*):(.+)$')
        if takeId then
            core.sendGlobalEvent('mpChestTake', { id = takeId, netId = tonumber(takeChestNet) })
        end
        -- M5: hit a player (hitp:<playerId>:<dmg>) or an NPC (hitn:<recordId>:<dmg>).
        local hitPid, hitPdmg = cmd:match('^hitp:(%d+):([%d.]+)$')
        if hitPid then
            core.sendGlobalEvent('mpTestHit', { playerId = tonumber(hitPid), damage = tonumber(hitPdmg) })
        end
        local hitRec, hitNdmg = cmd:match('^hitn:(.+):([%d.]+)$')
        if hitRec then
            core.sendGlobalEvent('mpTestHit', { record = hitRec, damage = tonumber(hitNdmg) })
        end
        local killNpc = cmd:match('^killnpc:(.+)$')
        if killNpc then core.sendGlobalEvent('mpKillNpc', { id = killNpc }) end
        if cmd == 'door:toggle' then core.sendGlobalEvent('mpDoorToggle', {}) end
        local lockLevel = cmd:match('^door:lock:(%d+)$')
        if lockLevel then core.sendGlobalEvent('mpDoorLock', { level = tonumber(lockLevel) }) end
        if cmd == 'door:unlock' then core.sendGlobalEvent('mpDoorUnlock', {}) end
        local countId = cmd:match('^count:(.+)$')
        if countId then
            local ok, n = pcall(function()
                return types.Actor.inventory(self):countOf(countId)
            end)
            mp.testSet('count', tostring(ok and n or -1))
        end
        -- M7/M8 hooks (all resolved in the GLOBAL script).
        local restHours = cmd:match('^rest:([%d.]+)$')
        if restHours then core.sendGlobalEvent('mpTestRest', { hours = tonumber(restHours) }) end
        local recName = cmd:match('^mkrec:(.+)$')
        if recName then core.sendGlobalEvent('mpTestRecord', { name = recName }) end
        local localRec = cmd:match('^mklocal:(.+)$')
        if localRec then
            core.sendGlobalEvent('mpTestRecord', { name = localRec, noRegister = true })
        end
        local spellName = cmd:match('^mkspell:(.+)$')
        if spellName then core.sendGlobalEvent('mpTestSpell', { name = spellName }) end
        local enchName = cmd:match('^mkench:(.+)$')
        if enchName then core.sendGlobalEvent('mpTestEnchanted', { name = enchName }) end
        local weatherIdx = cmd:match('^weather:(%d+)$')
        if weatherIdx then core.sendGlobalEvent('mpTestWeather', { index = tonumber(weatherIdx) }) end
        local adminCmd = cmd:match('^admin:(.+)$')
        if adminCmd then
            local parts = {}
            for word in adminCmd:gmatch('%S+') do parts[#parts + 1] = word end
            local name = table.remove(parts, 1)
            core.sendGlobalEvent('mpTestAdmin', { cmd = name, args = parts })
        end
        local guiPick = cmd:match('^guireply:(%d+)$')
        if guiPick and guiCurrent then
            local n = tonumber(guiPick)
            if guiCurrent.kind == 'input' then
                guiAnswer({ text = 'reply' .. tostring(n) })
            elseif guiCurrent.kind == 'list' then
                guiAnswer({ index = n, item = tostring((guiCurrent.items or {})[n + 1] or '') })
            else
                guiAnswer({ button = n })
            end
        end
        -- M6 quest-layer hooks (all resolved in the GLOBAL script).
        local questId, questStage = cmd:match('^quest:(.+):(%d+)$')
        if questId then
            core.sendGlobalEvent('mpTestQuest', { id = questId, stage = tonumber(questStage) })
        end
        local gvarName, gvarValue = cmd:match('^gvar:([^:]+):(-?[%d.]+)$')
        if gvarName then
            core.sendGlobalEvent('mpTestGlobal', { name = gvarName, value = tonumber(gvarValue) })
        end
        local bountyN = cmd:match('^bounty:(%d+)$')
        if bountyN then core.sendGlobalEvent('mpTestBounty', { n = tonumber(bountyN) }) end
        local facId, facRank = cmd:match('^faction:([^:]+):(%d+)$')
        if facId then
            core.sendGlobalEvent('mpTestFaction', { id = facId, rank = tonumber(facRank) })
        end
        local mvRec, mvName, mvVal = cmd:match('^mvar:([^:]+):([^:]+):(-?[%d.]+)$')
        if mvRec then
            core.sendGlobalEvent('mpTestMemberVar',
                { id = mvRec, name = mvName, value = tonumber(mvVal) })
        end
        if cmd == 'dlg:release' then
            core.sendGlobalEvent('mpDialogueClosed', {})
        else
            local dlgId = cmd:match('^dlg:(.+)$')
            if dlgId then core.sendGlobalEvent('mpTestDialogue', { id = dlgId }) end
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

-- Multiplayer never pauses the LOCAL world when a menu is open. Pausing only your own client
-- would freeze your view while the server-authoritative sim and every other player keep
-- moving — and we want one uniform feel across private/party/public, so the pause menu, the
-- Social hub, inventory, dialogue, the map, etc. all leave the world running. This flips the
-- default in scripts/omw/ui.lua (every mode pauses) off for all modes. The modePause table it
-- writes is per-session and not persisted, so we re-apply on every init and load. Only the MP
-- content loads this script, so the offline demo/single-player still pauses as normal.
local function disableMenuPause()
    for _, mode in pairs(I.UI.MODE) do
        I.UI.setPauseOnMode(mode, false)
    end
end

return {
    engineHandlers = {
        onInit = disableMenuPause,
        onLoad = disableMenuPause,
        -- M6: the ONLY quest-layer signal that is player-context-only. Forward it to the
        -- global hub (scripts/mp/quests.lua), which owns the journal cache + echo guard.
        onQuestUpdate = function(questId, stage)
            core.sendGlobalEvent('mpQuestUpdate', { questId = questId, stage = stage })
        end,
        onKeyRelease = function(key)
            -- Push-to-talk release. Paired with onKeyPress below; PTT is the default so a
            -- player is never transmitting because they forgot a toggle.
            if key.symbol == 'v' then core.sendGlobalEvent('mpVoice', { op = 'talk', on = false }) end
        end,
        onKeyPress = function(key)
            if key.symbol == 't' and not I.UI.getMode() then
                toggleChat()
            elseif key.symbol == 'v' and not I.UI.getMode() then
                core.sendGlobalEvent('mpVoice', { op = 'talk', on = true })
            end
        end,
        onFrame = function() -- runs while paused too — the harness must not stall in menus
            pollHarness()
            walkTick()
            testEquipTick()
            movementTick()
        end,
    },
    eventHandlers = {
        MP_UiChatMessage = pushMessage,
        -- M2 rejoin restore: global.lua forwards SessionWelcome.playerRecord here (after
        -- granting the inventory and teleporting us to record.position).
        MP_ApplyRecord = function(record)
            identity.applyRecord(record)
        end,
        -- Test hook: dynamic record created by global.lua (equiptest) — equip as a helmet.
        MP_TestItem = function(data)
            pendingTestEquip = { id = data.id, slot = 0, until_ = core.getRealTime() + 5 }
        end,
        -- M2 respawn: global.lua already teleported us; revive + optionally top up stats.
        -- M7: a server/plugin dialog. One at a time — a new push replaces the old element,
        -- and the server settles the abandoned guiId by timeout.
        MP_Gui = function(data)
            showGui(data)
        end,
        MP_DoResurrect = function(data)
            mp.resurrect()
            if data and data.restoreHp then
                local d = types.Actor.stats.dynamic
                d.health(self).current = d.health(self).base
                d.magicka(self).current = d.magicka(self).base
                d.fatigue(self).current = d.fatigue(self).base
            end
        end,
        UiModeChanged = function(data)
            -- Esc (or any other window) closed our Interface mode -> drop the chat window.
            if chatElement and data.newMode == nil then
                destroyChat()
            end
            -- M6: leaving the dialogue window releases the NPC's conversation lock
            -- (PROTOCOL.md §M6: "released on close, cell change, or disconnect").
            if data.oldMode == 'Dialogue' and data.newMode ~= 'Dialogue' then
                core.sendGlobalEvent('mpDialogueClosed', {})
            end
        end,
    },
}
