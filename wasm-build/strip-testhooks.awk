# Copyright (C) 2025-2026 Virtastic - https://virtastic.app
# SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
#
# OT3-234: blank every `-- @testhook begin` .. `-- @testhook end` region of a client script, so
# a release bake ships none of the harness handlers (give/kill/teleport/quest seams). Lines are
# blanked rather than dropped so a release stack trace still points at the source line.
# link-openmw.sh runs this when OMW_TEST_HOOKS is unset; lua-tests/run.sh compiles the result.
/^[ \t]*-- @testhook begin/ { if (skip) { bad = "nested"; exit } skip = 1; print ""; next }
/^[ \t]*-- @testhook end/   { if (!skip) { bad = "stray end"; exit } skip = 0; print ""; next }
{ print (skip ? "" : $0) }
END {
  if (!bad && skip) bad = "unclosed"
  if (bad) { print FILENAME ": " bad " @testhook marker" > "/dev/stderr"; exit 1 }
}
