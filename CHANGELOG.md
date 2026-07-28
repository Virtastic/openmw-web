# Changelog

All notable changes to openmw-web are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-07-27

A bug-fix release. Everything here affects displays with **fractional** scaling,
which in practice means Windows machines set to 125%, 150%, or 175% (the Windows
defaults), and anyone using browser zoom. Displays at 100% and Retina Macs were
never affected and are unchanged by this release.

### Fixed

- **The mouse cursor and your clicks now line up.** On Windows display scaling,
  clicks landed away from where the pointer was drawn, and the error grew the
  further you moved from the top-left corner. The mouse position was converted
  between coordinate spaces with integer division, which silently discarded a
  fractional scaling factor, so the pointer you saw (drawn by the browser) and
  the position the game used had drifted apart.

- **The game no longer renders far more pixels than it was asked to.** On a
  125% display the engine was rendering 1.56x the intended pixel count, and at
  150% it was 2.25x. This cost framerate for no visual benefit. Windows HiDPI
  users should see a straightforward performance improvement.

- **Menus and HUD are the correct size** on fractionally-scaled displays. The
  interface was being laid out against the wrong screen ratio and drawn smaller
  than intended.

- **Camera look sensitivity is correct** on those same displays. Mouse-look was
  scaled by the same faulty factor.

- **Mouse-wheel events no longer report a doubled cursor position.** A latent
  bug that could not show up while the scaling factor was 1.

- **Zooming the browser below 100% no longer risks a divide-by-zero** in the
  window-sizing and input paths.

### Notes

Verified across device pixel ratios 1.0, 1.25, 1.5, 1.75 and 2.0: the drawing
buffer now matches the requested render size at every step, and the interface
scale matches the true buffer-to-CSS ratio. Integer ratios produce numerically
identical results to 1.0.0, so Retina and 100% displays are untouched.

## [1.0.0] - 2026-07-19

First public release. The OpenMW engine cross-compiled to WebAssembly and
playable in a desktop browser.

- Play the freely-distributable OpenMW example world with no game data required.
- Bring your own legally-obtained Morrowind `Data Files` folder, streamed from
  disk on demand via the File System Access API with no upload or copy.
- Saves on the bring-your-own path are written to a real `openmw-web-saves`
  folder on disk; settings, keybindings and saves otherwise persist in the
  browser.
- Tribunal, Bloodmoon and loose mod `.esp`/`.esm`/`.bsa` files are detected and
  loaded automatically.
- Resolution scaling (Full / High / Half / Third / Quarter) renders the 3D scene
  at a fraction of native while keeping menus and text crisp.
- Self-host bundle and GPLv3 Complete Corresponding Source published with the
  release.

[1.0.1]: https://github.com/Virtastic/openmw-web/releases/tag/v1.0.1
[1.0.0]: https://github.com/Virtastic/openmw-web/releases/tag/v1.0.0
