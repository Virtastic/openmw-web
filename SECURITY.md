# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"), or email
**security@virtastic.app**.

We'll acknowledge within a few days. Please include steps to reproduce and,
if relevant, the browser/GPU involved.

## Scope

- The web front-end (`play/`), the WASM engine build, and the release
  artifacts are in scope.
- The multiplayer server (`server/`) is in scope, and it is where the
  interesting surface is: SSO sign-in and session handling, the world gateway,
  the storage locker and savegames (per-account isolation, quota, path
  handling), the client→server protocol, and the authority model — anything a
  modified client can make the server believe. Findings that let one account
  reach another's data, or let a client author world state it should not be
  able to, are the ones we most want to hear about.
- The hosted instance at morrowind.virtastic.app is in scope for
  responsible disclosure (no automated scanning / load testing, please).
- Upstream OpenMW engine issues that are not specific to this port should go
  to the [OpenMW project](https://gitlab.com/OpenMW/openmw/-/issues).
