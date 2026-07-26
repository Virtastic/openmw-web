-- Shared MyGUI building blocks for the multiplayer windows, so they look like part of the
-- game rather than like a debug overlay.
--
-- The first version of these windows used a bare `boxSolid` with rows of textNormal and no
-- spacing — a black slab of text. The engine's own Options screen is built from a small set
-- of templates (scripts/omw/settings/renderers.lua), and matching them is most of what
-- "native" means here:
--
--   box / boxTransparent  the bordered frame, using Morrowind's own border textures and the
--                         player's configured menu transparency
--   padding               inner margin, so text never touches the border
--   interval              consistent gaps between controls
--   textHeader            the header colour from the GMSTs, not a hardcoded one
--
-- Colours come from core.getGMST via MWUI constants, so they follow the game's own font
-- colour settings instead of being invented here.
local ui = require('openmw.ui')
local util = require('openmw.util')
local async = require('openmw.async')
local I = require('openmw.interfaces')

local M = {}

-- MyGUI reads '#' as a colour escape ("#RRGGBB"), so any text carrying one is silently
-- mangled — a player name containing '#' would corrupt the row it appears in. '##' is the
-- literal. Every text-producing helper below goes through this.
function M.escape(text)
    return (tostring(text):gsub('#', '##'))
end

function M.text(str, opts)
    opts = opts or {}
    local layout = {
        template = opts.header and I.MWUI.templates.textHeader or I.MWUI.templates.textNormal,
        props = { text = M.escape(str) },
    }
    if opts.color then layout.props.textColor = opts.color end
    if opts.grow then layout.external = { grow = opts.grow } end
    return layout
end

M.interval = { template = I.MWUI.templates.interval }

-- A horizontal row of layouts, evenly separated. Flex rows are how the settings screen puts
-- a label and its control on one line, and it is what stops everything stacking into a
-- single column of prose.
function M.row(items, opts)
    opts = opts or {}
    local content = {}
    for i, item in ipairs(items) do
        if i > 1 then content[#content + 1] = M.interval end
        content[#content + 1] = item
    end
    return {
        type = ui.TYPE.Flex,
        props = { horizontal = true, autoSize = true, align = opts.align },
        external = opts.grow and { grow = opts.grow } or nil,
        content = ui.content(content),
    }
end

function M.column(items, opts)
    opts = opts or {}
    local content = items
    -- Vertical breathing room between rows. Without it every control abuts the next and the
    -- panel reads as a wall of text, which is the single biggest difference between this and
    -- the game's own screens.
    if opts.spaced then
        content = {}
        for i, item in ipairs(items) do
            if i > 1 then content[#content + 1] = M.interval end
            content[#content + 1] = item
        end
    end
    return {
        type = ui.TYPE.Flex,
        props = { horizontal = false, autoSize = true },
        external = opts.grow and { grow = opts.grow } or nil,
        content = ui.content(content),
    }
end

-- A bordered inner panel, the way the settings screen groups related controls. Gives the
-- content a frame of its own instead of floating loose inside the window.
function M.panel(items, opts)
    opts = opts or {}
    return {
        template = I.MWUI.templates.box,
        external = opts.grow and { grow = opts.grow } or nil,
        content = ui.content {
            {
                template = I.MWUI.templates.padding,
                content = ui.content { M.column(items, { spaced = true }) },
            },
        },
    }
end

-- Forces a minimum width so the window has a stable footprint instead of shrink-wrapping
-- its longest line — a panel that resizes on every list change feels unfinished.
function M.minWidth(px)
    return { props = { size = util.vector2(px, 0) } }
end

-- A clickable control that reads as a button: bordered box + padding, like the settings
-- screen's own controls. There is no button template in MWUI, so this is the closest
-- native-looking equivalent rather than an invented style.
function M.button(label, onClick, opts)
    opts = opts or {}
    local inner = M.text(label, { color = opts.color })
    local box = {
        template = opts.disabled and I.MWUI.templates.disabled or I.MWUI.templates.box,
        content = ui.content {
            {
                template = I.MWUI.templates.padding,
                content = ui.content { inner },
            },
        },
    }
    if onClick and not opts.disabled then
        box.events = { mouseClick = async:callback(onClick) }
    end
    return box
end

-- Section heading plus a spacer. Used instead of "-- Friends --" strings, which were doing
-- the job of a header with punctuation.
function M.header(str)
    return M.column {
        M.text(str, { header = true }),
        M.interval,
    }
end

-- The outer frame every MP window shares: transparent bordered box (so the world stays
-- visible behind it, as with the game's own menus), padded, with a title.
function M.window(title, rows, opts)
    opts = opts or {}
    local body = { M.text(title, { header = true }) }
    for _, r in ipairs(rows) do body[#body + 1] = r end
    body[#body + 1] = M.minWidth(opts.width or 460)
    return {
        layer = opts.layer or 'Windows',
        template = I.MWUI.templates.boxTransparentThick,
        props = { position = opts.position or util.vector2(80, 60) },
        content = ui.content {
            {
                template = I.MWUI.templates.padding,
                content = ui.content { M.column(body, { spaced = true }) },
            },
        },
    }
end

return M
