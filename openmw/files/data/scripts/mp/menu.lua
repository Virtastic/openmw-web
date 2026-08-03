-- Multiplayer MENU script (M0): minimal connection-status visibility before a game starts.
-- The session itself only runs in-game (global.lua); here we just tell the player MP is armed.
local mp = require('openmw.mp')

return {
    engineHandlers = {
        onInit = function()
            if mp.isEnabled() then
                print('[mp] multiplayer enabled — will connect to ' .. mp.getUrl()
                    .. ' as "' .. mp.getName() .. '" when a game starts')
            end
        end,
    },
}
