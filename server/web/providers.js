// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
//
// The sign-in providers' marks, shared by the front door (play.html) and the dashboard's
// login (app.js). Copied verbatim from play/launcher.html's PROVIDER_ICONS, so every sign-in
// screen on a server looks like the launcher's. A classic script setting a global because
// app.js is a module and play.js is not; a page without this file still works, unbranded.
window.PROVIDER_ICONS = {
  google: '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.2 13.5 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.4 5.7C43.6 38 46.5 31.8 46.5 24.5z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C1 16.4 0 20.1 0 24s1 7.6 2.6 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.4 0-11.8-4-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/></svg>',
  discord: '<svg viewBox="0 0 24 24" fill="#5865F2"><path d="M20.3 4.5A19.8 19.8 0 0 0 15.4 3l-.3.5c1.8.4 3.3 1 4.7 1.9-1.7-.8-3.5-1.3-5.4-1.5a20.4 20.4 0 0 0-4.8 0c-1.9.2-3.7.7-5.4 1.5 1.4-.9 2.9-1.5 4.7-1.9L8.6 3A19.8 19.8 0 0 0 3.7 4.5C1.2 8.2.4 11.8.8 15.4a19.9 19.9 0 0 0 6 3l.8-1.3c-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12 0l.5.4c-.6.4-1.3.7-2 1l.8 1.3a19.9 19.9 0 0 0 6-3c.5-4.2-.8-7.8-2.4-10.9zM9 13.5c-1 0-1.7-.9-1.7-1.9S8 9.7 9 9.7s1.7.9 1.7 1.9S10 13.5 9 13.5zm6 0c-1 0-1.7-.9-1.7-1.9S14 9.7 15 9.7s1.7.9 1.7 1.9S16 13.5 15 13.5z"/></svg>',
  microsoft: '<svg viewBox="0 0 24 24"><path fill="#F25022" d="M1 1h10.5v10.5H1z"/><path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z"/><path fill="#00A4EF" d="M1 12.5h10.5V23H1z"/><path fill="#FFB900" d="M12.5 12.5H23V23H12.5z"/></svg>',
};
