-- Test-only one-shot: kill the actor this script is attached to.
--
-- Why this exists: dynamic-stat writes are Self-gated in OpenMW 0.52 — a GLOBAL script
-- cannot zero another actor's health (the call simply fails, and a pcall around it hides
-- that). Attaching a CUSTOM script is the supported way to reach an actor's Self context,
-- so actors.killActorByRecord() attaches this, it kills its host, and removes itself.
--
-- Production never needs this: real deaths come from the engine's own damage pipeline on
-- the authority holder (M5), and a non-holder's puppet applies death via MP_Stats, which
-- is already running in Self context.
local self = require('openmw.self')
local types = require('openmw.types')

types.Actor.stats.dynamic.health(self).current = 0
-- Removing ourselves inside onInit would race the engine's script setup; do it on the
-- first update instead, once the stat write above has been applied.
return {
    engineHandlers = {
        onUpdate = function()
            self:removeScript('scripts/mp/testkill.lua')
        end,
    },
}
