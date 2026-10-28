-- One-shot: kill the actor this script is attached to, then ask to be removed.
--
-- Why this exists: dynamic-stat writes are Self-gated in OpenMW 0.52 — a GLOBAL script
-- cannot zero another actor's health (the call simply fails, and a pcall around it hides
-- that). Attaching a CUSTOM script is the supported way to reach an actor's Self context.
-- The cell holder attaches it to apply a recorded death (actors.lua noteCellDeaths and
-- killRecorded); the harness kill hook (killActorByRecord) uses it too.
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
            core.sendGlobalEvent('mpRemoveSelfKill', { obj = self.object })
        end,
    },
}
