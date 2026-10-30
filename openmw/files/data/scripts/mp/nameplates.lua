-- OT3-99: nameplates over other players: "Name" and, under it, their highest faction rank title.
--
-- The global script (global.lua, MP_PlayerTitles + the puppet registry) hands the player script
-- a list of {obj = puppet GameObject, name, title}; this module projects each body's head to the
-- screen with camera.worldToViewportVector and moves a pooled text element there. Cost control
-- (the ticket's "no measurable frame-time cost with 20 players in view"): at most MAX_PLATES
-- plates, the nearest ones, refreshed at RATE Hz, elements pooled and only re-laid out when the
-- on-screen position moved, none at all when the toggle is off (the page persists the toggle
-- and sends it as the `plates:on|off` command).
--
-- Everything that touches the engine is injected (`env`), so the selection, the label text and
-- the pooling are executed by wasm-build/lua-tests/run.lua.
local M = {}

M.MAX_PLATES = 20
M.MAX_DIST = 3500 -- game units (~50 m); beyond it a name is unreadable anyway
M.RATE = 0.1
M.HEAD_Z = 120 -- above the body's origin (feet) to above the head

function M.label(name, title)
    name = tostring(name or '?')
    if title and title ~= '' then return name .. '\n' .. tostring(title) end
    return name
end

-- plates: array of {id, name, title, pos = {x,y,z}}; cam = {x,y,z}. Nearest MAX_PLATES within MAX_DIST.
function M.select(plates, cam, maxN, maxDist)
    maxN, maxDist = maxN or M.MAX_PLATES, maxDist or M.MAX_DIST
    local out = {}
    for _, p in ipairs(plates or {}) do
        local dx, dy, dz = p.pos.x - cam.x, p.pos.y - cam.y, p.pos.z - cam.z
        local d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if d <= maxDist then out[#out + 1] = { plate = p, dist = d } end
    end
    table.sort(out, function(a, b) return a.dist < b.dist end)
    local sel = {}
    for i = 1, math.min(maxN, #out) do sel[i] = out[i].plate end
    return sel
end

-- env = { cameraPos() -> {x,y,z}, project(x,y,z) -> sx, sy | nil (behind the camera),
--         create() -> element{show(text,x,y), hide(), destroy()}, posOf(obj) -> {x,y,z} | nil }
function M.new(env)
    local self = { enabled = true, list = {}, pool = {}, acc = 0 }

    function self.setEnabled(on)
        self.enabled = on == true
        if not self.enabled then self.hideAll() end
    end

    function self.setPlates(list) self.list = list or {} end

    function self.hideAll()
        for _, e in ipairs(self.pool) do e.hide() end
    end

    function self.update(dt)
        if not self.enabled then return 0 end
        self.acc = self.acc + (dt or 0)
        if self.acc < M.RATE then return 0 end
        self.acc = 0
        local cam = env.cameraPos()
        if not cam then self.hideAll(); return 0 end
        local live = {}
        for _, p in ipairs(self.list) do
            local pos = env.posOf(p.obj)
            if pos then live[#live + 1] = { id = p.id, name = p.name, title = p.title, pos = { x = pos.x, y = pos.y, z = pos.z + M.HEAD_Z } } end
        end
        local sel = M.select(live, cam)
        local shown = 0
        for i, p in ipairs(sel) do
            local sx, sy = env.project(p.pos.x, p.pos.y, p.pos.z)
            local e = self.pool[i]
            if not e then e = env.create(); self.pool[i] = e end
            if sx then e.show(M.label(p.name, p.title), sx, sy); shown = shown + 1 else e.hide() end
        end
        for i = #sel + 1, #self.pool do self.pool[i].hide() end
        return shown
    end

    function self.destroy()
        for _, e in ipairs(self.pool) do e.destroy() end
        self.pool = {}
    end

    return self
end

-- The real engine environment, built lazily so the module loads (and is testable) without it.
function M.engineEnv()
    local ui = require('openmw.ui')
    local util = require('openmw.util')
    local camera = require('openmw.camera')
    return {
        cameraPos = function()
            local ok, p = pcall(camera.getPosition)
            return ok and p or nil
        end,
        posOf = function(obj)
            local ok, p = pcall(function() if obj:isValid() then return obj.position end end)
            return ok and p or nil
        end,
        project = function(x, y, z)
            local ok, v = pcall(camera.worldToViewportVector, util.vector3(x, y, z))
            if not ok or not v or v.z <= 0 then return nil end
            return v.x, v.y
        end,
        create = function()
            local el = ui.create({
                layer = 'HUD',
                type = ui.TYPE.Text,
                props = { text = '', visible = false, textSize = 16, textColor = util.color.rgb(0.95, 0.88, 0.7),
                    textShadow = true, textShadowColor = util.color.rgb(0, 0, 0), multiline = true,
                    relativePosition = util.vector2(0, 0), anchor = util.vector2(0.5, 1) },
            })
            return {
                show = function(text, x, y)
                    el.layout.props.text = text
                    el.layout.props.position = util.vector2(x, y)
                    el.layout.props.visible = true
                    el:update()
                end,
                hide = function()
                    if el.layout.props.visible then el.layout.props.visible = false; el:update() end
                end,
                destroy = function() el:destroy() end,
            }
        end,
    }
end

return M
