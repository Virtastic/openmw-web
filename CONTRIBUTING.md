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

## What maintainers handle

Deployment (morrowind.virtastic.app), release publishing, and CI on the
self-hosted runner are maintainer-only for security reasons.
