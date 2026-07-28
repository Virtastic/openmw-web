# Legal posture, terms, and the storage-locker framework

This document is the operator-facing companion to the multiplayer plan's Phase 3.55. It
records **what we do, why, and what must never change without revisiting the decision**.
It is not legal advice, and §6 exists because it cannot be.

## 1. The line we stand on

Two behaviours have actual takedown history in this space:

1. **A host serving game data to browsers.** Take-Two DMCA'd DOS Zone's browser-playable
   GTA even though it carried disclaimers and required the user to own the original. The
   host's serving of the bytes was the infringing act; ownership-gating did not protect
   them.
2. **Paywalling access.** Skyrim Together drew a Bethesda C&D when its beta sat behind a
   Patreon tier. Multiplayer itself was never the trigger — TES3MP has run public servers
   for years untouched, as has OpenMW for fifteen.

Everything below follows from those two facts.

**Non-negotiable invariants:**

- We ship **no Bethesda assets**. The engine is a clean-room reimplementation (OpenMW);
  the player brings their own legally acquired game data.
- **Access is never paywalled.** Donations fund the open-source engine, generically.
  No tier may reference uploading, storing, or playing Morrowind data, and no tier may
  gate storage size, streaming, or entry to any world.
- The demo world ships **only** the OpenMW Example Suite (freely licensed content).

## 2. The storage locker

Players may upload their own game data so it streams back to them on any device. The legal
framing is a **private backup locker for files the user already owns**, and the product
mechanics must match that framing exactly — courts look at behaviour, not labels.

**Mechanics that are legal invariants, not implementation details:**

| Invariant | Why it is load-bearing |
|---|---|
| Per-account isolation | Each user's locker is theirs alone |
| **Zero dedup** | Dedup converts "their backup" into *our master copy*, which is the whole distinction |
| Encryption at rest | Ordinary custodial hygiene |
| Streaming only to the authenticated owner | No public URLs, no sharing, ever |
| Vanilla-manifest gate on upload | We accept only the retail files the user attests to owning — arbitrary uploads are refused by construction |
| Export + delete on demand | It is their backup; they can take it or purge it |

Relaxing any row above re-opens §1's first takedown pattern. Do not do it without redoing
the analysis in §6.

## 3. Terms of Service (click-through at account creation)

The ToS must state, in plain language:

1. The user **owns a legally acquired copy** of Morrowind (and any expansion they upload),
   and their uploads are **personal backup copies of their own files**.
2. Uploads are **private to the account**. The user grants only the limited licence needed
   to store the files and stream them back **to that same account** — no other use.
3. Prohibited use: sharing account credentials to distribute content; uploading files they
   do not own. Violation terminates the account.
4. No warranty of continued service; the user may **export or delete** their locker at any
   time.
5. Disclosure that an email address is stored for account and contact purposes, and
   processed by our CRM (see §5).

## 4. Upload attestation

At **upload time** — not buried in the ToS — an explicit, unchecked checkbox:

> These are my own backup copies of files from my legally purchased game.

The attestation is logged with timestamp, account, and manifest hash. That record is the
evidence trail; a ToS clause alone is not.

## 5. Privacy and the CRM

- The **email is contact data**, never an identifier in gameplay. It appears in no wire
  payload and on no peer-visible surface — only in the owner's own profile view. (Enforced
  in code and asserted by a test that scans a peer's entire message inbox.)
- SSO deliberately requests `openid profile` only and **never an email scope**; accounts key
  on `(issuer, subject)`. The email is typed by the user, not harvested from a provider.
- CRM (Attio) processing must be **disclosed in the privacy policy**, with a separate,
  **unchecked-by-default** marketing-consent checkbox.
- **Delete-my-data** purges the account, its character docs, the username index, and any
  queued CRM upserts (`--delete-account` covers all of these today).

## 6. DMCA §512 safe-harbour checklist

All four prongs, completed **before** the locker is reachable from the internet:

- [ ] **Register a DMCA agent** with the U.S. Copyright Office. (Cheap, online, and safe
      harbour does not exist without it.)
- [ ] Publish a **takedown policy** and a `dmca@` contact on the site.
- [ ] Adopt **and implement** a repeat-infringer termination policy in the ToS.
- [ ] Ensure **no direct financial benefit** attributable to stored content — see the
      monetization invariant in §1. This is the prong our own donation copy could most
      easily break.

**Attorney review is required, not optional.** The locker model has favourable precedent
contours (user-directed storage, per-user copies), but this is exactly the fact pattern
where a real IP attorney reviewing the ToS, the attestation flow, and the holding entity is
worth the fee. Schedule it before the feature leaves beta.

## 7. Mods

We redistribute a mod only with the **author's explicit permission**; their licence terms
are the operative right, and this community treats violating them as radioactive
regardless of legality. Where permission is granted, our CDN copy is additionally
download-gated behind a verified vanilla manifest.

Mods that are **derivative of Bethesda assets** (upscaled or repacked textures) stay
bring-your-own permanently: author permission does not clear §1's first pattern.

## 8. Takedown runbook

If a notice arrives:

1. **Comply first, argue later.** Take the named content down promptly; safe harbour
   depends on it.
2. Flip affected accounts to **client-side data mode** (feature-flagged). The game keeps
   working from the player's own disk — a locker takedown must never take down the game.
3. Preserve the attestation log and notice; then seek counsel.
4. If the notice targets the *engine* rather than hosted data, escalate to counsel before
   responding: that is a different and much weaker claim.
