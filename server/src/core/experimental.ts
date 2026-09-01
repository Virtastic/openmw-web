// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which half-finished features the setup wizard is allowed to offer.
//
// Two of them, and they are the two that are genuinely rough.
//
// Multiplayer is a real addition rather than a port: Morrowind is a single-player game, and
// making it not one is where most of the sharp edges live.
//
// `playerUploads` is the delivery answer "everyone brings their own copy", which reads like the
// modest option and is the involved one. It means each player uploads their own Data Files to
// their own locker and streams the game from it: an upload wizard, a per-account library, a
// hash check against the vanilla manifest, and storage that grows with every player who joins.
// The other answer, the server publishing the operator's own library, is a static file route
// and much better travelled.
//
// Offering either beside answers that have been exercised for months invites somebody to build
// a campaign on one and find out afterwards.
//
// So they are SHOWN AND DISABLED rather than hidden. Hiding them would make the wizard read as
// though the feature does not exist, which is its own kind of lie, and an operator who came
// looking for multiplayer would conclude they had the wrong software. A greyed tile that names
// the variable that turns it on tells the truth: this exists, it is not finished, and here is
// how to say yes anyway.
//
// One variable, a comma-separated list, because these are the same decision made twice and
// two variables would be two things to document and two to forget:
//
//   OMW_EXPERIMENTAL=multiplayer
//   OMW_EXPERIMENTAL=multiplayer,playerUploads
//   OMW_EXPERIMENTAL=all
//
// Nothing here affects a server that is ALREADY configured. This gates what the wizard may
// offer, not what the engine may run: an operator who enabled multiplayer, ran a season on it,
// and then upgraded keeps their world. Turning a running feature off from an environment
// variable would be a far worse surprise than the one this prevents.

/** The gated features, by the name used in OMW_EXPERIMENTAL. */
export const EXPERIMENTS = ['multiplayer', 'playerUploads'] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

/** The variable an operator sets, named in the UI so the answer travels with the question. */
export const EXPERIMENTAL_ENV = 'OMW_EXPERIMENTAL';

/**
 * Parse the list. Unknown names are ignored rather than refused: a typo should not stop the
 * server booting, and a name from a future version arriving in an older one is not an error.
 *
 * Accepts the flag names in any case and with either separator people actually type, so
 * `playerUploads`, `playeruploads` and `player-uploads` all mean the same thing.
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
  return { multiplayer: on.has('multiplayer'), playerUploads: on.has('playerUploads') };
}
