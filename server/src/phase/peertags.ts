// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// OT3-206: THE PEER LOADS EVERY ACTIVE PHASE OF A CELL SIDE BY SIDE.
//
// A player sees the base cell plus the overlay for their phase key. The sim peer simulates one
// copy of each cell, so it gets the base AND every active overlay at once, with each ref that
// differs between them tagged with the phase keys it is present in (phasing-deep-dive #peer,
// "tagged variant refs in one cell"). The engine masks collision and AI by those tags
// (mwmp/phases.hpp). A ref no overlay mentions is untagged: present in every phase, exactly as
// today, so a cell with no active overlays produces a body identical to today's.
//
// Presence of ref r:
//   base:      in base.enabled, or (not in base.disabled and no overlay enables it -- an
//              overlay that turns r ON says r is off in the base, by content default)
//   phase K:   in K.enabled, or (not in K.disabled and present in base)
// r is tagged with every key it is present in ('base' for the base phase). Present in all of
// them: untagged. Present in none: stays disabled on the peer.

/** The base phase's key on the peer (a player whose phase for this cell is the base one). */
export const BASE_PHASE = 'base';

/** One phase's difference from the base cell: refKeys it turns on and off. */
export interface PhaseOverlay {
  enabled?: string[];
  disabled?: string[];
}

export interface PeerPhaseView {
  /** refKey -> the phase keys it is present in (sorted). Only refs that differ between phases. */
  phaseRefs: Record<string, string[]>;
  /** The cell's enabled/disabled lists with every tagged ref switched ON: the peer holds them all. */
  enabled: string[];
  disabled: string[];
}

export function peerPhaseView(base: { enabled: string[]; disabled: string[] },
  overlays: Record<string, PhaseOverlay> | undefined): PeerPhaseView | undefined {
  const keys = Object.keys(overlays ?? {}).filter((k) => k !== BASE_PHASE).sort();
  if (!overlays || keys.length === 0) return undefined;
  const baseOn = new Set(base.enabled);
  const baseOff = new Set(base.disabled);
  const on = new Map<string, Set<string>>();
  const off = new Map<string, Set<string>>();
  const touched = new Set<string>();
  const overlayOn = new Set<string>();
  for (const k of keys) {
    const o = overlays[k]!;
    on.set(k, new Set(o.enabled ?? []));
    off.set(k, new Set(o.disabled ?? []));
    for (const r of o.enabled ?? []) { touched.add(r); overlayOn.add(r); }
    for (const r of o.disabled ?? []) touched.add(r);
  }
  const phaseRefs: Record<string, string[]> = {};
  const nowOn: string[] = [];
  const nowOff = new Set<string>();
  for (const r of [...touched].sort()) {
    const inBase = baseOn.has(r) || (!baseOff.has(r) && !overlayOn.has(r));
    const present: string[] = inBase ? [BASE_PHASE] : [];
    for (const k of keys) {
      if (on.get(k)!.has(r) || (!off.get(k)!.has(r) && inBase)) present.push(k);
    }
    if (present.length === keys.length + 1) continue; // in every phase: a base ref
    if (present.length === 0) { nowOff.add(r); continue; }
    phaseRefs[r] = present.sort();
    nowOn.push(r);
  }
  const tagged = new Set(nowOn);
  return {
    phaseRefs,
    enabled: [...new Set([...base.enabled.filter((r) => !nowOff.has(r)), ...nowOn])],
    disabled: [...new Set([...base.disabled.filter((r) => !tagged.has(r)), ...nowOff])],
  };
}
