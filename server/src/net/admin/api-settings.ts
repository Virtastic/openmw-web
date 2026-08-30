// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Settings: what the forms show, and what a save does.
//
// The field list is DERIVED from the loaded config object rather than hand-listed. A
// hand-written schema is a second copy of config.ts that drifts the first time someone adds
// a knob and forgets this file — and "every knob is reachable" is only true if it stays true
// automatically. Types come from the live values; help text is looked up by path and is
// optional, so a brand-new field appears in the UI on the day it is added, unlabelled but
// editable, instead of being invisible.

import { readDashboardTree, saveSection, saveTree, type Tree } from './settings-store';
import { SECTION_HELP, helpFor } from './help';

/** Sections grouped for the nav. Anything not listed still renders, under "Other". */
export const SECTION_GROUPS: { group: string; sections: string[]; note?: string }[] = [
  { group: 'Core', sections: ['server', 'login', 'content'] },
  { group: 'Gameplay', sections: ['rules', 'economy', 'sharing', 'time', 'cellReset', 'gui'] },
  { group: 'Access', sections: ['admin', 'auth', 'moderation', 'authority'] },
  { group: 'Storage', sections: ['locker'] },
  { group: 'Operations', sections: ['limits', 'metrics', 'integrations', 'dev'] },
  {
    group: 'Platform (advanced)',
    sections: ['simPeer', 'gateway', 'worlds'],
    note: 'Multi-world hosting. A single self-hosted server does not need any of this — ' +
      'these settings are read by the gateway supervisor, which most deployments never run.',
  },
];

// Values that are secrets. Never sent to the browser in full; a save that receives the mask
// back unchanged leaves the stored value alone, so "edit another field on this form" cannot
// silently blank a credential the operator never touched.
//
// PATTERN-BASED, NOT A LIST. The first version was an explicit set and it had already gone
// stale by the time anyone looked: [notifications].smtpPass (a real mail account password)
// and webhookUrl (a bearer capability — anyone holding a Slack or Discord webhook URL can
// post as it) were both absent, and both were readable in plaintext by the `viewer` role,
// the one the UI describes as "can look, and nothing else".
//
// A list fails closed only if someone remembers to extend it, which is the wrong default for
// this. The pattern matches the words credentials are actually named with, so the next one
// added is masked because of what it is called rather than because it was remembered.
const SECRET_RE = /pass|secret|token|apikey|webhook|credential/i;
// Fields whose name gives nothing away. Keep this short; prefer naming things clearly.
const SECRET_KEYS = new Set(['inviteCode']);
export const SECRET_MASK = '••••••••';

function isSecret(_section: string, key: string): boolean {
  return SECRET_RE.test(key) || SECRET_KEYS.has(key);
}

export interface FieldView {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'stringArray' | 'unsupported';
  value: unknown;
  secret?: boolean;
  /** True when this key is present in the dashboard's own override file. */
  overridden?: boolean;
  help?: string;
  danger?: string;
}

export interface SectionView {
  name: string;
  /** Human title. The raw name is a TOML table like [simPeer]; that is a fine identifier and
   *  a poor heading for someone who has never opened a TOML file. */
  label: string;
  help?: string;
  fields: FieldView[];
}

/** Titles for the settings sections. Anything unlisted falls back to its own name. */
const SECTION_LABEL: Record<string, string> = {
  server: 'Server identity',
  login: 'Player accounts',
  auth: 'Single sign-on',
  content: 'Game files',
  rules: 'Gameplay rules',
  economy: 'Loot and ownership',
  sharing: 'Shared progress',
  time: 'In-game time',
  gui: 'Dialogs',
  cellReset: 'Area resets',
  limits: 'Rate limits and anti-cheat',
  moderation: 'Chat logs and reports',
  admin: 'Administration',
  authority: 'Simulation handover',
  locker: 'Player file storage',
  metrics: 'Monitoring',
  integrations: 'Third-party integrations',
  dev: 'Development aids',
  notifications: 'Email and alerts',
  simPeer: 'World simulation',
  gateway: 'Multi-world gateway',
  worlds: 'Multi-world capacity',
  engine: 'Engine version',
};

function labelFor(name: string): string {
  if (SECTION_LABEL[name]) return SECTION_LABEL[name]!;
  const dot = name.indexOf('.');
  if (dot !== -1) {
    // auth.discord -> "Discord", which is what the operator recognises.
    const child = name.slice(dot + 1);
    return child.charAt(0).toUpperCase() + child.slice(1);
  }
  // camelCase -> spaced words, so an unlisted section is still readable.
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function fieldType(v: unknown): FieldView['type'] {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v) && v.every((e) => typeof e === 'string')) return 'stringArray';
  return 'unsupported';
}

export function settingsView(dataDir: string, config: unknown): {
  groups: typeof SECTION_GROUPS;
  sections: SectionView[];
  fallback: string | null;
} {
  const cfg = config as Record<string, unknown>;
  const overrides = readDashboardTree(dataDir);
  const sections: SectionView[] = [];

  for (const [name, body] of Object.entries(cfg)) {
    // `stated` is a Set the loader adds for its own bookkeeping, and dashboardFallback is
    // status rather than configuration. Neither is a knob.
    if (name === 'stated' || name === 'dashboardFallback') continue;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) continue;

    const over = (overrides[name] as Tree | undefined) ?? {};
    const fields: FieldView[] = [];
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const type = fieldType(value);
      const secret = isSecret(name, key);
      const h = helpFor(name, key);
      fields.push({
        key,
        type,
        // A nested table (e.g. [auth.discord]) is not editable as a flat field; it gets its
        // own section entry below rather than being silently dropped.
        value: secret ? (value === '' ? '' : SECRET_MASK) : value,
        ...(secret ? { secret: true } : {}),
        ...(Object.hasOwn(over, key) ? { overridden: true } : {}),
        ...(h?.text ? { help: h.text } : {}),
        ...(h?.danger ? { danger: h.danger } : {}),
      });
    }
    sections.push({ name, label: labelFor(name), ...(SECTION_HELP[name] ? { help: SECTION_HELP[name] } : {}), fields });

    // Nested tables become their own sections, e.g. auth.discord — so provider credentials
    // are editable instead of showing up as an "unsupported" blob.
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const nestedName = `${name}.${key}`;
      const nestedOver = ((overrides[name] as Tree | undefined)?.[key] as Tree | undefined) ?? {};
      sections.push({
        label: labelFor(nestedName),
        name: nestedName,
        fields: Object.entries(value as Record<string, unknown>).map(([k, v]) => {
          const secret = isSecret(key, k);
          return {
            key: k,
            type: fieldType(v),
            value: secret ? (v === '' ? '' : SECRET_MASK) : v,
            ...(secret ? { secret: true } : {}),
            ...(Object.hasOwn(nestedOver, k) ? { overridden: true } : {}),
          };
        }),
      });
    }
  }

  sections.sort((a, b) => a.name.localeCompare(b.name));
  return {
    groups: SECTION_GROUPS,
    sections,
    fallback: (cfg.dashboardFallback as string | undefined) ?? null,
  };
}

/**
 * Save one section.
 *
 * Values arrive as whatever JSON the form built and are written as they came. Types are NOT
 * coerced here and unknown keys are NOT rejected here — an earlier version of this comment
 * claimed both, and neither was true. What actually protects the file is checkDashboardTree
 * below: it runs the real validator over the merged result, which is a typed whitelist, so a
 * wrong type is refused with the validator's own message and a key nothing reads is inert.
 *
 * The regexes are the narrower guard: section and key names end up as TOML table and key
 * names, so they are restricted to a shape that cannot inject structure. They can only fire
 * on a malformed client, since the form sends back names it was given.
 */
export function applySection(
  dataDir: string,
  section: string,
  body: Record<string, unknown>,
  sharedDir?: string,
): { ok: true } | { ok: false; error: string } {
  if (!/^[a-zA-Z]+(\.[a-zA-Z]+)?$/.test(section)) {
    return { ok: false, error: `"${section}" is not a settings section. This looks like a bug — please report it.` };
  }

  const patch: Tree = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
      return { ok: false, error: `"${key}" is not a valid setting name. This looks like a bug — please report it.` };
    }
    // The mask coming back means "unchanged": leave whatever is stored alone.
    if (raw === SECRET_MASK) continue;
    patch[key] = raw;
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  // Nested section (auth.discord) writes into a nested table.
  const dot = section.indexOf('.');
  if (dot !== -1) {
    const parent = section.slice(0, dot);
    const child = section.slice(dot + 1);
    const current = readDashboardTree(dataDir);
    const parentTree = { ...((current[parent] as Tree | undefined) ?? {}) };
    parentTree[child] = { ...((parentTree[child] as Tree | undefined) ?? {}), ...patch };
    return saveTree(dataDir, { ...current, [parent]: parentTree }, sharedDir);
  }
  return saveSection(dataDir, section, patch, sharedDir);
}

// --- the onboarding wizard ------------------------------------------------------------------

export interface WizardAnswers {
  /** Step 2: what kind of deployment this is. Drives which later steps run at all. */
  deploymentMode?: 'single' | 'multiplayer';
  /** Step 3: which login methods players may use. */
  loginMethods?: string[];
  /** Step 4: extra dashboard accounts are created through the accounts API, not here. */
  owners?: string[];
  /** Step 5: which game content this server expects. */
  contentProfile?: 'morrowind' | 'expansions' | 'tamriel-rebuilt';
  /** Step 6: do players bring their own files, or does the server supply them? */
  deliveryModel?: 'verify' | 'serve';
  /** Step 7: reachable from the internet, or LAN only? */
  hosting?: 'public' | 'internal';
  domain?: string;
  /** Step 8 */
  serverName?: string;
  /** Step 9 */
  storage?: 'local' | 's3';
  s3?: { endpoint?: string; bucket?: string; region?: string };
  /** Marks the wizard as finished so the dashboard stops offering it as the landing page. */
  completed?: boolean;
}

/**
 * Translate wizard answers into config. This is the only place that knows a product-level
 * question ("is this public?") maps onto specific keys, which keeps that mapping in one
 * readable list instead of scattered across the page's JavaScript.
 */
export function applyWizard(
  dataDir: string,
  a: WizardAnswers,
  sharedDir?: string,
): { ok: true } | { ok: false; error: string } {
  const current = readDashboardTree(dataDir);
  const next: Tree = { ...current };
  const set = (section: string, key: string, value: unknown): void => {
    next[section] = { ...((next[section] as Tree | undefined) ?? {}), [key]: value };
  };
  const merge = (section: string, patch: Tree): void => {
    next[section] = { ...((next[section] as Tree | undefined) ?? {}), ...patch };
  };

  if (a.serverName !== undefined && a.serverName !== '') set('server', 'name', a.serverName);

  // The wizard's own bookkeeping, in its own section rather than bolted onto [admin]. These
  // were collected, echoed back on the review screen, and then dropped — so the content
  // profile silently reset to nothing on the next visit, and "have you run setup?" was a
  // per-browser localStorage flag that answered differently on every machine.
  if (a.contentProfile) set('setup', 'contentProfile', a.contentProfile);
  if (a.hosting) set('setup', 'hosting', a.hosting);
  if (a.completed) set('setup', 'completed', true);

  if (a.owners && a.owners.length > 0) {
    const existing = ((current.admin as Tree | undefined)?.owners as string[] | undefined) ?? [];
    set('admin', 'owners', [...new Set([...existing, ...a.owners])]);
  }

  if (a.deploymentMode === 'single') {
    // A private, one-person world: nobody else is going to register, and leaving signup open
    // on a box someone port-forwarded is the failure this default exists to prevent.
    merge('login', { allowRegistration: false });
  } else if (a.deploymentMode === 'multiplayer') {
    merge('login', { allowRegistration: true });
  }

  if (a.loginMethods) {
    const has = (m: string): boolean => a.loginMethods!.includes(m);
    merge('auth', {
      // Password stays available unless the operator picked only SSO providers. Locking it
      // off is a real choice, so it is only made when they actually made it.
      allowPasswordLogin: has('password'),
      requireSso: !has('password') && a.loginMethods.length > 0,
    });
    for (const p of ['discord', 'google', 'microsoft']) {
      const auth = (next.auth as Tree | undefined) ?? {};
      auth[p] = { ...((auth[p] as Tree | undefined) ?? {}), enabled: has(p) };
      next.auth = auth;
    }
  }

  if (a.deliveryModel === 'serve') {
    // The server is the source of truth for content, so the locker is how players get it.
    set('locker', 'acceptByNameAndSize', true);
  } else if (a.deliveryModel === 'verify') {
    set('content', 'enforce', 'names');
  }

  if (a.storage === 's3' && a.s3) {
    merge('locker', {
      ...(a.s3.endpoint ? { endpoint: a.s3.endpoint } : {}),
      ...(a.s3.bucket ? { bucket: a.s3.bucket } : {}),
      ...(a.s3.region ? { region: a.s3.region } : {}),
    });
  } else if (a.storage === 'local') {
    set('locker', 'endpoint', ''); // empty endpoint = this server's own disk
  }

  return saveTree(dataDir, next, sharedDir);
}
