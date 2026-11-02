-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
--
-- DYNAMIC VIEW DISTANCE, the controller (OT3-212). Pure: no engine requires, so the Lua runner
-- drives it with made-up frame times. scripts/mp/viewdist.lua feeds it and applies its answer.
--
-- The quality tier's viewing distance (play/index.html TIER.vd, or ?vd= / ?tier=) is the CEILING;
-- it is read fresh every step, so the settings menu still moves it. The FLOOR keeps the world from
-- shrinking to nothing: half the ceiling, never under 4096 (a cell and a half), never over it.
--
-- Not a pump:
--  * a smoothed frame time (EMA), and a dead band between "too slow" and "headroom";
--  * at most one step every STEP_S, down in big steps, up in small ones, and up only after
--    UP_HOLD_S of steady headroom -- so a town's heavy frames do not bounce it back and forth;
--  * frames over HITCH_S (a cell load, a streamed-file stall, a tab in the background) are not
--    frame time at all: they are skipped, and a run of them restarts the smoothing.
-- DFPSO's failure mode (a lower view distance and no FPS back: the frame is bound by something
-- else) is checked for: a step down that did not make frames at least GAIN faster is futile;
-- after FUTILE_MAX of them the distance goes back to where they started and lowering rests for
-- FUTILE_REST_S.
local M = {}

M.TARGET = 1 / 50      -- long frames: smoothed frame time above this
M.HEADROOM = 1 / 58    -- headroom: below this (between the two, hold)
M.ALPHA = 0.05         -- EMA weight of one frame (~20 frames)
M.WARMUP = 30          -- frames to smooth before any decision
M.HITCH_S = 0.25
M.STEP_S = 2.0
M.UP_HOLD_S = 6.0
M.STEP_DOWN = 1024
M.STEP_UP = 512
M.GAIN = 0.03
M.FUTILE_MAX = 2
M.FUTILE_REST_S = 30.0
M.MIN_FLOOR = 4096

function M.floorOf(ceiling)
    return math.min(ceiling, math.max(M.MIN_FLOOR, ceiling * 0.5))
end

function M.new(current)
    return {
        vd = current, ema = nil, n = 0, clock = 0, lastStep = -math.huge, headroomSince = nil,
        -- the step down being judged: {at, ema, from}; futile counts in a row, and where they began
        judging = nil, futile = 0, futileFrom = nil, restUntil = -math.huge,
    }
end

local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end

-- One frame. `dt` real seconds (0 while paused), `ceiling` the tier's distance. Returns the
-- distance to apply when it changes, else nil.
function M.update(s, dt, ceiling)
    if not ceiling or ceiling <= 0 then return nil end
    local floor = M.floorOf(ceiling)
    -- The ceiling moved (settings menu): never above it, at once.
    if s.vd > ceiling or s.vd < floor then
        s.vd = clamp(s.vd, floor, ceiling)
        s.lastStep = s.clock
        return s.vd
    end
    if not dt or dt <= 0 then return nil end
    if dt > M.HITCH_S then
        s.n, s.ema, s.headroomSince, s.judging = 0, nil, nil, nil
        return nil
    end
    s.clock = s.clock + dt
    s.ema = s.ema and (s.ema + M.ALPHA * (dt - s.ema)) or dt
    s.n = s.n + 1
    if s.n < M.WARMUP then return nil end

    -- Judge the last step down once its frames have come through.
    if s.judging and s.clock - s.judging.at >= M.STEP_S then
        if s.ema <= s.judging.ema * (1 - M.GAIN) then
            s.futile, s.futileFrom = 0, nil
        else
            s.futile = s.futile + 1
            s.futileFrom = s.futileFrom or s.judging.from
        end
        s.judging = nil
        if s.futile >= M.FUTILE_MAX then
            local back = math.min(ceiling, s.futileFrom)
            s.futile, s.futileFrom = 0, nil
            s.restUntil = s.clock + M.FUTILE_REST_S
            s.lastStep = s.clock
            if back ~= s.vd then s.vd = back; return s.vd end
            return nil
        end
    end

    if s.ema < M.HEADROOM then
        s.headroomSince = s.headroomSince or s.clock
    else
        s.headroomSince = nil
    end
    if s.clock - s.lastStep < M.STEP_S then return nil end

    if s.ema > M.TARGET and s.vd > floor and s.clock >= s.restUntil and not s.judging then
        local from = s.vd
        s.vd = math.max(floor, s.vd - M.STEP_DOWN)
        s.lastStep = s.clock
        s.judging = { at = s.clock, ema = s.ema, from = from }
        return s.vd
    end
    if s.headroomSince and s.clock - s.headroomSince >= M.UP_HOLD_S and s.vd < ceiling then
        s.vd = math.min(ceiling, s.vd + M.STEP_UP)
        s.lastStep = s.clock
        s.headroomSince = s.clock -- another full hold before the next step up
        s.futile, s.futileFrom, s.judging = 0, nil, nil
        return s.vd
    end
    return nil
end

return M
