-- Multiplayer GLOBAL orchestrator (omw-mp/1, M0+M1) — see server/PROTOCOL.md.
-- Connects on game start when the boot JS enabled MP (?mp= -> ENV OPENMW_MP_URL), drives the
-- session via scripts/mp/net.lua, maintains the player roster and forwards chat to the
-- player script. M1: owns remote-player puppet lifecycle (spawn/despawn/teleport) and routes
-- MP_MoveBatch entries to the per-puppet scripts. Mirrors {state, playerId, players, puppets}
-- into window.__omwMP for the harness.
local core = require('openmw.core')
local mp = require('openmw.mp')
local types = require('openmw.types')
local I = require('openmw.interfaces')
local util = require('openmw.util')
local world = require('openmw.world')

local json = require('scripts.mp.json')
local net = require('scripts.mp.net')

-- Where-am-I switcher state. `worldUrls.own` = this character's own world (Solo/Party — the
-- same instance, mode-flipped in place). `pendingFlip` defers a Solo<->Party flip until we
-- are back in our own world.
local worldUrls = {}
local pendingFlip = nil

-- Chargen gate: multiplayer surfaces (chat, social, leaving your solo world) unlock only once
-- character creation is DONE (race/class/sign chosen — mwscript CharGenState == -1). Mirrored
-- to JS so the HTML overlays hide themselves until then; mpWhere refuses too. Never un-done:
-- once true it stays true for the session (an existing character starts at -1 immediately).
local chargenDone = false
local chargenReported = false
-- Build the URL to dial for a world entry.
--
-- PREFER wsPath: production publishes NO world ports (the edge reaches only the gateway on
-- 443, deploy/openmw-mp.caddy), so a world is reachable solely by asking the gateway to
-- splice us through — `/w/<worldId>` on the origin we are already connected to. Falling back
-- to host:port keeps a direct local connection working, where the ports ARE published.
local function worldUrlOf(w)
    if type(w) ~= 'table' then return nil end
    if type(w.wsPath) == 'string' and w.wsPath ~= '' then
        -- Same scheme and authority as the current connection: wss stays wss, so a page on
        -- https never tries to open an insecure socket.
        local cur = net.currentTarget() or ''
        local scheme, authority = cur:match('^(wss?)://([^/]+)')
        if scheme and authority then return scheme .. '://' .. authority .. w.wsPath end
    end
    if w.host and w.port then
        return 'ws://' .. tostring(w.host) .. ':' .. string.format('%d', w.port) .. '/ws'
    end
    return nil
end

local function chargenTick()
    -- RE-REPORT ON EVERY CONNECTION, not once per process. identity.reset() shuts the baseline
    -- gate whenever we are not Joined, and for a brand new character MP_ChargenDone is the only
    -- thing that reopens it -- so a character that finished creation and then merely RECONNECTED
    -- (same process, so no page reload) would find the gate shut and nothing to reopen it, and
    -- would silently stop persisting anything. The send is idempotent by design, which is what
    -- makes re-reporting the safe direction.
    if net.state ~= 'Joined' then chargenReported = false end
    if chargenDone and chargenReported then return end
    if not chargenDone then
        local ok, v = pcall(function() return world.mwscript.getGlobalVariables()['chargenstate'] end)
        if ok and v == -1 then
            chargenDone = true
            mp.testSet('chargenDone', '1')
            -- Tell the PLAYER script too, not just the server. identity.lua holds the persistent
            -- halves of the sync (attributes, skills, level, spellbook, inventory) and keeps them
            -- silent until it knows what this character is -- otherwise it broadcasts the raw
            -- template the engine starts with (every attribute 30, every skill 5, hand-to-hand
            -- 100) and the server stores that over the real character, permanently. A returning
            -- character opens that gate when its record finishes applying; a BRAND NEW one has no
            -- record to apply, and this is the only other moment it stops being a template.
            local p = world.players[1]
            if p then p:sendEvent('MP_ChargenDone', {}) end
        end
    end
    -- Tell the server creation FINISHED for this slot: until this lands the character is
    -- provisional, and abandoning creation resets it instead of saving a half-made one.
    -- Re-sent each session (idempotent) so pre-flag characters self-migrate.
    if chargenDone and not chargenReported and net.state == 'Joined' then
        mp.sendEvent('ChargenComplete', {})
        chargenReported = true
    end
end
local objects = require('scripts.mp.objects')
local actors = require('scripts.mp.actors')
local combat = require('scripts.mp.combat')
local quests = require('scripts.mp.quests')
local worldmp = require('scripts.mp.world')
local admin = require('scripts.mp.admin')

local roster = {} -- array of {id=u16, name=string}, server order
-- Monotonic across every "this was done TO you" event (world closed). The UI
-- compares THIS, not the payload: the payloads repeat verbatim, so value comparison could not
-- tell a second occurrence from a stale mirror.
local noticeSeq = 0
-- Said once per session, not once per join: a world switch and every reconnect re-enter the
-- Joined state, and repeating the banner buried the actual conversation.
local announcedConnect = false
-- What the world we are connected to says it is. SERVER-OWNED: the switcher used to render
-- from a localStorage note of what was last clicked, so it could sit on "Public" while the
-- connection was to your own world and no amount of clicking fixed it.
local worldMode = 'solo'

local function mirrorRoster()
    mp.testSet('players', json.encode(roster))
    -- WHO WE ARE, by id. The UI used to filter itself out of the Players list by comparing
    -- the roster name against the character name it was booted with — and those are two
    -- different strings now that the roster carries USERNAMES, so players saw themselves
    -- with add-friend/party/mute/block buttons. The connection id is the only identity both
    -- sides agree on.
    mp.testSet('selfId', tostring(net.playerId or ''))
    -- WHICH WORLD WE ARE ACTUALLY IN. The switcher used to render from a localStorage value
    -- of what the player last CLICKED, which survives reloads and reconnects — so after a
    -- redial to your own world the panel still read "Public" and the whole UI lied about
    -- where you were. The dialled target is the truth; publish it.
    mp.testSet('whereNow', worldMode == 'party' and 'party' or 'solo')
    -- The social hub lists everyone currently playing, and the roster lives here. Forwarded
    -- rather than duplicated so there is one source of truth for who is online.
    local player = world.players[1]
    if player then player:sendEvent('MP_Roster', { players = roster }) end
end

local function playerScript()
    return world.players[1]
end

-- G2 render LOD. Everyone stays VISIBLE; distance buys a cheaper simulation, not a
-- despawn. Tiers reuse the server's network-LOD radii (delivered in SessionWelcome) so a
-- puppet whose poses arrive at 1 Hz is never simultaneously asked to walk smoothly between
-- them — matching the two is what makes the degradation look deliberate instead of broken.
-- Radii are squared once per batch, never per puppet.
local TIER_NEAR, TIER_MID, TIER_FAR = 0, 1, 2
-- Counts are keyed by NAME, not by the numeric tier: a Lua table keyed {[0]=n} serialises
-- as an empty object (json sees no index 1 and calls it an empty array), so the numeric
-- version mirrored "{}" no matter how many avatars were degraded — and a test asserting
-- "nobody was degraded" then passed against no data at all.
local TIER_NAME = { [0] = 'near', [1] = 'mid', [2] = 'far' }
local tierSeen = {} -- tier name -> count, reset each batch (mirrored for the capacity tests)
local d2Buf, nearBuf, entryBuf = {}, {}, {} -- scratch, reused across batches (runs 15x/second)

-- The near RADIUS alone does not bound cost, and the case where it fails is the one that
-- matters: in a tight crowd — a market square, a guild hall, everyone piling onto one
-- quest giver — every avatar is inside the near radius, so every avatar stays fully
-- simulated and frame time scales with the crowd exactly as it did before any of this.
-- The cap fixes the worst case regardless of how players cluster: at most `maxNear`
-- avatars are ever fully simulated, and the nearest ones win. Returns the effective
-- squared near cutoff for this batch.
local function nearCutoff(nearR2, maxNear, count)
    if maxNear <= 0 then return nearR2 end -- cap disabled
    local n = 0
    for i = 1, count do
        local d2 = d2Buf[i]
        if d2 >= 0 and d2 <= nearR2 then
            n = n + 1
            nearBuf[n] = d2
        end
    end
    if n <= maxNear then return nearR2 end -- under the cap: radius governs
    for i = n + 1, #nearBuf do nearBuf[i] = nil end -- drop last batch's tail before sorting
    table.sort(nearBuf)
    return nearBuf[maxNear] -- the K-th nearest becomes the cutoff
end

-- teleport() throws when the object is mid-teleport or was removed between the isValid()
-- check and the call, and an engine handler that throws aborts — taking the rest of the
-- handler with it and polluting the error log, which then masks real failures.
--
-- Deliberately different from the removeScript case: THAT pcall hid a permanent API mistake
-- (the binding does not exist on a local self) and should never have been swallowed. This
-- guards a genuinely TRANSIENT engine state, and the position self-corrects — the next pose
-- batch sees the divergence and requests a snap. Returns whether the move happened.
local function tryTeleport(obj, cellArg, pos)
    if not obj or not obj:isValid() or not cellArg then return false end
    local ok = pcall(function() obj:teleport(cellArg, pos) end)
    return ok
end

-- Throttle for MP_CombatRefused: one explanation per situation, not one per swing.
-- Which cell the sim peer is currently standing in, so it only relocates when that changes.
local peerStandingIn = nil
local combatRefusedAt = nil
local COMBAT_REFUSED_EVERY = 8 -- seconds

local function toPlayer(eventName, data)
    local player = playerScript()
    if player then player:sendEvent(eventName, data) end
end

-- Golden-vector dump for the server's LSER codec tests (&mpvectors=1 -> ENV OPENMW_MP_VECTORS).
-- Prints `MPVECTOR:<name>:<base64>` lines to the console log; capture headlessly and feed to
-- the server test suite.
local function dumpVectors()
    local util = require('openmw.util')
    local vectors = {
        { 'bool_true', true },
        { 'bool_false', false },
        { 'num_zero', 0 },
        { 'num_negzero', -0.0 },
        { 'num_neghalf', -0.5 },
        { 'num_int', 42 },
        { 'num_bigint', 2^52 },
        { 'num_huge', 1e300 },
        { 'str_empty', '' },
        { 'str_short', 'hello' },
        { 'str_31', string.rep('a', 31) },
        { 'str_32', string.rep('b', 32) },
        { 'str_255', string.rep('c', 255) },
        { 'str_unicode', 'héllo wörld — ✓ 日本語' },
        { 'table_empty', {} },
        { 'table_flat', { a = 1, b = 'two', c = true } },
        { 'table_nested', { outer = { inner = { deep = 'value', n = 3 } } } },
        { 'table_array', { 10, 20, 30 } },
        { 'table_mixed', { 1, 2, key = 'val' } },
    }
    local ok, vec3 = pcall(function() return util.vector3(1.5, -2.5, 3.25) end)
    if ok then vectors[#vectors + 1] = { 'vec3', vec3 } end
    for _, entry in ipairs(vectors) do
        local okSer, b64 = pcall(mp.debugSerialize, entry[2])
        if okSer then
            print('MPVECTOR:' .. entry[1] .. ':' .. b64)
        else
            print('MPVECTOR-SKIP:' .. entry[1] .. ':' .. tostring(b64))
        end
    end
end

-- Player-visible session notices. State changes can fire before the player object exists
-- (connection races game start), so buffer and flush from onUpdate once world.players[1]
-- is there. Chat lines also pop as screen messages (player.lua pushMessage), so these are
-- visible without the chat window open — that's the whole point for real players.
local pendingNotices = {}

local function notice(text)
    pendingNotices[#pendingNotices + 1] = { channel = 'server', text = text }
end

local function flushNotices()
    if #pendingNotices == 0 then return end
    local player = playerScript()
    if not player then return end
    for _, n in ipairs(pendingNotices) do
        player:sendEvent('MP_UiChatMessage', n)
    end
    pendingNotices = {}
end

-- Human-readable reasons for the codes a real player can actually hit.
local FAIL_TEXT = {
    AUTH_FAILED = 'wrong password for this account name',
    BAD_CONTENT = 'your game data does not match the server',
    BAD_ENGINE = 'your game build does not match the server',
    BAD_PROTO = 'protocol mismatch — update the game or the server',
    SERVER_FULL = 'the server is full',
    BANNED = 'you are banned from this server',
    KICKED = 'you were kicked',
    RATE = 'disconnected for flooding',
    SUPERSEDED = 'this account logged in from somewhere else',
    SHUTDOWN = 'the server shut down',
    UNREACHABLE = 'could not reach the server',
}

local wasJoined = false
-- Admin replies the WINDOW is waiting for (see menuFn). Chat-issued /slash commands leave
-- this at zero and keep their screen notices.
local adminUiPending = 0

-- --- M1: remote-player puppets ---------------------------------------------------------
-- Server rule mirrored client-side: a remote player is visible when in the same cell, or an
-- adjacent exterior grid cell. The server only relays poses/cell-changes of visible players
-- (and force-includes a pose when someone enters the bubble), so the authoritative spawn
-- trigger is simply "first MP_MoveBatch entry for a rostered id"; PlayerCellChange handles
-- teleports and despawns.
-- Same sanctuary objects.lua and the server apply: the opening is driven by Morrowind's own
-- scripts on the actors in these cells, so nothing of ours belongs in them. Kept in step with
-- isChargenCell in scripts/mp/objects.lua and server/src/core/movement.ts.
local function isChargenCell(cellKey)
    local k = string.lower(tostring(cellKey or ''))
    return (k:find('census', 1, true) ~= nil) or (k:find('prison ship', 1, true) ~= nil)
end

local PUPPET_TEMPLATE_ID = 'villager_00' -- demo NPC record (race "Imperial"), neutral kit

local puppets = {} -- id -> {obj=GameObject, name=string}
local remoteCell = {} -- id -> last cellKey (from PlayerCellChange relays)
local lastPose = {} -- id -> last known {x=, y=, z=}
local remoteIdentity = {} -- id -> {appearance=, equipment=, dynamic=} (M2; kept across spawns)
local puppetRecordIds = {} -- identity fingerprint -> generated NPC record id (immutable)
local ownCellKeyCache = nil
local lastPuppetMirror = 0

local function toCellKey(cell)
    if not cell then return nil end
    if cell.isExterior then return cell.gridX .. ',' .. cell.gridY end
    return string.lower(cell.name)
end

local function parseExteriorKey(key)
    local gx, gy = string.match(key or '', '^(-?%d+),(-?%d+)$')
    if gx then return tonumber(gx), tonumber(gy) end
    return nil
end

local function visibleFrom(ownKey, key)
    if not ownKey or not key then return false end
    if ownKey == key then return true end
    local ax, ay = parseExteriorKey(ownKey)
    local bx, by = parseExteriorKey(key)
    return ax ~= nil and bx ~= nil and math.abs(ax - bx) <= 1 and math.abs(ay - by) <= 1
end

local function rosterName(id)
    for _, p in ipairs(roster) do
        if p.id == id then return p.name end
    end
    return nil
end

-- Teleport destination worldspace: exterior keys resolve by position in the default
-- worldspace (''); interiors are by definition the local player's own cell.
local function destCellArg()
    local player = playerScript()
    if not player or not player.cell then return nil end
    return player.cell.isExterior and '' or player.cell.name
end

-- Phase C: worldspace for an invite teleport. Distinct from destCellArg(), which answers
-- for the LOCAL player's current cell — an invite is precisely the case where the
-- destination may be somewhere the invitee is not, including a different interior, so the
-- destination has to be derived from the target key rather than from where we stand.
-- Exterior keys ("x,y") resolve by position in the default worldspace; interiors are named.
local function inviteCellArg(cellKey)
    return cellKey:match('^%-?%d+,%-?%d+$') and '' or cellKey
end

-- M2: the puppet record is built from the relayed PlayerAppearance when one is known —
-- the puppet then IS the remote player's look, not a generic villager. Records are
-- immutable, so each distinct identity gets its own generated record (cached).
local function puppetRecordId(id, name)
    local app = remoteIdentity[id] and remoteIdentity[id].appearance
    local key = name .. '|'
        .. (app and table.concat({ tostring(app.race), tostring(app.head), tostring(app.hair),
            tostring(app.isMale), tostring(app.class) }, '|') or 'default')
    if puppetRecordIds[key] then return puppetRecordIds[key] end
    -- Retail Morrowind has no villager_* records: fall back to the first NPC record in the
    -- content chain (any humanoid works — the puppet only needs a rigged body).
    local template = types.NPC.records[PUPPET_TEMPLATE_ID] or types.NPC.records[1]
    if not template then
        print('[mp] no NPC record available for the puppet template')
        return nil
    end
    local draft = { template = template, name = name }
    if app then
        draft.race = app.race
        draft.class = app.class
        draft.isMale = app.isMale
        if app.head and app.head ~= '' then draft.head = app.head end
        if app.hair and app.hair ~= '' then draft.hair = app.hair end
    end
    local ok, record = pcall(function() return world.createRecord(types.NPC.createRecordDraft(draft)) end)
    if not ok then
        -- Bad/foreign record ids in the appearance (content mismatch): fall back to template look.
        print('[mp] puppet record build failed (' .. tostring(record) .. '), using template look')
        record = world.createRecord(types.NPC.createRecordDraft({ template = template, name = name }))
    end
    puppetRecordIds[key] = record.id
    return record.id
end

-- Items another client references may not exist here (dynamic records are per-client;
-- content mismatches in retail): equip a local placeholder so the SLOT state still syncs.
local placeholderItemRecordId = nil
local function placeholderItemId()
    if placeholderItemRecordId then return placeholderItemRecordId end
    local ok, rec = pcall(function()
        return world.createRecord(types.Armor.createRecordDraft({
            name = 'Unknown Item',
            model = 'meshes/marker_error.osgt',
            icon = '',
            type = types.Armor.TYPE.Helmet,
            weight = 1,
            value = 1,
            health = 100,
            baseArmor = 0,
            enchantCapacity = 0,
        }))
    end)
    if ok then placeholderItemRecordId = rec.id end
    return placeholderItemRecordId
end

-- Grant any equipment items the puppet does not hold yet, then hand the slot map to the
-- puppet script (which retries setEquipment until the grants land in its inventory).
local function pushEquipmentToPuppet(id)
    local p = puppets[id]
    local eq = remoteIdentity[id] and remoteIdentity[id].equipment
    if not p or not p.obj:isValid() or not eq then return end
    local inventory = types.Actor.inventory(p.obj)
    local effective = {}
    for slot, recordId in pairs(eq.slots or {}) do
        -- §M7: a peer's custom item arrives as the server's recordNetId; resolve it to the
        -- record THIS client built from RecordsSync (never trust a foreign local id).
        local grantId = worldmp.toLocal(recordId)
        local ok, count = pcall(function() return inventory:countOf(grantId) end)
        if not ok or count == 0 then
            local okc, item = pcall(function() return world.createObject(grantId) end)
            if okc then
                item:moveInto(inventory)
            else
                grantId = placeholderItemId() -- unknown record here: visible stand-in
                if grantId then
                    local okp, cnt = pcall(function() return inventory:countOf(grantId) end)
                    if not okp or cnt == 0 then
                        world.createObject(grantId):moveInto(inventory)
                    end
                end
            end
        end
        if grantId then effective[slot] = grantId end
    end
    p.obj:sendEvent('MP_Equip', { slots = effective })
end

local function pushStatsToPuppet(id)
    local p = puppets[id]
    local dyn = remoteIdentity[id] and remoteIdentity[id].dynamic
    if p and p.obj:isValid() and dyn then
        p.obj:sendEvent('MP_Stats', dyn)
    end
end

local function spawnPuppet(id, pose)
    if puppets[id] then return end
    local cellArg = destCellArg()
    if not cellArg then return end
    -- %d, not tostring(): ids arrive through the JSON decoder as Lua floats, so tostring(2.0)
    -- is "2.0" and the fallback name rendered in the crosshair tooltip as "player 2.0".
    local name = rosterName(id) or string.format('player %d', math.floor(tonumber(id) or 0))
    local recordId = puppetRecordId(id, name)
    if not recordId then return end
    local obj = world.createObject(recordId)
    obj:teleport(cellArg, util.vector3(pose.x, pose.y, pose.z))
    obj:addScript('scripts/mp/puppet.lua', { playerId = id })
    puppets[id] = { obj = obj, name = name }
    print('[mp] puppet spawned for ' .. name .. ' (#' .. tostring(id) .. ')')
    -- Identity that arrived before the spawn applies now, so the first visible frame
    -- already has the right look/equipment/health.
    pushEquipmentToPuppet(id)
    pushStatsToPuppet(id)
end

local function despawnPuppet(id)
    local p = puppets[id]
    if not p then return end
    puppets[id] = nil
    -- Guarded, and deliberately AFTER the bookkeeping above: remove() throws when the
    -- object is already gone or otherwise not removable ("Can't remove 0 of 0 items"), and
    -- an engine handler that throws ABORTS — which took the rest of MP_PlayerLeaveWorld
    -- with it, leaving the roster mirror stale and remoteCell/lastPose still holding a
    -- player who had left. Same transient-engine-state reasoning as tryTeleport.
    if p.obj:isValid() then pcall(function() p.obj:remove() end) end
    print('[mp] puppet despawned for ' .. p.name .. ' (#' .. tostring(id) .. ')')
end

-- Appearance changed for a live puppet: records are immutable, so swap the object —
-- spawn a fresh one from the new record at the old pose, then remove the old.
local function rebuildPuppet(id)
    local p = puppets[id]
    if not p or not p.obj:isValid() then return end
    local pos = p.obj.position
    despawnPuppet(id)
    spawnPuppet(id, { x = pos.x, y = pos.y, z = pos.z })
end

local function despawnAllPuppets()
    for id in pairs(puppets) do
        despawnPuppet(id)
    end
    remoteCell = {}
    lastPose = {}
    remoteIdentity = {}
end

-- Own cell changed: re-evaluate which remote players are still in the visibility bubble.
local function refreshVisibility()
    local ownKey = ownCellKeyCache
    for id, key in pairs(remoteCell) do
        if visibleFrom(ownKey, key) then
            if not puppets[id] and lastPose[id] then spawnPuppet(id, lastPose[id]) end
        else
            despawnPuppet(id)
        end
    end
end

local function mirrorPuppets()
    local m = {}
    for id, p in pairs(puppets) do
        if p.obj:isValid() then
            local pos = p.obj.position
            local eq = {}
            local ok, slots = pcall(types.Actor.getEquipment, p.obj)
            if ok then
                for _, item in pairs(slots) do eq[#eq + 1] = item.recordId end
                table.sort(eq)
            end
            local rec = types.NPC.records[p.obj.recordId]
            m[tostring(id)] = { x = pos.x, y = pos.y, z = pos.z,
                name = rec and rec.name or p.name, eq = eq }
        end
    end
    mp.testSet('puppets', json.encode(m))
end

-- --- M2: rejoin restore orchestration ----------------------------------------------------
-- SessionWelcome.playerRecord (captured by net.lua) is applied once the player object
-- exists: grant the stored inventory (createObject+moveInto — only global can), teleport to
-- the stored position, then hand the record to player.lua (chargen/stats/spells/equipment).
local pendingRestore = nil
local testItemRecordId = nil -- dynamic record for the equiptest harness hook

-- M3 test-hook state
local chestRecordId = nil
local chestObj = nil
local lastChestOpId = nil
local testCastSpellId = nil -- created once by mpTestCastAt
local lastDoorMirror = 0

local function nearestDoor()
    local player = playerScript()
    if not (player and player.cell) then return nil end
    local best, bestDist = nil, math.huge
    local function scan(cell)
        if not cell then return end
        local ok, doors = pcall(function() return cell:getAll(types.Door) end)
        if not ok then return end
        for _, door in ipairs(doors) do
            if not types.Door.isTeleport(door) then
                local d = (door.position - player.position):length()
                if d < bestDist then
                    best, bestDist = door, d
                end
            end
        end
    end
    if player.cell.isExterior then
        -- The village spans several grid cells; scan the player's 3x3 neighborhood.
        for dx = -1, 1 do
            for dy = -1, 1 do
                pcall(function() scan(world.getExteriorCell(player.cell.gridX + dx, player.cell.gridY + dy)) end)
            end
        end
    else
        scan(player.cell)
    end
    return best
end

local function mirrorDoor(now)
    if now - lastDoorMirror < 0.5 then return end
    lastDoorMirror = now
    local door = nearestDoor()
    if door then
        mp.testSet('doorOpen', tostring(not types.Door.isClosed(door)))
        mp.testSet('doorLocked', tostring(types.Lockable.isLocked(door)))
    end
end

local function teleportPlayerTo(position)
    local player = playerScript()
    if not player or not position then return end
    local gx, gy = parseExteriorKey(position.cellKey)
    local cellArg = gx and '' or position.cellKey
    local ok, err = pcall(function()
        player:teleport(cellArg, util.vector3(position.x, position.y, position.z))
    end)
    if not ok then print('[mp] restore teleport failed: ' .. tostring(err)) end
end

-- Restoring the position ONCE loses a race. On a page reload the engine is still placing the
-- player itself (a ?start= deep-link, or the save/chargen spawn), and that placement can land
-- AFTER our teleport and silently overwrite it — observed intermittently as a resumed player
-- snapping back to the start point instead of where they logged out. So re-assert the target
-- for a short window and stop as soon as it sticks, rather than trusting a single apply.
local restoreTarget = nil -- {cellKey=, x=, y=, z=, deadline=}
local RESTORE_HOLD_SECONDS = 8
local RESTORE_EPSILON = 25 -- units; well inside the ~300u error this exists to catch

local function dist3(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

-- Deliberately dumb: re-assert the target EVERY tick it is off, for a short window.
--
-- A cleverer version (only correct on a detected single-tick "jump", so a player who walks
-- away is never dragged back) tested WORSE — the engine's post-reload placement does not
-- always arrive as one clean jump, and teleports are deferred to the next
-- synchronizedUpdate, so any one-shot correction is easily lost. The window is what keeps
-- this safe instead: 8s is long enough to outlast a slow world load on a busy machine, and
-- short enough that a player is very unlikely to have walked 25+ units of their own accord
-- before it lapses. Correctness of "you are where you logged out" beats elegance here.
local function restorePositionTick(now)
    if not restoreTarget then return end
    local player = playerScript()
    if not player then return end
    if now > restoreTarget.deadline then
        if dist3(player.position, restoreTarget) > RESTORE_EPSILON then
            print('[mp] restore position never took hold')
        end
        restoreTarget = nil
        return
    end
    if dist3(player.position, restoreTarget) > RESTORE_EPSILON then teleportPlayerTo(restoreTarget) end
end

local function restoreTick()
    if not pendingRestore then return end
    mp.testSet('restoreFired', '1')
    local player = playerScript()
    if not player then return end
    local record = pendingRestore
    pendingRestore = nil
    local inventory = types.Actor.inventory(player)
    local granted = 0
    -- Server doc shape: inventory is a flat [{id,n},...] array (persist/playerstore.ts).
    --
    -- RECONCILE, NEVER RE-GRANT. This used to create the whole stored inventory outright, on
    -- the assumption that a restore lands in an empty character. It does not on a WORLD
    -- SWITCH: the engine keeps the same player actor, with everything already in it, so every
    -- Solo->Public->Solo trip added another full copy of the doc — 261 gold became 783 in two
    -- switches. Grant only the shortfall, using the same countOf idiom as the puppet grant
    -- path above.
    --
    -- Deliberately does NOT remove a surplus. The doc is written behind a debounce, so a
    -- player holding MORE than it records is the ordinary case of having picked something up
    -- since the last flush — treating that as a dupe to be confiscated would destroy real
    -- items to fix a cosmetic count. This stops the growth; it does not heal an inventory
    -- already inflated by the old behaviour.
    for _, entry in ipairs(record.inventory or {}) do
        -- MAP THE RECORD ID FIRST. A player-made item (enchanted, alchemy) is a DYNAMIC record,
        -- and dynamic ids are minted per world by an engine-global counter — so world A's
        -- "Generated:0x3" and world B's are different records wearing the same string. Handing
        -- the doc's raw id to createObject in another world therefore builds whatever that
        -- string happens to mean HERE, silently. The object path has guarded this since M7
        -- (objects.lua:325); the character doc never did.
        local wantId = worldmp.toLocal(entry.id)
        local want = entry.n or 1
        local okc, have = pcall(function() return inventory:countOf(wantId) end)
        local short = want - ((okc and have) or 0)
        if short > 0 then
            local ok, item = pcall(function() return world.createObject(wantId, short) end)
            if ok then
                item:moveInto(inventory)
                granted = granted + 1
            end
        end
    end
    -- PER-ITEM STATE, applied after the grant and strictly best-effort. Without this every
    -- rejoin handed the character fully repaired gear, fully charged enchantments and empty
    -- soul gems, because createObject builds a FRESH object and the doc only ever recorded a
    -- record id and a count. Each failure in here is swallowed on purpose: the item itself is
    -- already correctly in the inventory, and losing its wear is a far smaller harm than
    -- aborting the rest of the restore over it.
    local restored = 0
    for recId, bucket in pairs(record.itemStates or {}) do
        local localId = worldmp.toLocal(recId)
        local idx = 0
        local okAll = pcall(function()
            for _, item in ipairs(inventory:getAll()) do
                if item.recordId == localId then
                    idx = idx + 1
                    local st = bucket[idx]
                    if st then
                        local d = item.itemData
                        if st.condition ~= nil then pcall(function() d.condition = st.condition end) end
                        if st.charge ~= nil then pcall(function() d.enchantmentCharge = st.charge end) end
                        if st.soul ~= nil then pcall(function() d.soul = st.soul end) end
                        restored = restored + 1
                    end
                end
            end
        end)
        if not okAll then
            print('[mp] restore: item state for "' .. tostring(recId) .. '" did not apply')
        end
    end
    if restored > 0 then print('[mp] restored state on ' .. tostring(restored) .. ' item(s)') end

    mp.testSet('restorePos', record.position and json.encode(record.position) or 'none')
    if record.position then
        teleportPlayerTo(record.position)
        restoreTarget = {
            cellKey = record.position.cellKey,
            x = record.position.x, y = record.position.y, z = record.position.z,
            deadline = core.getRealTime() + RESTORE_HOLD_SECONDS,
        }
    end
    -- Standing, applied HERE because faction and crime setters are global-context only
    -- (mwlua gates local scripts to "self"). The doc has carried these all along and nothing
    -- ever read them back, so a guild rank or a bounty was recorded and then quietly lost on
    -- the next join.
    quests.restoreStanding(record)
    -- MAP THE RECORD IDS BEFORE IT LEAVES. equipment and spells are stored FLAT in the doc
    -- (not world-keyed), and they went out through toNet but came back raw — so a dynamic or
    -- enchanted item saved in world A was fed to world B as A's id, where that same string
    -- means a different record or nothing at all. The inventory restore above has mapped
    -- since M7 (worldmp.toLocal); its two siblings never did. toLocal is global-only, which
    -- is exactly why this belongs here and not in identity.lua.
    if record.equipment then
        local slots = {}
        for slot, id in pairs(record.equipment) do slots[slot] = worldmp.toLocal(id) end
        record.equipment = slots
    end
    if record.spells then
        local spells = {}
        for k, id in pairs(record.spells) do spells[k] = worldmp.toLocal(id) end
        record.spells = spells
    end
    player:sendEvent('MP_ApplyRecord', record)
    print('[mp] rejoin restore: ' .. granted .. ' item stack(s) granted, record forwarded')
end

local function puppetTick()
    local now = core.getRealTime()
    local player = playerScript()
    if player then
        local key = toCellKey(player.cell)
        if key ~= ownCellKeyCache then
            ownCellKeyCache = key
            refreshVisibility()
            if net.state == 'Joined' then
                quests.onCellChanged()
                worldmp.onCellEntered(key)
            end
        end
    end
    if now - lastPuppetMirror >= 0.5 then
        lastPuppetMirror = now
        mirrorPuppets()
    end
end

local function start()
    -- net.lua cannot reach the player script, so it announces through this. Set before
    -- anything can drop, or the very first outage would be the silent one.
    net.noticeFn = notice
    if not mp.isEnabled() then return end
    if mp.vectorsEnabled() then dumpVectors() end
    -- M3 world-object hub wiring (see scripts/mp/objects.lua).
    objects.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        placeholderItemFn = placeholderItemId,
        -- A refused container op UNDOES the optimistic local take, so without this the item
        -- simply disappears out of the player's inventory a moment after they picked it up.
        -- notice() is queued and flushed against the player script, so it is a no-op on the
        -- headless sim peer rather than something that needs guarding at the call site.
        noticeFn = notice,
    })
    -- M4 shared-NPC authority hub (see scripts/mp/actors.lua). isMpPuppetFn tells the actor
    -- sampler which active actors are remote-PLAYER puppets (driven by player move frames) so
    -- it never double-drives or broadcasts them as cell NPCs.
    actors.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        isMpPuppetFn = function(obj)
            for _, p in pairs(puppets) do
                if p.obj:isValid() and p.obj.id == obj.id then return true end
            end
            return false
        end,
        -- COMPANIONS, both directions. A follow target is a PLAYER on the client that
        -- recruited them and a PUPPET everywhere else, so the wire carries the player ID and
        -- each side translates: whoever recruited them sees their own avatar, everyone else
        -- sees the stand-in for that same person.
        playerIdOf = function(obj)
            if not (obj and obj:isValid()) then return nil end
            for _, pl in ipairs(world.players) do
                if pl:isValid() and pl.id == obj.id then
                    return net.state == 'Joined' and net.playerId or nil
                end
            end
            for id, p in pairs(puppets) do
                if p.obj:isValid() and p.obj.id == obj.id then return id end
            end
            return nil
        end,
        playerObjOf = function(id)
            if id == nil then return nil end
            if net.state == 'Joined' and id == net.playerId then
                local own = world.players[1]
                return own and own:isValid() and own or nil
            end
            local p = puppets[id]
            return p and p.obj:isValid() and p.obj or nil
        end,
    })
    -- M5 combat hub (see scripts/mp/combat.lua).
    combat.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        puppetObjOf = function(id)
            local p = puppets[id]
            return p and p.obj:isValid() and p.obj or nil
        end,
        epochOf = actors.epochOf,
        isHolderOf = actors.isHolderOf,
        cellKeyOfObj = actors.cellKeyOfObj,
        -- PvP is a server rule (SessionWelcome.flags.pvp); default OFF until told otherwise.
        isPvpEnabled = function() return net.flags and net.flags.pvp == true end,
    })
    -- M6 quest layer (see scripts/mp/quests.lua): journal, MWScript globals/locals,
    -- factions, crime, dialogue locks. Global context because every writable end of it is
    -- global-gated in 0.52 (setCrimeLevel, world.mwscript).
    quests.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        noticeFn = notice,
        rosterNameFn = rosterName,
        isMpPuppetFn = function(obj)
            for _, p in pairs(puppets) do
                if p.obj:isValid() and p.obj.id == obj.id then return true end
            end
            return false
        end,
    })
    -- M7 world state (see scripts/mp/world.lua): clock, region/weather authority, custom
    -- records, cell resets, map sharing, server-pushed GUI.
    worldmp.init({
        playerFn = playerScript,
        ownCellKeyFn = function() return ownCellKeyCache end,
        ownIdFn = function() return net.state == 'Joined' and net.playerId or nil end,
        noticeFn = notice,
        toPlayerFn = toPlayer,
        onCellResetFn = function(cellKey)
            -- Drop our local view of that cell and ask for the (now empty) server truth.
            objects.forgetCell(cellKey)
            if cellKey == ownCellKeyCache then
                mp.sendEvent('ResyncRequest', { cellKey = cellKey })
            end
        end,
    })
    -- M8 ops (see scripts/mp/admin.lua): the client end of /tp, /give and /console.
    admin.init({
        playerFn = playerScript,
        noticeFn = notice,
        teleportFn = teleportPlayerTo,
        toLocalRecordFn = worldmp.toLocal,
        -- Claims a reply only when the WINDOW issued the request. Replies are 1:1 and
        -- ordered per connection, so a simple outstanding count correlates them without a
        -- request id — and a /slash command typed in chat still notices normally.
        menuFn = function(text)
            if adminUiPending <= 0 then return false end
            adminUiPending = adminUiPending - 1
            toPlayer('MP_AdminMenuResult', { text = text })
            return true
        end,
    })
    net.onStateChanged = function(state)
        print('[mp] session state: ' .. state)
        if state == 'Joined' then
            -- ONCE PER SESSION, not once per join. A world switch and every reconnect come
            -- back through here, so this repeated the same three lines each time and pushed
            -- the actual conversation off the top of the log.
            if not announcedConnect then
                announcedConnect = true
                notice('Connected to ' .. tostring(net.serverName or 'the server')
                    .. ' as ' .. tostring(mp.getName() or '?'))
            end
            wasJoined = true
            -- OUR OWN WORLD, from the boot fragment — not "whichever world we happen to be
            -- in". A world change REBOOTS the page, so this Lua state is brand new on
            -- arrival; mphome rides every switch.
            if not worldUrls.own then
                local home = mp.getHomeUrl and mp.getHomeUrl() or ''
                if type(home) == 'string' and home ~= '' then worldUrls.own = home
                else worldUrls.own = net.currentTarget() end -- pre-mphome boot / standalone
            end
            -- A flip that had to wait for us to arrive back in our own world fires now
            -- that we are joined.
            if pendingFlip and net.currentTarget() == worldUrls.own then
                mp.sendEvent('SetWorldMode', { mode = pendingFlip })
                pendingFlip = nil
            end
            if net.playerRecord then
                pendingRestore = net.playerRecord -- applied by restoreTick once the player exists
                net.playerRecord = nil
            end
        elseif state == 'Failed' then
            local why = FAIL_TEXT[net.lastError] or net.lastError or 'connection failed'
            local detail = net.lastErrorDetail
            mp.testSet('netfail', why .. (detail and detail ~= '' and (' (' .. detail .. ')') or ''))
        end
        -- CONNECTION STATE IS A MODAL, NOT CHAT. A drop repeats every backoff tick, so
        -- narrating it in the chat log buried the actual conversation under a wall of
        -- identical lines while the player stood in a world that was no longer live. The
        -- UI mirrors this and puts one overlay up, held until we rejoin or give up.
        mp.testSet('netstate', state)
        if state ~= 'Joined' then
            -- The NEXT world has its own peer, which has to come up before it holds anything.
            -- Leaving this at '1' from the world we just left meant a switch never waited:
            -- the loading screen saw a stale "ready", cleared, and dropped the player into an
            -- unsimulated world to rubber-band exactly as they did on a first join. The new
            -- world's own SimReady answers this on arrival.
            mp.testSet('simReady', '0')
            roster = {}
            mirrorRoster()
            despawnAllPuppets()
            objects.reset()
            actors.reset()
            quests.reset()
            worldmp.reset()
            admin.reset()
        end
    end
    if net.state == 'Offline' or net.state == 'Failed' then
        net.start()
    end
end

-- Character slots + onboarding: net-level results push to the player script so the hub
-- re-renders without polling (same global -> player direction as every MP_* relay).
net.onCharacters = function(msg)
    toPlayer('MP_Characters', {
        characters = net.characters or {},
        active = net.characterId or '',
        ok = msg and msg.ok or nil,
        error = msg and msg.error or nil,
    })
end
net.onProfileResult = function(msg)
    toPlayer('MP_ProfileResult', { ok = msg.ok == true, error = msg.error or '' })
end

local eventHandlers = {
    MP_TransportOpen = function() net.onOpen() end,
    MP_TransportClose = function() net.onClose() end,
    MP_SessionJson = function(str) net.onJson(str) end,

    -- --- Phase C: social relays -----------------------------------------------------
    -- Straight pass-through to the player script, which owns the window. The one exception
    -- is InviteAccepted, which is an ACTION (a teleport) and therefore has to happen in the
    -- global context where teleport is available.
    MP_FriendList = function(data)
        mp.testSet('friends', json.encode(data.friends or {}))
        toPlayer('MP_FriendList', data)
    end,
    -- F3 world browser. Inbound server events land in the GLOBAL context and reach the
    -- window only if forwarded here — the social family's straight pass-through pattern.
    MP_WorldList = function(data)
        toPlayer('MP_WorldList', data)
    end,
    MP_WorldCreate = function(data) toPlayer('MP_WorldCreate', data) end,
    -- BOTH OF THESE WERE SENT BY THE SERVER AND HANDLED BY NOBODY. A server->client event with
    -- no handler is not an error anywhere: it arrives, matches nothing, and is dropped in
    -- silence, so the feature reads as unimplemented while the server-side half is complete
    -- and tested. Found by diffing every `sendEvent` on the server against every `MP_*`
    -- handler here.
    --
    -- WorldTimeRefused: the server refuses a Rest/Wait under `[rules] timeSkip` and says so
    -- deliberately — m7.ts's own comment is "Refusals are TOLD to the player — a Rest that
    -- silently does nothing gets pressed again and then reported as a bug". Which is exactly
    -- what happened, because the telling never arrived.
    MP_WorldTimeRefused = function(data) toPlayer('MP_WorldTimeRefused', data) end,
    -- SocialNotice: server-side notices worth surfacing (kicks, closures).
    MP_SocialNotice = function(data) toPlayer('MP_SocialNotice', data) end,
    -- Why that swing did nothing. The attacker's client has ALREADY cancelled its own damage by
    -- the time the server sees the hit, so a drop costs the whole attack — and the cell being
    -- unsimulated is not something the player can see. Throttled here rather than on the server
    -- because the server would have to keep per-player state to do it, and one message per
    -- situation is what is wanted, not one per swing.
    MP_CombatRefused = function(data)
        local now = core.getRealTime()
        if combatRefusedAt and now - combatRefusedAt < COMBAT_REFUSED_EVERY then return end
        combatRefusedAt = now
        toPlayer('MP_CombatRefused', data)
    end,
    MP_FriendRequestReceived = function(data) toPlayer('MP_FriendRequestReceived', data) end,
    MP_InviteReceived = function(data) toPlayer('MP_InviteReceived', data) end,
    MP_PresenceUpdate = function(data) toPlayer('MP_PresenceUpdate', data) end,
    MP_SocialResult = function(data) toPlayer('MP_SocialResult', data) end,

    -- The owner of the world we are standing in went Solo, so it is no longer open to us.
    -- Dial our OWN world, which this client already knows; the server drops anyone still
    -- here shortly after, so doing nothing would just become a disconnect.
    -- WHERE TO SIMULATE. Sent only to the sim peer: one anchor per populated region, so a
    -- single engine keeps several parts of the world active instead of one ~450MB process per
    -- region. A normal client never receives this, and without anchors the engine behaves
    -- exactly as it always has (the player is the only anchor).
    MP_SimAnchors = function(data)
        if not mp.setSimAnchors then return end
        -- WORLD POSITIONS, not grid coordinates: each anchor is a player's live pose, so the
        -- engine's processing range follows players exactly (a cell-centre anchor reached
        -- only ~3072 units into a neighbour against the 7168 range).
        local out = {}
        for _, a in ipairs((data and data.anchors) or {}) do
            if a.x and a.y then out[#out + 1] = { x = a.x, y = a.y, z = a.z or 0 } end
        end
        -- Interiors come as NAMES: they have no grid coordinate, so they cannot ride in the
        -- anchor list. Held exactly like an exterior anchor — the peer keeps the room loaded
        -- and ticks its actors without standing in it.
        local rooms = {}
        for _, name in ipairs((data and data.interiors) or {}) do
            if type(name) == 'string' and name ~= '' then rooms[#rooms + 1] = name end
        end
        mp.setSimAnchors(out, rooms)

        -- AND GO STAND SOMEWHERE SENSIBLE. With the anchor gates finished (actorutil
        -- nearestSimDistanceSqr) every anchor simulates, so the peer's own position no
        -- longer decides WHAT ticks -- but a cold boot still lands at [simPeer].startCell,
        -- and standing in a real occupied cell keeps the avatar out of the void.
        --
        -- data.place is the position the server already computes to SPAWN the peer -- a real
        -- player's, so it is valid ground rather than a computed cell centre that might be
        -- inside terrain. Only move when the cell actually changes: teleporting every 5 s resets
        -- the actors' AI packages and would keep them permanently re-deciding what to do.
        local place = data and data.place
        if place and place.cellKey and place.cellKey ~= peerStandingIn then
            local cellArg = inviteCellArg(place.cellKey)
            local p = world.players[1]
            if cellArg and p and tryTeleport(p, cellArg, util.vector3(place.x or 0, place.y or 0, place.z or 0)) then
                peerStandingIn = place.cellKey
                print('[mp] sim peer moved to ' .. tostring(place.cellKey) .. ' to simulate it')
            end
        end
    end,
    -- The credential for the next world, minted by the one we are still connected to. The
    -- pending switch is waiting on exactly this.
    -- The world telling us what it IS. Authoritative, sent at join and on every flip.
    -- Does the simulation peer hold authority yet? Mirrored to JS, where the loading screen
    -- waits on it. Nothing in Lua acts on this: the engine is perfectly happy simulating
    -- locally in the meantime — the problem is purely that letting the PLAYER move during
    -- that window means the peer arrives, takes the cell and corrects them, which is the
    -- rubber-banding. Holding the screen is what makes the correction unobservable.
    MP_SimReady = function(data)
        mp.testSet('simReady', (data and data.ready) and '1' or '0')
    end,

    MP_WorldMode = function(data)
        local m = tostring(data and data.mode or '')
        local was = worldMode
        worldMode = m == 'party' and 'party' or 'solo'
        mirrorRoster()
        -- Which world you are in is invisible otherwise — the scenery is identical — and it
        -- decides who can see you. Announced on CHANGE only; the server also sends this at
        -- join, which is not a transition worth narrating.
        if was ~= nil and was ~= worldMode then
            local where = worldMode == 'party' and 'your world, open to your friends'
                or 'your own world (solo)'
            notice('You are now in ' .. where .. '.')
        end
    end,
    MP_WorldClosed = function(data)
        toPlayer('MP_WorldClosed', data)
        -- Mirrored so the HTML overlay can say WHY the world just changed under the player.
        mp.testSet('worldClosedBy', tostring(data.by or ''))
        mp.testSet('worldClosed', tostring(data.reason or 'closed'))
        -- A SEQUENCE, not the value. The reason is a constant ('owner_went_solo'), so the UI
        -- deduping on the value alone silently swallowed the second and every later kick in a
        -- session: the player was redialed with nothing on screen explaining why.
        noticeSeq = noticeSeq + 1
        mp.testSet('noticeSeq', tostring(noticeSeq))
        if worldUrls.own and net.currentTarget() ~= worldUrls.own then
            net.switchTo(worldUrls.own)
        end
    end,

    -- The server answers InviteAccept with the host's live position. Travelling is done
    -- here rather than trusting a client-side coordinate: the server is the only thing that
    -- knows where the host actually is.
    MP_InviteAccepted = function(data)
        local player = playerScript()
        if not player then return end -- headless peer: nothing to travel
        -- ACCEPTING AN INVITE AND GOING NOWHERE USED TO BE SILENT. Both of these leave the
        -- player exactly where they were, having just pressed "accept" — which reads as the
        -- invite being broken rather than the travel being. One line each is the whole fix.
        if not data.cellKey then
            notice('Could not work out where they are — ask them to try again.')
            return
        end
        local ok, err = pcall(function()
            player:teleport(inviteCellArg(tostring(data.cellKey)), util.vector3(data.x or 0, data.y or 0, data.z or 0))
        end)
        if not ok then
            print('[mp] invite teleport failed: ' .. tostring(err))
            notice('Could not travel to them just now.')
        end
        mp.testSet('invitedTo', tostring(data.cellKey))
    end,

    -- "Join a friend": the server resolved their world and told us where to dial. An
    -- ACTION, so the redial happens here; the hub is told first so it can show a failure.
    MP_JoinFriend = function(data)
        toPlayer('MP_JoinFriend', data)
        if not data or data.ok ~= true then return end
        local url = worldUrlOf(data)
        if not url then return end
        mp.testSet('joinFriendTo', tostring(data.worldId or ''))
        if url == net.currentTarget() then return end
        net.switchTo(url)
    end,

    MP_ChatMessage = function(data)
        mp.testSet('lastChat', json.encode(data))
        toPlayer('MP_UiChatMessage', data)
    end,

    MP_PlayerJoinWorld = function(data)
        for _, p in ipairs(roster) do
            if p.id == data.id then return end
        end
        roster[#roster + 1] = { id = data.id, name = data.name }
        mirrorRoster()
        -- Not your own arrival: you know you just joined, and on a world switch the server
        -- re-announces every occupant including you.
        if data.id ~= net.playerId then
            toPlayer('MP_UiChatMessage',
                { channel = 'server', text = tostring(data.name) .. ' joined the world.' })
        end
    end,

    MP_PlayerLeaveWorld = function(data)
        for i, p in ipairs(roster) do
            if p.id == data.id then
                toPlayer('MP_UiChatMessage',
                    { channel = 'server', text = tostring(p.name) .. ' left the world.' })
                table.remove(roster, i)
                break
            end
        end
        despawnPuppet(data.id)
        remoteCell[data.id] = nil
        lastPose[data.id] = nil
        mirrorRoster()
    end,

    -- Interest management: this player left OUR view (distance cull or cell exit) — they are
    -- still in the world, just no longer streamed to us. Without this the server simply stops
    -- sending their poses and we would keep a ghost puppet frozen at the boundary forever.
    -- Despawn NOW rather than on a stale timeout (seconds of a motionless body is exactly the
    -- artefact this exists to prevent), drop the interp state so a re-entry starts clean, and
    -- KEEP the roster entry — only PlayerLeaveWorld means they actually left. Re-entry needs
    -- no signal: the server force-sends their pose and the first-sighting path respawns them.
    MP_PlayerLeaveView = function(data)
        if data.id == nil then return end
        despawnPuppet(data.id) -- idempotent; safe for an id we never spawned
        remoteCell[data.id] = nil
        lastPose[data.id] = nil
    end,

    -- M1: one decoded 0x0101 batch -> route each entry to its puppet (spawning on first
    -- sighting — the server only sends poses of players visible to us).
    MP_MoveBatch = function(batch)
        local now = core.getRealTime()
        -- G2: the render tier is decided HERE, once per batch, and stamped onto each pose.
        -- The alternative — every puppet asking `nearby` for the player each frame — pays
        -- the lookup per puppet per frame, which is the cost this is trying to remove.
        local me = playerScript()
        local origin = me and me.position or nil
        local f = net.flags
        local tiered = origin ~= nil and f ~= nil and f.renderLod == 'tiered'
        local nearR2 = tiered and (f.lodNearRadius or 0) ^ 2 or 0
        local midR2 = tiered and (f.lodMidRadius or 0) ^ 2 or 0

        -- Pass 1: distances. The nearest-K cap needs to rank the whole batch before it can
        -- tier any single entry, which is why this is two passes and not one.
        --
        -- Entries are collected with ipairs and counted, NOT indexed via `#batch`. The `#`
        -- operator is only defined on a proper sequence, and using it here silently
        -- processed nothing: puppets then spawned ONLY via PlayerCellChange, so two players
        -- who spawn in the same cell and stand still never saw each other. It was asymmetric
        -- and easy to misread as a flake — the player who joins first sends its cell change
        -- before the second is in-world, so only the SECOND player's puppet went missing.
        local count = 0
        for _, e in ipairs(batch) do
            count = count + 1
            entryBuf[count] = e
            if tiered then
                local dx, dy, dz = e.x - origin.x, e.y - origin.y, e.z - origin.z
                d2Buf[count] = dx * dx + dy * dy + dz * dz
            else
                d2Buf[count] = -1 -- not comparable: always near, never degraded
            end
        end
        local maxNear = tiered and (f.lodNearMaxAvatars or 0) or 0
        local cutoff = nearCutoff(nearR2, maxNear, count)

        -- Pass 2: tier and route. `nearLeft` enforces the cap EXACTLY. The cutoff alone
        -- does not: it is the K-th smallest distance and the test is `d2 <= cutoff`, so
        -- every avatar tied at exactly that distance stays near and the cap is exceeded.
        -- Ties are not exotic here — players stacked in a doorway, a formation, or bots on
        -- a ring layout sit at identical distances — and the symptom would be an
        -- intermittently-breached cap that reads as a flaky test rather than an off-by-ties
        -- bug. The cutoff stays as a cheap pre-filter; this counter is the actual bound.
        --
        -- `maxNear` is a LOCAL computed above. It was previously written here as a bare name
        -- that existed only as a parameter of nearCutoff, so at this scope it was a nil
        -- global and `nil > 0` threw on EVERY batch — the handler died before routing a
        -- single pose, and puppets could then only appear via PlayerCellChange.
        local nearLeft = maxNear > 0 and maxNear or math.huge
        for i = 1, count do
            local e = entryBuf[i]
            if e.id ~= net.playerId then
                lastPose[e.id] = { x = e.x, y = e.y, z = e.z }
                -- NEVER into the chargen cells. spawnPuppet places a puppet in the LOCAL
                -- player's own cell (destCellArg), and this path has no cell test of its own —
                -- MP_PlayerCellChange checks visibility, a move batch does not. That is how a
                -- stranger materialises in your Imperial Prison Ship mid-character-creation,
                -- standing among the actors whose scripts drive the opening.
                if not puppets[e.id] and not isChargenCell(ownCellKeyCache) then
                    spawnPuppet(e.id, e)
                end
                local p = puppets[e.id]
                if p and p.obj:isValid() then
                    local d2 = d2Buf[i]
                    local tier
                    if d2 < 0 then
                        tier = TIER_NEAR -- not comparable: never degraded
                    elseif d2 <= cutoff and nearLeft > 0 then
                        tier = TIER_NEAR
                        nearLeft = nearLeft - 1
                    elseif d2 <= midR2 then
                        tier = TIER_MID
                    else
                        tier = TIER_FAR
                    end
                    e.t = now
                    e.tier = tier
                    local tn = TIER_NAME[tier] or 'near'
                    tierSeen[tn] = (tierSeen[tn] or 0) + 1
                    p.obj:sendEvent('MP_Pose', e)
                end
            end
        end
        -- Mirrored so a capacity run can prove puppets really ARE being degraded. Without
        -- it, a "tiered" run that silently classified every avatar as near would report a
        -- free performance win that is actually just the old behaviour.
        mp.testSet('puppetTiers', json.encode(tierSeen))
        -- Cleared in place: `tierSeen = {}` allocated a fresh table 15x/second, and this
        -- module already goes out of its way to avoid per-tick garbage.
        tierSeen.near, tierSeen.mid, tierSeen.far = nil, nil, nil
    end,

    -- M1: relayed with the mover's id added; despawn/teleport their puppet. Our OWN
    -- relay comes back too — ignore it (PROTOCOL.md).
    MP_PlayerCellChange = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteCell[data.id] = data.cellKey
        lastPose[data.id] = { x = data.x, y = data.y, z = data.z }
        if visibleFrom(ownCellKeyCache, data.cellKey) then
            local p = puppets[data.id]
            if p and p.obj:isValid() then
                tryTeleport(p.obj, destCellArg(), util.vector3(data.x, data.y, data.z))
            else
                spawnPuppet(data.id, data)
            end
        else
            despawnPuppet(data.id)
        end
    end,

    -- --- M2: identity relays -> puppet appliers ------------------------------------------
    MP_PlayerAppearance = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteIdentity[data.id] = remoteIdentity[data.id] or {}
        remoteIdentity[data.id].appearance = data
        rebuildPuppet(data.id) -- no-op when not spawned; spawn applies the stored look
    end,

    MP_PlayerEquipment = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteIdentity[data.id] = remoteIdentity[data.id] or {}
        remoteIdentity[data.id].equipment = { slots = data.slots or {} }
        pushEquipmentToPuppet(data.id)
    end,

    MP_PlayerStatsDynamic = function(data)
        if not data.id or data.id == net.playerId then return end
        remoteIdentity[data.id] = remoteIdentity[data.id] or {}
        remoteIdentity[data.id].dynamic = { hp = data.hp, mp = data.mp, ft = data.ft }
        pushStatsToPuppet(data.id)
    end,

    -- M2 respawn service: teleport self, then let player.lua revive/refill.
    MP_PlayerResurrect = function(data)
        teleportPlayerTo(data)
        toPlayer('MP_DoResurrect', { restoreHp = data.restoreHp == true })
    end,

    -- Test hook (equip:<id>:<slot>): grant an item into the LOCAL player's inventory.
    mpGrantItem = function(data)
        local player = playerScript()
        if not player or type(data.id) ~= 'string' then return end
        local ok, item = pcall(function() return world.createObject(data.id) end)
        if ok then
            item:moveInto(types.Actor.inventory(player))
        else
            print('[mp] mpGrantItem failed: ' .. tostring(item))
        end
    end,

    -- Test hook (equiptest): the clean demo content ships NO item records at all, so the
    -- equipment scenarios create a dynamic helmet record at runtime and grant it.
    mpTestItem = function()
        local player = playerScript()
        if not player then return end
        if not testItemRecordId then
            local ok, rec = pcall(function()
                return world.createRecord(types.Armor.createRecordDraft({
                    name = 'MP Test Helmet',
                    model = 'meshes/marker_error.osgt',
                    icon = '',
                    type = types.Armor.TYPE.Helmet,
                    weight = 1,
                    value = 1,
                    health = 100,
                    baseArmor = 5,
                    enchantCapacity = 0,
                }))
            end)
            if not ok then
                print('[mp] mpTestItem record creation failed: ' .. tostring(rec))
                return
            end
            testItemRecordId = rec.id
        end
        world.createObject(testItemRecordId):moveInto(types.Actor.inventory(player))
        toPlayer('MP_TestItem', { id = testItemRecordId })
    end,

    -- --- M3 test hooks (headless scenarios can't drive the mouse/UI) -------------------
    -- Drop the first inventory item matching recordId into the world in front of the
    -- player — via the NATIVE path (inventory->world teleport fires onItemActive, which is
    -- the same signal a UI drop produces), so the whole spawn pipeline is exercised.
    mpDropItem = function(data)
        local player = playerScript()
        if not player then return end
        for _, item in ipairs(types.Actor.inventory(player):getAll()) do
            if item.recordId == data.id then
                local pos = player.position + util.vector3(0, 100, 0)
                local cellArg = player.cell.isExterior and '' or player.cell.name
                item:teleport(cellArg, pos)
                return
            end
        end
        print('[mp] mpDropItem: no ' .. tostring(data.id) .. ' in inventory')
    end,

    -- Pick up a net-tracked object through the REAL activation pipeline (activateBy ->
    -- native pickup + our onActivate hook relays the ObjectDelete).
    mpTakeNet = function(data)
        local player = playerScript()
        local obj = data.netId and objects.objOfNet(data.netId)
        if player and obj and obj:isValid() then
            obj:activateBy(player)
        end
    end,

    -- Spawn a shared chest: dynamic container record locally + ObjectSpawnRequest so the
    -- server nets it (peers get a placeholder object; the CONTAINER STATE still syncs —
    -- that is what M3 asserts; a real shared chest needs shared content records).
    mpSpawnChest = function()
        local player = playerScript()
        if not player then return end
        if not chestRecordId then
            local ok, rec = pcall(function()
                return world.createRecord(types.Container.createRecordDraft({
                    name = 'MP Test Chest',
                    model = 'meshes/marker_error.osgt',
                    weight = 500, -- capacity
                    isOrganic = false,
                    isRespawning = false,
                }))
            end)
            if not ok then
                print('[mp] chest record failed: ' .. tostring(rec))
                return
            end
            chestRecordId = rec.id
        end
        local obj = world.createObject(chestRecordId)
        local cellArg = player.cell.isExterior and '' or player.cell.name
        local pos = player.position + util.vector3(100, 100, 0)
        obj:teleport(cellArg, pos)
        objects.markNetSpawned(obj) -- containers are not items, but keep bookkeeping tidy
        -- teleport lands next frame; obj.position is not valid yet -> pass the target pos
        objects.requestSpawn(obj, pos, ownCellKeyCache)
        chestObj = obj
    end,

    -- Put an inventory item into the spawned chest (native transfer + the same
    -- ContainerOpRequest the container watch would send).
    mpChestPut = function(data)
        local player = playerScript()
        if not (player and chestObj and chestObj:isValid()) then return end
        for _, item in ipairs(types.Actor.inventory(player):getAll()) do
            if item.recordId == data.id then
                -- Native transfer only: the container watch (armed by chest:open) diffs the
                -- inventory change into the ContainerOpRequest — the same path a UI put takes.
                item:moveInto(types.Container.content(chestObj))
                return
            end
        end
    end,

    -- Open the chest formally (ContainerOpen with a contents snapshot; the first opener's
    -- snapshot becomes canonical server-side).
    mpChestOpen = function(data)
        if chestObj and chestObj:isValid() then
            objects.onActivate(chestObj, playerScript())
        elseif data and data.netId then
            -- Peer without a real chest (placeholder object): announce with nil contents.
            mp.sendEvent('ContainerOpen', { net = data.netId, cellKey = ownCellKeyCache })
        end
    end,

    -- Race the take: request through the transactional server path; the ok/fail lands in
    -- the chestOp mirror via MP_ContainerOpResult below.
    mpChestTake = function(data)
        local netId = data.netId or (chestObj and objects.netIdOf(chestObj))
        if netId then
            local opId = objects.sendContainerOpByNet(netId, 'take', data.id, 1, ownCellKeyCache)
            lastChestOpId = opId
        end
    end,

    -- M5 test hook: land a synthetic melee hit on a target. This posts the STOCK `Hit`
    -- event, so it travels the identical path a real weapon swing takes: for a puppet the
    -- interception handler forwards it and cancels locally; for an actor we hold, the
    -- builtin pipeline applies it. Headless CDP cannot swing a weapon, but everything
    -- downstream of the swing is exercised verbatim.
    mpTestHit = function(data)
        local victim = nil
        if data.playerId then
            local p = puppets[data.playerId]
            victim = p and p.obj:isValid() and p.obj or nil
        elseif data.record then
            for _, obj in ipairs(world.activeActors) do
                if obj:isValid() and obj.recordId == data.record then victim = obj break end
            end
        end
        if not victim then
            print('[mp] mpTestHit: no victim for ' .. json.encode(data))
            return
        end
        -- WHICH DAMAGE CHANNEL. The engine fills EITHER health OR fatigue and never both
        -- (mwlua/luamanagerimp.cpp onHit), and an UNARMED blow in Morrowind is a fatigue hit.
        -- This hook used to hardcode health, which is precisely why the suite could not catch
        -- the server refusing every hand-to-hand swing in the game: no scenario was able to
        -- express the failing case, so 46 of them passed while combat was completely broken for
        -- anyone without a weapon. A test hook that cannot produce the shape a real client
        -- produces is not covering the code, it is covering the half somebody remembered.
        local n = data.damage or 10
        local damage = data.channel == 'fatigue' and { fatigue = n } or { health = n }
        victim:sendEvent('Hit', {
            damage = damage,
            strength = 1,
            successful = true,
            sourceType = 'Melee',
            attacker = playerScript(),
        })
    end,

    -- M5 test hook: CAST a damaging spell at a cell NPC (castat:<recordId>:<magnitude>).
    -- The melee hook posts a `Hit` event; this one goes through the MAGIC path
    -- (mwmechanics/spelleffects.cpp), which is a different code path entirely and the one that
    -- never propagated before the puppet registry existed. Headless CDP cannot cast a spell, so
    -- without this there is no automated way to exercise it at all.
    mpTestCastAt = function(data)
        local victim = nil
        for _, obj in ipairs(world.activeActors) do
            if obj:isValid() and obj.recordId == data.record then victim = obj break end
        end
        if not victim then
            print('[mp] mpTestCastAt: no victim for ' .. tostring(data.record))
            mp.testSet('castAt', 'no-victim')
            return
        end
        -- A SPELL THE OWNER ALSO HAS. Creating a record here would make a DYNAMIC spell that
        -- exists only on this client; the owner applies the spell by id
        -- (combat.lua MP_CombatSpellHit), finds nothing, and silently applies nothing — which
        -- is exactly how this failed the first time. Pick one out of the shared content
        -- instead, so both sides can resolve it.
        if not testCastSpellId then
            local harmful = { damagehealth = true, firedamage = true, shockdamage = true,
                              frostdamage = true, poison = true }
            local okFind = pcall(function()
                for _, spell in pairs(core.magic.spells.records) do
                    for _, eff in ipairs(spell.effects or {}) do
                        local id = eff.effect and eff.effect.id or eff.id
                        if id and harmful[tostring(id)] then
                            testCastSpellId = spell.id
                            return
                        end
                    end
                end
            end)
            if not okFind or not testCastSpellId then
                print('[mp] mpTestCastAt: no harmful spell in this content')
                mp.testSet('castAt', 'no-harmful-spell')
                return
            end
        end
        local okAdd, err = pcall(function()
            types.Actor.activeSpells(victim):add({
                id = testCastSpellId, effects = { 0 },
                caster = playerScript(), ignoreResistances = true,
            })
        end)
        if not okAdd then
            print('[mp] mpTestCastAt failed: ' .. tostring(err))
            mp.testSet('castAt', 'add-failed:' .. tostring(err))
        else
            mp.testSet('castAt', 'cast:' .. tostring(testCastSpellId))
        end
    end,

    -- M4 test hook: kill a specific cell NPC (holder side drives the death edge).
    mpKillNpc = function(data)
        if type(data.id) == 'string' and not actors.killActorByRecord(data.id) then
            print('[mp] mpKillNpc: no actor with record ' .. data.id .. ' in cell')
        end
    end,

    -- Toggle/lock/unlock the nearest content-file door (the real ref path).
    mpDoorToggle = function()
        local door = nearestDoor()
        if door then objects.onActivate(door, playerScript()) ; pcall(function() types.Door.activateDoor(door) end) end
    end,
    mpDoorLock = function(data)
        local door = nearestDoor()
        if door then
            pcall(function() types.Lockable.lock(door, data.level or 50) end)
            mp.sendEvent('ObjectLock', { ref = door, cellKey = ownCellKeyCache, lockLevel = data.level or 50 })
        end
    end,
    mpDoorUnlock = function()
        local door = nearestDoor()
        if door then
            pcall(function() types.Lockable.unlock(door) end)
            mp.sendEvent('ObjectLock', { ref = door, cellKey = ownCellKeyCache })
        end
    end,

    -- M1/M4 snap service: puppet.lua steering diverged (blocked, warp) -> hard teleport.
    -- actorKey => an M4 NPC puppet (routed to the actors hub); id => a remote-player puppet.
    mpSnapRequest = function(data)
        if data.actorKey then
            actors.snapActor(data.actorKey, data)
            return
        end
        local p = data.id and puppets[data.id]
        if p and tryTeleport(p.obj, destCellArg(), util.vector3(data.x, data.y, data.z)) then
            print('[mp] puppet snap #' .. tostring(data.id) .. ' (' .. tostring(data.why) .. ')')
        end
    end,

    MP_PlayerList = function(data)
        roster = {}
        for _, p in ipairs(data.players or {}) do
            roster[#roster + 1] = { id = p.id, name = p.name }
        end
        mirrorRoster()
    end,

    -- player.lua -> here -> server (Event tier, PROTOCOL.md `ChatSend`).
    -- Phase C uplink. One handler for the whole family: the player script names the op, so
    -- adding a social message does not mean touching the global script again. `op` is
    -- checked against a whitelist rather than forwarded blindly — a local script must not
    -- be able to name an arbitrary server event.
    mpSocial = function(data)
        local OPS = {
            FriendRequest = true, FriendAccept = true, FriendRemove = true,
            BlockAdd = true, BlockRemove = true, InviteSend = true, InviteAccept = true,
            PresenceMode = true, MuteAdd = true, MuteRemove = true,
            ReportPlayer = true,
            -- Social UX: availability (Online/Offline), cross-world join, and the owner's
            -- in-place Solo<->Party world flip.
            SetAvailability = true, JoinFriend = true, SetWorldMode = true,
            -- F3 world browser. The server takes the ACCOUNT from the authenticated
            -- session, never from here, so a client cannot list or create sessions under
            -- someone else's identity.
            WorldList = true, WorldCreate = true,
        }
        local op = tostring(data.op or '')
        if not OPS[op] then return end
        mp.sendEvent(op, {
            name = data.name, acct = data.acct, mode = data.mode, id = data.id,
            target = data.target, kind = data.kind, payload = data.payload,
            reason = data.reason, voice = data.voice, value = data.value,
            state = data.state,
        })
    end,

    -- Character slots (player UI -> here). The slot list lives on net (from Welcome /
    -- CharacterResult); the hub asks for it, switches to another slot (redial with the
    -- selection), or creates one (session-tier message, answered by CharacterResult).
    mpChars = function()
        toPlayer('MP_Characters', { characters = net.characters or {}, active = net.characterId or '' })
    end,
    mpCharSwitch = function(data)
        local id = tostring(data.id or '')
        if id == '' or id == net.characterId then return end
        net.setCharacter(id)
        -- The reboot reuses the boot fragment, and net state dies with the Lua VM — so the
        -- chosen slot must ride the mirror or the reload boots the OLD character.
        mp.testSet('switchChar', id)
        net.switchTo(net.currentTarget())
    end,
    mpCharCreate = function(data)
        local name = tostring(data.name or '')
        if name == '' then return end
        net.sendSession({ t = 'CharacterCreate', name = name })
    end,
    -- Onboarding profile submit (email + unique public handle).
    -- Phase 4 spawn replay: place the owed actor next to the player. Created locally
    -- rather than through the object-sync path on purpose — it exists FOR THIS CHARACTER
    -- (that is the whole point of replaying a one-shot), so broadcasting it would put a
    -- second Staada in front of everyone who already killed theirs.
    mpQuestSpawn = function(data)
        local player = playerScript()
        if not player or not data.recordId then return end
        local ok, err = pcall(function()
            local obj = world.createObject(data.recordId)
            obj:teleport(player.cell, player.position + util.vector3(150, 150, 0))
        end)
        if ok then
            print('[mp] quest spawn replayed: ' .. tostring(data.recordId))
            notice('Something stirs nearby.')
        else
            print('[mp] quest spawn failed: ' .. tostring(err))
        end
    end,
    mpProfileSetup = function(data)
        net.sendSession({
            t = 'ProfileSetup',
            email = tostring(data.email or ''),
            username = tostring(data.username or ''),
            marketingOptIn = data.marketingOptIn == true,
        })
    end,

    -- F3: switch worlds. A reconnect, not a page reload — mp.connect takes any URL, so the
    -- engine and loaded assets stay put and only the session moves. Accounts are shared
    -- across worlds, so the login that got us here works there too.
    mpNetDrop = function()
        mp.disconnect()
    end,

    mpSocialJoinById = function(data)
        toPlayer('MP_SocialJoinById', { id = tostring(data.id or '') })
    end,

    -- COMPANIONS. Sent by scripts/mp/companion.lua, which runs on the ACTOR because a global
    -- script cannot read AI package state for a foreign actor. This is the only route by which
    -- the fact reaches anywhere it can be acted on.
    mpActorFollow = function(data)
        actors.noteFollow(data and data.actor, data and data.target)
    end,

    mpSocialTab = function(data)
        -- toPlayer, not a world.players loop: the same helper every other player-bound
        -- bridge here uses, and the one that actually resolves the player script.
        toPlayer('MP_SocialTab', { tab = tostring(data.tab or '') })
    end,

    mpJoinWorld = function(data)
        -- `url` is still honoured for any caller that already has one; the Worlds tab now
        -- sends the world's FIELDS instead and lets worldUrlOf decide, so the gateway-path
        -- rule lives in exactly one place. Without this the tab's join button computed
        -- ws://nil:nil/ws, because the directory publishes no host or port.
        local url = tostring(data.url or '')
        if url == '' then url = worldUrlOf(data) or '' end
        if url == '' then
            -- Say so. A silent return here is indistinguishable from a click that did nothing,
            -- and that is how this stayed broken.
            print('[mp] cannot join ' .. tostring(data.name) .. ': it published no address')
            notice('That world did not say where to connect.')
            return
        end
        print('[mp] switching to ' .. tostring(data.name) .. ' at ' .. url)
        net.switchTo(url)
    end,

    -- The where-am-I switcher (from the Social hub). Solo/Party flip our OWN world in
    -- place; Offline peels us home + hides us; Online restores us to where we last were.
    mpSetTicket = function(data)
        net.setLoginTicket(tostring(data and data.ticket or ''))
    end,

    mpWhere = function(data)
        -- Nothing to do in multiplayer until the character exists: no leaving the solo world
        -- (or flipping it joinable) mid-chargen. The server's own chargen gate backs this up.
        if not chargenDone then
            notice('Finish creating your character first.')
            return
        end
        local mode = tostring(data.mode or '')
        -- THE LATEST CLICK WINS. pendingFlip queues a mode change to apply once we are back in
        -- our own world, and nothing used to clear it when the player chose something else in
        -- the meantime. A queued 'private' from an earlier Solo click then fired on the next
        -- join and overrode the Party the player had just asked for — the server logged
        -- mode_flip party immediately followed by mode_flip private, and the switcher snapped
        -- back to Solo with no explanation.
        pendingFlip = nil
        local inOwn = worldUrls.own ~= nil and net.currentTarget() == worldUrls.own
        if mode == 'solo' then
            if inOwn or not worldUrls.own then mp.sendEvent('SetWorldMode', { mode = 'private' })
            else pendingFlip = 'private'; net.switchTo(worldUrls.own) end
        elseif mode == 'party' then
            if inOwn or not worldUrls.own then mp.sendEvent('SetWorldMode', { mode = 'party' })
            else pendingFlip = 'party'; net.switchTo(worldUrls.own) end
        elseif mode == 'offline' then
            if not inOwn and worldUrls.own then worldUrls.lastOut = net.currentTarget() end
            mp.sendEvent('SetAvailability', { state = 'offline' })
            if inOwn or not worldUrls.own then mp.sendEvent('SetWorldMode', { mode = 'private' })
            else pendingFlip = 'private'; net.switchTo(worldUrls.own) end
        elseif mode == 'online' then
            mp.sendEvent('SetAvailability', { state = 'online' })
            if worldUrls.lastOut and net.currentTarget() ~= worldUrls.lastOut then
                net.switchTo(worldUrls.lastOut); worldUrls.lastOut = nil
            end
        end
    end,

    -- Script removal lives here because removeScript is bound on GObject only. Both senders
    -- have already done whatever had to happen first (puppet.lua re-enables AI before
    -- asking), and the event hop is exactly what guarantees that ordering.
    mpPuppetDetached = function(data)
        if data.obj and data.obj:isValid() then
            data.obj:removeScript('scripts/mp/puppet.lua')
        end
    end,

    mpRemoveTestKill = function(data)
        if data.obj and data.obj:isValid() then
            data.obj:removeScript('scripts/mp/testkill.lua')
        end
    end,

    mpChatSend = function(data)
        if type(data.text) == 'string' and data.text ~= '' then
            -- Forward the channel selector's choice + whisper target, not just the text — the
            -- server reads {channel, to} (say/party/global/whisper). Dropping them here would
            -- silently flatten every message to 'say'.
            mp.sendEvent('ChatSend', {
                text = data.text,
                channel = tostring(data.channel or 'say'),
                to = tostring(data.to or ''),
            })
        end
    end,

    -- --- M7/M8 bridges + test hooks -------------------------------------------------------
    -- M2 PlayerEquipment is authored in the PLAYER script, but only the global script owns
    -- the custom-record registry (world.createRecord is global-only), so the snapshot is
    -- routed through here and every slot id is mapped to its SERVER record id first. A raw
    -- local dynamic id on the wire is the exact M3 bug §M7 exists to close.
    mpEquipmentOut = function(data)
        local slots = {}
        for slot, recordId in pairs(data.slots or {}) do
            slots[slot] = worldmp.toNet(recordId)
        end
        mp.sendEvent('PlayerEquipment', { slots = slots })
    end,
    -- Spellbook out, mapped — the sibling of mpEquipmentOut, and for the same reason: the
    -- custom-record registry is global-only, so a player-script send would put a raw local
    -- dynamic id on the wire.
    mpSpellbookOut = function(data)
        local function mapped(list)
            local out = {}
            for i, id in ipairs(list or {}) do out[i] = worldmp.toNet(id) end
            return out
        end
        mp.sendEvent('PlayerSpellbook', { add = mapped(data.add), remove = mapped(data.remove) })
    end,
    mpGuiReply = function(data)
        worldmp.sendGuiReply(data.guiId, data.data)
    end,
    mpTestRest = function(data) worldmp.testRest(data.hours) end,
    mpTestRecord = function(data) worldmp.testCreateRecord(data.name, data.noRegister) end,
    mpTestSpell = function(data) worldmp.testCreateSpell(data.name) end,
    mpTestEnchanted = function(data) worldmp.testCreateEnchanted(data.name) end,
    mpTestWeather = function(data) worldmp.testWeather(data.index) end,
    mpTestAdmin = function(data) admin.send(data.cmd, data.args) end,
    -- E3: the admin window's uplink. Same registry, same rank gate, same audit trail as
    -- the /slash path — a second route to these actions would be a second place for the
    -- permission check to be wrong.
    mpAdminCommand = function(data)
        if type(data.cmd) == 'string' and data.cmd ~= '' then
            adminUiPending = adminUiPending + 1
            admin.send(data.cmd, data.args or {})
        end
    end,
    -- Test-only window openers. The harness cannot drive SDL keys (PLAYTEST.md 9), so
    -- without these no automated check of the UI is possible at all.
    mpOpenUi = function(data)
        if data.which == 'admin' then toPlayer('MP_AdminUiOpen', {})
        elseif data.which == 'social' then toPlayer('MP_SocialUiOpen', {}) end
    end,

    -- --- M6: quest-layer bridges + test hooks -------------------------------------------
    -- onQuestUpdate is a PLAYER-context engine handler; player.lua forwards it here so the
    -- journal cache/echo guard lives in exactly one place.
    mpQuestUpdate = function(data)
        quests.onQuestUpdate(data.questId, data.stage)
    end,
    -- Dialogue window closed on the player side -> release the lock.
    -- Barter opened/closed on a merchant. Routed through the global script because the
    -- container machinery lives there and a local script cannot read another actor's inventory.
    mpBarterOpen = function(data)
        if data and data.merchant then objects.onBarterOpen(data.merchant) end
    end,
    mpBarterClose = function() objects.onBarterClose() end,
    mpDialogueClosed = function()
        quests.releaseLock('windowclosed')
    end,
    mpTestQuest = function(data) quests.testSetQuestStage(data.id, data.stage) end,
    mpTestGlobal = function(data) quests.testSetGlobal(data.name, data.value) end,
    mpTestBounty = function(data) quests.testSetBounty(data.n) end,
    mpTestFaction = function(data) quests.testJoinFaction(data.id, data.rank) end,
    mpTestDialogue = function(data) quests.testActivateNpc(data.id) end,
    -- Marks a topic as locally learned for the DIFF only; see quests.testLearnTopic for why
    -- the engine gives no way to do this for real from a script.
    mpTestLearnTopic = function(data) quests.testLearnTopic(data.id) end,
    mpTestMemberVar = function(data) quests.testSetMemberVar(data.id, data.name, data.value) end,
}

-- M3: object-sync appliers (MP_ObjectPlace/Delete/Move/Lock, MP_DoorState,
-- MP_Container*, MP_WorldCellState, MP_ObjectSpawnAck) live in objects.lua.
for name, fn in pairs(objects.handlers) do
    eventHandlers[name] = fn
end
-- M4: actor-authority appliers (MP_ActorAuthority*, MP_ActorMoveBatch/StatsDynamic/Death,
-- MP_WorldKillCount) live in actors.lua.
for name, fn in pairs(actors.handlers) do
    eventHandlers[name] = fn
end
-- M7: world-state appliers (MP_WorldTime, MP_WorldWeather*, MP_Record*, MP_WorldCellReset,
-- MP_WorldMapExplored, MP_Gui*) live in world.lua; M8 ops appliers in admin.lua.
for name, fn in pairs(worldmp.handlers) do
    eventHandlers[name] = fn
end
for name, fn in pairs(admin.handlers) do
    eventHandlers[name] = fn
end
-- M6: quest-layer appliers (MP_JournalEntry/JournalSync, MP_GlobalVarUpdate,
-- MP_MemberVarUpdate, MP_FactionUpdate, MP_CrimeUpdate, MP_DialogueLockResult) live in
-- quests.lua.
for name, fn in pairs(quests.handlers) do
    eventHandlers[name] = fn
end
-- M5: combat appliers (MP_CombatHit/SpellHit/Cast/Projectile) live in combat.lua.
for name, fn in pairs(combat.handlers) do
    eventHandlers[name] = fn
end
-- puppet.lua -> here: a hit landed on a puppet; forward it to the victim's owner.
eventHandlers.mpCombatHit = combat.onPuppetHit

eventHandlers.mpCombatSpellHit = combat.onPuppetSpellHit
-- Wrap the op-result applier to expose the outcome to the harness (s31 race assert).
local baseOpResult = eventHandlers.MP_ContainerOpResult
eventHandlers.MP_ContainerOpResult = function(data)
    if data.opId == lastChestOpId then
        mp.testSet('chestOp', json.encode({ ok = data.ok == true, reason = data.reason }))
    end
    baseOpResult(data)
end

-- Web loading screen: a cell load BLOCKS the emscripten main loop, so the browser cannot
-- composite during it — OpenMW's own loading screen draws frames that never reach the screen
-- and the tab looks frozen. The only thing that works is having the overlay already ON SCREEN
-- before the block, so signal on door activation, which fires BEFORE the teleport.
-- ponytail: teleport doors only — that is the freeze players actually hit (boat -> dock,
-- entering a building). Widen to every cell boundary if the exteriors turn out to stall too.
local cellLoadSeq = 0
local lastCellLoadAt = 0
local lastCellLoadCell = nil
local CELL_LOAD_DEBOUNCE = 2.0
-- How long after a transition an ECHO is still plausible. Comfortably longer than a cell load,
-- and short enough that a player who walks to a second door is not affected.
local CELL_LOAD_ECHO_WINDOW = 10.0

local function currentCellId()
    local p = world.players[1]
    local ok, id = pcall(function() return p and p.cell and p.cell.id or nil end)
    if ok then return id end
    return nil
end

local function signalCellLoad()
    -- ONE SIGNAL PER TRANSITION. A single door raises this more than once -- the overlay
    -- appears, clears as the player arrives, then appears AGAIN over a world that has already
    -- finished loading. That is the double flash players see on every area change.
    --
    -- A TIME-ONLY DEBOUNCE CANNOT CATCH IT, which is why the previous one did not. The window
    -- is measured from when the overlay is SHOWN, and the cell load happens inside it: the load
    -- blocks the emscripten main loop for seconds, so by the time the echo arrives the 2 s
    -- window has long expired and it passes straight through. The guard was structurally unable
    -- to see the event it was written for.
    --
    -- So key on WHERE THE PLAYER IS instead. The legitimate signal fires BEFORE the teleport,
    -- while they still stand in the origin cell; the echo fires after they have arrived, from a
    -- different cell entirely. Same cell means a genuine new journey; different cell inside the
    -- echo window means the journey we already announced.
    local now = core.getRealTime()
    local cur = currentCellId()

    if now - lastCellLoadAt < CELL_LOAD_DEBOUNCE then return end

    if lastCellLoadCell ~= nil and cur ~= nil and cur ~= lastCellLoadCell
        and now - lastCellLoadAt < CELL_LOAD_ECHO_WINDOW then
        -- Absorbed, and the origin is updated to where we actually are. A player who now uses
        -- a second door from THIS cell matches on cell and signals normally, so at most one
        -- overlay is ever swallowed, and only for a door used within seconds of arriving.
        lastCellLoadCell = cur
        return
    end

    lastCellLoadAt = now
    lastCellLoadCell = cur
    cellLoadSeq = cellLoadSeq + 1
    mp.testSet('cellLoad', tostring(cellLoadSeq))
end
I.Activation.addHandlerForType(types.Door, function(door, actor)
    if actor ~= world.players[1] then return end
    local ok, isTeleport = pcall(function() return types.Door.isTeleport(door) end)
    if not (ok and isTeleport) then return end
    -- A DOOR YOU CANNOT OPEN LOADS NOTHING. This fires on the ATTEMPT, which is the whole
    -- point — the overlay has to be on screen before the main loop blocks — but a locked door
    -- refuses the activation, so the player got a loading screen for a cell they never
    -- entered and were left standing in front of the same door.
    local lockOk, locked = pcall(function()
        return types.Lockable.objectIsInstance(door) and types.Lockable.isLocked(door)
    end)
    if lockOk and locked then return end
    signalCellLoad()
end)

return {
    engineHandlers = {
        onInit = start,
        onLoad = start,
        onActivate = function(object, actor)
            if net.state == 'Joined' then
                local ok, err = pcall(objects.onActivate, object, actor)
                if not ok then print('[mp] onActivate hook error: ' .. tostring(err)) end
                -- M6: watch the object's MWScript locals across the interaction window.
                local okq, errq = pcall(quests.onActivate, object, actor)
                if not okq then print('[mp] quests.onActivate hook error: ' .. tostring(errq)) end
            end
        end,
        onItemActive = function(item)
            if net.state == 'Joined' then
                local ok, err = pcall(objects.onItemActive, item)
                if not ok then print('[mp] onItemActive hook error: ' .. tostring(err)) end
            end
        end,
        onUpdate = function()
            net.tick()
            flushNotices()
            restoreTick()
            restorePositionTick(core.getRealTime())
            puppetTick()
            chargenTick()
            if net.state == 'Joined' then
                local now = core.getRealTime()
                objects.tick(now)
                actors.tick(now)
                quests.tick(now)
                worldmp.tick(now)
                mirrorDoor(now)
            end
        end,
    },
    eventHandlers = eventHandlers,
}
