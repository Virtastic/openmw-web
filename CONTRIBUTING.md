# Contributing

Thanks for your interest in openmw-web!

## Bugs & ideas

- **Bug reports** → [Issues](https://github.com/Virtastic/openmw-web/issues).
  Use the bug template — browser, GPU, and the URL/flags you ran with matter a
  lot here (this project is Chrome/Chromium-only by design).
- **Questions & discussion** → [Discussions](https://github.com/Virtastic/openmw-web/discussions).

## Pull requests

PRs are welcome. A few ground rules:

- The port is **desktop Chrome/Chromium-only**; changes to support other
  browsers are out of scope unless they carry zero risk to the Chrome path.
- Engine changes must be gated `#ifdef __EMSCRIPTEN__` (C++) or `#if @useGLES`
  (GLSL) so the desktop OpenMW code path stays byte-for-byte intact — see
  [`WASM_ADAPTATIONS.md`](WASM_ADAPTATIONS.md) for the house style.
- By contributing you agree your work is licensed under **GPL-3.0-or-later**
  like the rest of the project.
- Build instructions are in the [README](README.md). A PR that can't be built
  isn't dead on arrival — CI/deploy runs are maintainer-only, so a maintainer
  will build and test your change.
- The multiplayer server (`server/`) is TypeScript on Node and, unlike the
  engine, is quick to work on — no Emscripten toolchain needed:

  ```bash
  cd server && npm install && npx tsc --noEmit && npm test
  ```

  Changes there are expected to come with a test. The suite is fast and runs on
  plain `node --test`; anything touching authority, per-account isolation or the
  protocol needs one, because those are the places where a bug is a security
  bug rather than a glitch.

## What maintainers handle

Deployment (morrowind.virtastic.app), release publishing, and CI on the
self-hosted runner are maintainer-only for security reasons.

## New here? Quick start

You never need write access. Every change comes in through a pull request and is reviewed before it is merged.

1. **Fork** the repository on GitHub and clone your fork.
2. Create a branch: `git checkout -b my-change`.
3. Make one small, focused change and test it as described above.
4. Push the branch to your fork and open a **pull request** against `main`.
5. A maintainer reviews it. Requests for changes are normal; they are not a rejection.

**Finding something to work on:** look for issues labelled
[`good first issue`](https://github.com/Virtastic/openmw-web/labels/good%20first%20issue) or
[`help wanted`](https://github.com/Virtastic/openmw-web/labels/help%20wanted), and comment on the issue to claim it.
For anything bigger than a small fix, open an issue first so we can agree on the approach.

**Questions?** Ask in the [Discord](https://discord.gg/PzFfDkbSue). Security issues go through [SECURITY.md](SECURITY.md), not a public issue.
