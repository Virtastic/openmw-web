-- Snapshot interpolation buffer for remote-player puppets (M1) and shared NPCs.
-- Poses arrive at ~15 Hz near, 5 Hz mid (server rebroadcast tick 66 ms); the puppet renders
-- the stream a little behind real time so there is almost always a pair of snapshots to
-- interpolate between -- network jitter turns into smooth motion instead of stutter.
local Interp = {}
Interp.__index = Interp

-- HOW FAR BEHIND, ADAPTIVE. It used to be a constant, cut to 40 ms (BELOW one 66 ms batch
-- interval) to win s172's time-lag bar on the LAN builder (#175). On a real connection that
-- left no buffer at all: every late or bunched pose stalled the puppet, then it lurched to
-- catch up -- players called NPCs "jerky" and movement "rubber-bandy". The delay is now what
-- THIS stream needs: the mean gap between arrivals plus two mean deviations of it, so a steady
-- LAN link settles near one interval (~85 ms) and a jittery one buys itself more buffer. A
-- 5 Hz mid-tier NPC gets ~250 ms and moves smoothly instead of hopping every 200 ms.
local MIN_DELAY = 0.04
local MAX_DELAY = 0.30
local START_DELAY = 0.10 -- before two arrivals have been seen
local GAP_MAX = 0.5 -- a longer silence is a stop, a cell load or a tier change: not jitter
local GAP_GAIN = 1 / 8 -- the TCP-RTO smoothing for the mean and the deviation
local MARGIN = 0.01 -- always a hair more than the arrival statistics say
local PULL = 0.1 -- how fast a sample's playout time follows its arrival time
local SLEW = 0.1 -- seconds of delay change per second: render time runs at 90-110%, never jumps
local MAX_SNAPSHOTS = 16 -- ~1s of history at 15 Hz
-- A LATE POSE IS NOT A STOP. Even with the adaptive buffer a pose can arrive later than it
-- allows, and the target would freeze on the newest sample: the speed feed-forward read 0 and
-- the puppet slowed toward a point that had stopped. Carry on along the last step for at most
-- this long; a real stop then overshoots by <= ~22 u at a run, comfortably under puppet.lua's
-- STEER_START (24 u).
local EXTRAP_S = 0.09

function Interp.new()
    return setmetatable({ buf = {}, mean = nil, dev = 0.01, cur = START_DELAY, lastNow = nil }, Interp)
end

-- s = {t=arrival realTime, x=, y=, z=, yaw=, pitch=, flags=, animVel=}
--
-- THE SAMPLE'S TIME IS WHEN IT WAS MADE, NOT WHEN IT ARRIVED. The server generates poses evenly
-- (one per batch interval) but they reach us bunched and late; stamping each with its arrival
-- time wrote that jitter into the rendered SPEED (equal steps over 33 ms then 99 ms read as
-- 280 then 93 u/s). A sample's time is therefore the previous one's plus the mean gap, pulled a
-- little toward its arrival and never later than it (it cannot have been made after it arrived).
-- The buffer delay below covers whatever lateness is left.
function Interp:push(s)
    local buf = self.buf
    local last = buf[#buf]
    s.at = s.t
    if last then
        local gap = s.at - last.at
        if gap > 0.005 and gap < GAP_MAX then
            if self.mean == nil then
                self.mean = gap
            else
                self.dev = self.dev + (math.abs(gap - self.mean) - self.dev) * GAP_GAIN
                self.mean = self.mean + (gap - self.mean) * GAP_GAIN
            end
            local st = last.t + self.mean
            st = st + (s.at - st) * PULL
            s.t = math.min(s.at, math.max(st, last.t + 0.005))
        end
    end
    buf[#buf + 1] = s
    if #buf > MAX_SNAPSHOTS then table.remove(buf, 1) end
end

function Interp:newestTime()
    local buf = self.buf
    return #buf > 0 and buf[#buf].t or nil
end

-- The delay this stream wants right now, and the (slewed) one actually in use.
function Interp:wantedDelay()
    if self.mean == nil then return START_DELAY end
    return math.min(MAX_DELAY, math.max(MIN_DELAY, self.mean + 2 * self.dev + MARGIN))
end

function Interp:delay()
    return self.cur
end

-- Move the delay in use toward the wanted one by at most SLEW x the time that has passed.
local function advance(self, now)
    local last = self.lastNow
    self.lastNow = now
    local want = self:wantedDelay()
    if not last then
        self.cur = want
        return
    end
    local step = SLEW * math.min(math.max(now - last, 0), 0.25)
    self.cur = self.cur + math.max(-step, math.min(step, want - self.cur))
end

-- Pose at render time rt: linear position interpolation between the bracketing snapshots,
-- extrapolated for at most EXTRAP_S past the newest. Angles/flags snap to the newer sample
-- (they are already low-rate discrete state). nil when the buffer is empty.
local function sample(self, rt)
    local buf = self.buf
    local n = #buf
    if n == 0 then return nil end
    if rt <= buf[1].t then return buf[1] end
    for i = n, 1, -1 do
        if buf[i].t <= rt then
            local a, b = buf[i], buf[i + 1]
            if not b then
                local p, h = buf[i - 1], math.min(rt - a.t, EXTRAP_S)
                if not p or h <= 0 or a.t - p.t < 1e-3 then return a end
                local k = h / (a.t - p.t)
                return { t = rt, x = a.x + (a.x - p.x) * k, y = a.y + (a.y - p.y) * k, z = a.z + (a.z - p.z) * k,
                    yaw = a.yaw, pitch = a.pitch, flags = a.flags, animVel = a.animVel }
            end
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

-- Target pose at (now - delay). Called once a frame by the puppet: it also moves the delay.
function Interp:target(now)
    if #self.buf == 0 then return nil end
    advance(self, now)
    return sample(self, now - self.cur)
end

-- Ground speed (u/s) of the rendered path at `now`: the same delayed target the puppet steers to,
-- over SPEED_WINDOW so one jittery arrival time cannot spike it. 0 with fewer than two samples.
local SPEED_WINDOW = 0.1
function Interp:speed(now)
    if #self.buf < 2 then return 0 end
    local a, b = sample(self, now - self.cur - SPEED_WINDOW), sample(self, now - self.cur)
    if not (a and b) then return 0 end
    return math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2) / SPEED_WINDOW
end

-- Ground velocity (u/s, x and y) of the rendered path at `now`, same window as speed(). 0,0 with
-- fewer than two samples. puppet.lua uses its direction to tell "ahead of a walking target" from
-- "behind it".
function Interp:velocity(now)
    if #self.buf < 2 then return 0, 0 end
    local a, b = sample(self, now - self.cur - SPEED_WINDOW), sample(self, now - self.cur)
    if not (a and b) then return 0, 0 end
    return (b.x - a.x) / SPEED_WINDOW, (b.y - a.y) / SPEED_WINDOW
end

-- The forward/side controls that move a body facing `yaw` along the world vector (cx, cy) u/s,
-- as fractions of `top` (its walk/run speed), capped at `cap`. MW yaw: 0 = +Y, clockwise, so
-- forward = (sin, cos) and right = (cos, -sin). Lets a puppet keep the server's facing while it
-- moves any direction -- a creature backing off or side-stepping in a fight, still facing you.
function Interp.bodyControls(cx, cy, yaw, top, cap)
    local want = math.sqrt(cx * cx + cy * cy)
    if want < 1e-3 or not top or top <= 0 then return 0, 0 end
    local frac = math.min(cap or 1.25, want / top)
    local fx, fy = math.sin(yaw), math.cos(yaw)
    return frac * (cx * fx + cy * fy) / want, frac * (cx * fy - cy * fx) / want
end

function Interp:clear()
    self.buf = {}
    self.mean = nil
    self.dev = 0.01
    self.cur = START_DELAY
    self.lastNow = nil
end

return Interp
