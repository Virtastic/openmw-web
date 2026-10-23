-- Copyright (C) 2025-2026 Virtastic - https://virtastic.app
-- SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
-- json.lua's string escaping, RUN under the interpreter given (run.sh: lua5.4, the browser
-- engine; run.lua runs the same checks under 5.1). Pattern classes differ between the two
-- (5.4 has no %z), so a compile alone does not prove the escaping.
package.path = './openmw/files/data/?.lua;' .. package.path
local json = require('scripts.mp.json')
local fails = 0
local function check(name, ok)
  if not ok then fails = fails + 1; print('  FAIL ' .. _VERSION .. ' ' .. name) end
end
check('NUL is escaped', json.encode('a\0b') == '"a\\u0000b"')
check('a z stays a z', json.encode('zz') == '"zz"')
check('control bytes and DEL are escaped', json.encode('\1\31\127') == '"\\u0001\\u001f\\u007f"')
check('quote, backslash and newline keep their short escapes', json.encode('"\\\n') == '"\\"\\\\\\n"')
local all = {}
for b = 0, 255 do all[#all + 1] = string.char(b) end
all = table.concat(all)
check('every byte round-trips', json.decode(json.encode(all)) == all)
if fails > 0 then os.exit(1) end
print('  ok   json.lua escapes NUL and control bytes under ' .. _VERSION)
