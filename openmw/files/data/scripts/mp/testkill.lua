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
local core = require('openmw.core')
local self = require('openmw.self')
local types = require('openmw.types')

types.Actor.stats.dynamic.health(self).current = 0
-- Removing ourselves inside onInit would race the engine's script setup; do it on the
-- first update instead, once the stat write above has been applied.
-- `removeScript` is bound on GObject only, so a local script cannot remove itself: the
-- previous self:removeScript() here threw on EVERY update and this one-shot helper spun
-- forever, logging ~80 errors in a single scenario. Ask the global script instead, and only
-- once — an unguarded retry reproduces the same spin if removal is ever delayed.
local asked = false
return {
    engineHandlers = {
        onUpdate = function()
            if asked then return end
            asked = true
            core.sendGlobalEvent('mpRemoveTestKill', { obj = self.object })
        end,
    },
}
