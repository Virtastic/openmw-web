// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// Settings: what the forms show, and what a save does.
//
// The field list is DERIVED from the loaded config object rather than hand-listed. A
// hand-written schema is a second copy of config.ts that drifts the first time someone adds
// a knob and forgets this file, and "every knob is reachable" is only true if it stays true
// automatically. Types come from the live values; help text is looked up by path and is
// optional, so a brand-new field appears in the UI on the day it is added, unlabelled but
// editable, instead of being invisible.

import { readDashboardTree, saveSection, saveTree, type Tree } from './settings-store';
import { SECTION_HELP, helpFor } from './help';
import { normaliseDomain } from './setup-check';

/** Sections grouped for the nav. Anything not listed still renders, under "Other". */
export const SECTION_GROUPS: { group: string; sections: string[]; note?: string }[] = [
  { group: 'Core', sections: ['setup', 'server', 'login', 'content'] },
  { group: 'Gameplay', sections: ['rules', 'economy', 'sharing', 'time', 'cellReset', 'gui'] },
  { group: 'Access', sections: ['admin', 'auth', 'moderation', 'authority'] },
  { group: 'Storage', sections: ['locker'] },
  { group: 'Operations', sections: ['limits', 'metrics', 'notifications', 'integrations', 'dev'] },
  {
    group: 'Platform (advanced)',
    sections: ['simPeer', 'gateway', 'worlds'],
    note: 'Multi-world hosting. A single self-hosted server does not need any of this, ' +
      'these settings are read by the gateway supervisor, which most deployments never run. ' +
      'Note that this dashboard is not available while the gateway is running: it administers ' +
      'a world, and the gateway does not have one of its own.',
  },
];

/**
 * Sections that cannot do anything in a single-player deployment.
 *
 * The test is structural, not stylistic: in single player the browser runs the engine and the
 * server keeps accounts, a locker and (when the operator asked it to) a copy of the game
 * files. It simulates no world and there is no second person, so every setting below is read
 * by something that never runs here.
 *
 *   rules, economy, time, gui, cellReset   the server's own world simulation, which does not exist
 *   sharing, moderation                    two or more people, one of whom needs moderating
 *   authority                              handing cell ownership between peers; there is one peer
 *   content, engine                        checks run against a client as it JOINS; nobody joins
 *   simPeer, gateway, worlds               the headless engine and the multi-world supervisor
 *
 * Deliberately NOT hidden: [admin] carries the dashboard's own owners and token, [limits]
 * still rate-limits sign-in, [locker] is how the one player gets their files, and
 * [login]/[auth] are how they sign in. A section that does part of its job here stays.
 *
 * Hidden, never deleted: the values stay in the file untouched, so switching a server to
 * multiplayer later brings them all back exactly as they were.
 */
export const MULTIPLAYER_ONLY = [
  'rules', 'economy', 'time', 'gui', 'cellReset',
  'sharing', 'moderation', 'authority',
  'content', 'engine',
  'simPeer', 'gateway', 'worlds',
];

/**
 * Individual fields hidden in single player, for a DIFFERENT reason than the sections above.
 *
 * Those are hidden because they do nothing here. This one works perfectly well: the admin API
 * is real in single player and a token would authenticate against it. It is hidden because
 * there is no plausible use for it — it exists so a cron job can drive the API of a server
 * with players on it — and because leaving a standing credential on screen invites somebody
 * to fill it in. A field whose only outcomes are "empty" or "a moderator credential you did
 * not need" is not a choice worth offering one person running their own game.
 *
 * Hidden, never cleared: an existing value keeps working and comes back if the deployment
 * ever becomes multiplayer.
 */
export const SOLO_HIDE_FIELDS = ['admin.dashboardToken'];

/**
 * Fields the SERVER works out, which an operator must therefore not be asked for.
 *
 * locker.publicBase is the origin a browser reaches this server on. The wizard already asked
 * for the domain, generated the proxy config from it and issued a certificate for it, so
 * asking again — in a different format, on a settings page, under a name that does not
 * mention domains — is asking somebody to restate a fact the server acted on ten minutes
 * ago. Every wrong answer is silent: uploads and savegames mint URLs pointing somewhere the
 * browser cannot reach, and nothing says so until a transfer fails.
 *
 * Derived at boot instead (see server.ts). A value already in config.toml still wins, so a
 * hand-tuned deployment behind an unusual proxy keeps working; it simply is not offered as a
 * question to anyone who has not already answered it.
 */
export const DERIVED_FIELDS = [
  'locker.publicBase',
  // [setup] is the wizard's record of the answers, and only SOME of it is live configuration.
  //
  // domain, hosting, deploymentMode, deliveryModel and contentProfile are read at runtime:
  // they decide the proxy config, whether the server publishes its game files, which boot
  // mode the front door hands the player, and what the file checklist expects. Those are real
  // settings and are offered below.
  //
  // The rest are a RECORD of an answer whose effect was written somewhere else at the time.
  // storage chose between filesystem and S3, but the live knobs are [locker] endpoint and
  // bucket. loginMethods and registration set [auth] and [login]. Editing the record now
  // would change nothing at all while looking exactly like it had, which is worse than not
  // offering it — the real knobs are on this same page, one section away.
  'setup.storage', 'setup.loginMethods', 'setup.registration',
  // Clearing this reopens the first-run gate over a configured server, which is a lockout
  // dressed as a checkbox.
  'setup.completed',
];

// Values that are secrets. Never sent to the browser in full; a save that receives the mask
// back unchanged leaves the stored value alone, so "edit another field on this form" cannot
// silently blank a credential the operator never touched.
//
// PATTERN-BASED, NOT A LIST. The first version was an explicit set and it had already gone
// stale by the time anyone looked: [notifications].smtpPass (a real mail account password)
// and webhookUrl (a bearer capability, anyone holding a Slack or Discord webhook URL can
// post as it) were both absent, and both were readable in plaintext by the `viewer` role,
// the one the UI describes as "can look, and nothing else".
//
// A list fails closed only if someone remembers to extend it, which is the wrong default for
// this. The pattern matches the words credentials are actually named with, so the next one
// added is masked because of what it is called rather than because it was remembered.
const SECRET_RE = /pass|secret|token|apikey|webhook|credential|accesskey/i;
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
  setup: 'Deployment',
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
  multiplayerOnly: string[];
} {
  const cfg = config as Record<string, unknown>;
  const overrides = readDashboardTree(dataDir);
  const sections: SectionView[] = [];
  const soloMode = (cfg.setup as { deploymentMode?: string } | undefined)?.deploymentMode === 'single';

  for (const [name, body] of Object.entries(cfg)) {
    // `stated` is a Set the loader adds for its own bookkeeping, and dashboardFallback is
    // status rather than configuration. Neither is a knob.
    //
    // [setup] used to be skipped here too, on the grounds that the wizard owned it. The
    // wizard is now first-run only, so skipping it left the domain — and the mode, and
    // whether the server hands out its game files — editable by nothing at all. The Help page
    // still said "set it in Setup", pointing at a page that no longer opens. The live parts of
    // it are settings like any other; the parts that are only a record of an answer are held
    // back in DERIVED_FIELDS above.
    if (name === 'stated' || name === 'dashboardFallback') continue;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) continue;

    const over = (overrides[name] as Tree | undefined) ?? {};
    const fields: FieldView[] = [];
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      // A nested table ([auth.discord]) gets its own editable section in the loop below, so
      // it must NOT also appear here. It did both: the parent listed discord, google and
      // microsoft as "structured data a simple form cannot edit", directly above the three
      // forms that edit them. The row was not just redundant, it told the operator the
      // opposite of what the next panel proved.
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) continue;
      // Fields the operator is not asked for: derived by the server, or pointless in a
      // one-person deployment. Filtered HERE rather than in the page, because the server
      // already knows both facts and a field that is never sent cannot be saved by accident.
      const path = `${name}.${key}`;
      if (DERIVED_FIELDS.includes(path)) continue;
      if (soloMode && SOLO_HIDE_FIELDS.includes(path)) continue;
      const type = fieldType(value);
      const secret = isSecret(name, key);
      const h = helpFor(name, key);
      fields.push({
        key,
        type,
        value: secret ? (value === '' ? '' : SECRET_MASK) : value,
        ...(secret ? { secret: true } : {}),
        ...(Object.hasOwn(over, key) ? { overridden: true } : {}),
        ...(h?.text ? { help: h.text } : {}),
        ...(h?.danger ? { danger: h.danger } : {}),
      });
    }
    sections.push({ name, label: labelFor(name), ...(SECTION_HELP[name] ? { help: SECTION_HELP[name] } : {}), fields });

    // Nested tables become their own sections, e.g. auth.discord, so provider credentials
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
    // Sent rather than duplicated in the page: which sections need a world is a fact about
    // the config, and it belongs next to the grouping that already lives here.
    multiplayerOnly: MULTIPLAYER_ONLY,
  };
}

/**
 * Save one section.
 *
 * Values arrive as whatever JSON the form built and are written as they came. Types are NOT
 * coerced here and unknown keys are NOT rejected here, an earlier version of this comment
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
    return { ok: false, error: `"${section}" is not a settings section. This looks like a bug, please report it.` };
  }

  const patch: Tree = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
      return { ok: false, error: `"${key}" is not a valid setting name. This looks like a bug, please report it.` };
    }
    // The mask coming back means "unchanged": leave whatever is stored alone.
    if (raw === SECRET_MASK) continue;
    // People paste "https://mp.example.com/" out of the address bar, because that is where a
    // domain lives as far as they are concerned. The wizard normalises on the way in and this
    // path has to as well, or a scheme reaches the proxy config and the site address becomes
    // https://https://mp.example.com.
    if (section === 'setup' && key === 'domain' && typeof raw === 'string') {
      patch[key] = normaliseDomain(raw);
      continue;
    }
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
  /** Which login methods players may use. */
  loginMethods?: string[];
  /** Who may create an account. Independent of deploymentMode. */
  registration?: 'open' | 'invite' | 'closed';
  inviteCode?: string;
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
  s3?: { endpoint?: string; bucket?: string; region?: string; accessKeyId?: string; secretAccessKey?: string };
  /** Step 3's inline credential sub-forms: clientId/clientSecret per ticked provider, plus
   *  the redirect URI the browser derived from its own origin. */
  ssoCreds?: Record<string, { clientId?: string; clientSecret?: string; redirectUri?: string }>;
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
  // were collected, echoed back on the review screen, and then dropped, so the content
  // profile silently reset to nothing on the next visit, and "have you run setup?" was a
  // per-browser localStorage flag that answered differently on every machine.
  if (a.contentProfile) set('setup', 'contentProfile', a.contentProfile);
  if (a.hosting) set('setup', 'hosting', a.hosting);
  // The domain is what the proxy config is rendered from, so an internal-only server
  // explicitly clears it rather than keeping a stale name that would still be served.
  if (a.hosting === 'internal') set('setup', 'domain', '');
  else if (a.domain !== undefined) set('setup', 'domain', normaliseDomain(a.domain));
  // The pivot answers, ALL of them. An earlier version kept only two, which meant the
  // dashboard could never branch on "is this single player?" and re-running the wizard
  // presented every question blank, the two complaints that forced this rewrite.
  if (a.deploymentMode) set('setup', 'deploymentMode', a.deploymentMode);
  if (a.deliveryModel) set('setup', 'deliveryModel', a.deliveryModel);
  if (a.storage) set('setup', 'storage', a.storage);
  if (a.loginMethods) set('setup', 'loginMethods', a.loginMethods.filter((m) => typeof m === 'string'));
  if (a.registration) set('setup', 'registration', a.registration);
  if (a.completed) set('setup', 'completed', true);

  if (a.owners && a.owners.length > 0) {
    const existing = ((current.admin as Tree | undefined)?.owners as string[] | undefined) ?? [];
    set('admin', 'owners', [...new Set([...existing, ...a.owners])]);
  }

  // WHO MAY SIGN UP IS ITS OWN ANSWER, not a side effect of the deployment mode. Deriving it
  // meant choosing "single player" silently closed registration, a decision the operator
  // never made and could not see, on a server other people may well be playing on.
  if (a.registration === 'open') {
    merge('login', { allowRegistration: true, inviteCode: '' });
  } else if (a.registration === 'invite') {
    merge('login', { allowRegistration: true, inviteCode: a.inviteCode ?? '' });
  } else if (a.registration === 'closed') {
    merge('login', { allowRegistration: false, inviteCode: '' });
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
      // Credentials typed into the wizard land here too, the step that asks "which
      // providers?" is the step that takes their keys, not a pointer at a settings page.
      const creds = a.ssoCreds?.[p] ?? {};
      auth[p] = {
        ...((auth[p] as Tree | undefined) ?? {}),
        enabled: has(p),
        ...(creds.clientId ? { clientId: String(creds.clientId) } : {}),
        ...(creds.clientSecret ? { clientSecret: String(creds.clientSecret) } : {}),
        ...(creds.redirectUri ? { redirectUri: String(creds.redirectUri) } : {}),
      };
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
      // The keys, asked for in the browser like everything else. They used to be the one
      // thing the wizard collected an endpoint for and then refused to finish, sending the
      // operator to set environment variables in a file the dashboard cannot reach.
      ...(a.s3.accessKeyId ? { accessKeyId: a.s3.accessKeyId } : {}),
      ...(a.s3.secretAccessKey ? { secretAccessKey: a.s3.secretAccessKey } : {}),
    });
  } else if (a.storage === 'local') {
    set('locker', 'endpoint', ''); // empty endpoint = this server's own disk
  }

  return saveTree(dataDir, next, sharedDir);
}
