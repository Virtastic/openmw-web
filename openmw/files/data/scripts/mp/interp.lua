-- Snapshot interpolation buffer for remote-player puppets (M1).
-- Poses arrive at ~15 Hz (server rebroadcast tick 66 ms); the puppet renders the stream
-- RENDER_DELAY behind real time so there is almost always a pair of snapshots to
-- interpolate between — network jitter turns into smooth motion instead of stutter.
local Interp = {}
Interp.__index = Interp

local RENDER_DELAY = 0.1 -- seconds behind the newest snapshot
local MAX_SNAPSHOTS = 16 -- ~1s of history at 15 Hz

function Interp.new()
    return setmetatable({ buf = {} }, Interp)
end

-- s = {t=realTime, x=, y=, z=, yaw=, pitch=, flags=, animVel=}
function Interp:push(s)
    local buf = self.buf
    buf[#buf + 1] = s
    if #buf > MAX_SNAPSHOTS then table.remove(buf, 1) end
end

function Interp:newestTime()
    local buf = self.buf
    return #buf > 0 and buf[#buf].t or nil
end

-- Target pose at (now - RENDER_DELAY): linear position interpolation between the bracketing
-- snapshots, clamped to the newest when the stream stalls. Angles/flags snap to the newer
-- sample (they are already low-rate discrete state). nil when the buffer is empty.
function Interp:target(now)
    local buf = self.buf
    local n = #buf
    if n == 0 then return nil end
    local rt = now - RENDER_DELAY
    if rt <= buf[1].t then return buf[1] end
    for i = n, 1, -1 do
        if buf[i].t <= rt then
            local a, b = buf[i], buf[i + 1]
            if not b then return a end
            local k = (rt - a.t) / math.max(b.t - a.t, 1e-6)
            return {
                t = rt,
                x = a.x + (b.x - a.x) * k,
                y = a.y + (b.y - a.y) * k,
                z = a.z + (b.z - a.z) * k,
                yaw = b.yaw,
                pitch = b.pitch,
                flags = b.flags,
                animVel = b.animVel,
            }
        end
    end
    return buf[n]
end

function Interp:clear()
    self.buf = {}
end

return Interp
