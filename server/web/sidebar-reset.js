// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// Loaded by index.html ahead of the vendor scripts. A file, not an inline <script>: the
// dashboard's CSP is script-src 'self', so the inline copy was blocked on every load and
// never cleared anything.
//
// A COLLAPSED SIDEBAR FROM AN EARLIER VISIT IS NOT HONOURED. AdminLTE remembers the state in
// localStorage and re-applies it before anything else runs, so an operator who clicked the
// old toggle once would keep arriving to a stripe of unlabelled icons — with the button that
// caused it now gone. Cleared here, ahead of the vendor script, so there is nothing to
// restore. The CSS neutralises the class as well, for the breakpoint AdminLTE applies itself.
try {
  for (const k of Object.keys(localStorage)) if (/sidebar/i.test(k)) localStorage.removeItem(k);
} catch { /* private mode: nothing persisted to clear anyway */ }
