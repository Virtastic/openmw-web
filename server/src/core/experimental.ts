// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which half-finished features the setup wizard is allowed to offer.
//
// One of them: multiplayer. Morrowind is a single-player game, and making it not one is
// where most of the sharp edges live; offering it beside answers that have been exercised
// for months invites somebody to build a campaign on it and find out afterwards.
//
// (A second flag, playerUploads, briefly gated the delivery answer where each player uploads
// their own copy of the game to a per-account locker here. That question is gone from the
// dashboard entirely now — the server always supplies the game files, and personal cloud
// copies are the game launcher's own feature — so the flag went with it.)
//
// So they are SHOWN AND DISABLED rather than hidden. Hiding them would make the wizard read as
// though the feature does not exist, which is its own kind of lie, and an operator who came
// looking for multiplayer would conclude they had the wrong software. A greyed tile that names
// the variable that turns it on tells the truth: this exists, it is not finished, and here is
// how to say yes anyway.
//
// One variable, a comma-separated list, so a second experiment some day is a new name rather
// than a new variable:
//
//   OMW_EXPERIMENTAL=multiplayer
//   OMW_EXPERIMENTAL=all
//
// Nothing here affects a server that is ALREADY configured. This gates what the wizard may
// offer, not what the engine may run: an operator who enabled multiplayer, ran a season on it,
// and then upgraded keeps their world. Turning a running feature off from an environment
// variable would be a far worse surprise than the one this prevents.

/** The gated features, by the name used in OMW_EXPERIMENTAL. */
export const EXPERIMENTS = ['multiplayer'] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

/** The variable an operator sets, named in the UI so the answer travels with the question. */
export const EXPERIMENTAL_ENV = 'OMW_EXPERIMENTAL';

/**
 * Parse the list. Unknown names are ignored rather than refused: a typo should not stop the
 * server booting, and a name from a future version arriving in an older one is not an error.
 *
 * Accepts the flag names in any case and with either separator people actually type
 * (underscores and dashes are stripped before matching).
 */
export function parseExperimental(raw: string | undefined): Set<Experiment> {
  const out = new Set<Experiment>();
  const want = String(raw ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/[-_]/g, ''))
    .filter(Boolean);
  for (const name of EXPERIMENTS) {
    if (want.includes('all') || want.includes(name.toLowerCase())) out.add(name);
  }
  return out;
}

/**
 * Read once, at the point of use.
 *
 * Not cached in a module-level constant: the test suite sets the variable per case, and a
 * value frozen at import time would make the first test to run decide for all of them.
 */
export function experimental(): Record<Experiment, boolean> {
  const on = parseExperimental(process.env[EXPERIMENTAL_ENV]);
  return { multiplayer: on.has('multiplayer') };
}
