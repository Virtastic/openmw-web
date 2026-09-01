// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Which half-finished features the setup wizard is allowed to offer.
//
// Morrowind is a single-player game. Multiplayer is a real addition rather than a port, and
// serving somebody else's game files or holding them in a bucket are both new enough to have
// surprised us in ways a first-time operator should not have to discover. Offering them as
// ordinary choices, beside answers that have been exercised for months, invites somebody to
// build a campaign on one and find out later.
//
// So they are SHOWN AND DISABLED rather than hidden. Hiding them would make the wizard read as
// though the feature does not exist, which is its own kind of lie, and an operator who came
// looking for multiplayer would conclude they had the wrong software. A greyed tile that names
// the variable that turns it on tells the truth: this exists, it is not finished, and here is
// how to say yes anyway.
//
// One variable, a comma-separated list, because these are the same decision made three times
// and three variables would be three things to document and three to forget:
//
//   OMW_EXPERIMENTAL=multiplayer
//   OMW_EXPERIMENTAL=multiplayer,s3
//   OMW_EXPERIMENTAL=all
//
// Nothing here affects a server that is ALREADY configured. This gates what the wizard may
// offer, not what the engine may run: an operator who enabled multiplayer, ran a season on it,
// and then upgraded keeps their world. Turning a running feature off from an environment
// variable would be a far worse surprise than the one this prevents.

/** The gated features, by the name used in OMW_EXPERIMENTAL. */
export const EXPERIMENTS = ['multiplayer', 'serveFiles', 's3'] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

/** The variable an operator sets, named in the UI so the answer travels with the question. */
export const EXPERIMENTAL_ENV = 'OMW_EXPERIMENTAL';

/**
 * Parse the list. Unknown names are ignored rather than refused: a typo should not stop the
 * server booting, and a name from a future version arriving in an older one is not an error.
 *
 * Accepts the flag names in any case and with either separator people actually type, so
 * `serveFiles`, `servefiles` and `serve-files` all mean the same thing.
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
  return { multiplayer: on.has('multiplayer'), serveFiles: on.has('serveFiles'), s3: on.has('s3') };
}
