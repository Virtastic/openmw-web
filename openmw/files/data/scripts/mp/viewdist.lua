-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- DYNAMIC VIEW DISTANCE (OT3-212): view distance follows the frame time, capped by the quality
-- tier's value (the engine's "viewing distance" setting, which play/index.html writes per tier).
-- The decisions are in scripts/mp/viewdistctl.lua; this only feeds it frames and applies them.
-- The ONLY thing that calls camera.setViewDistance: nothing else in the tree may.
local camera = require('openmw.camera')
local mp = require('openmw.mp')
local ctl = require('scripts.mp.viewdistctl')

-- The sim peer renders nothing; its frame time is the simulation's, not a player's.
if mp.isSystem() then return {} end

local state = nil

return {
    engineHandlers = {
        onFrame = function(dt) -- 0 while paused: the controller skips it
            local ceiling = camera.getBaseViewDistance()
            if not state then state = ctl.new(math.min(camera.getViewDistance(), ceiling)) end
            local vd = ctl.update(state, dt, ceiling)
            if vd then
                camera.setViewDistance(vd)
                mp.set('viewDistance', tostring(math.floor(vd))) -- the page mirror (window.omw.state)
            end
        end,
    },
}
