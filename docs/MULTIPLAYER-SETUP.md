# Multiplayer setup: SSO + storage locker

Multiplayer is **SSO-only** (no account/password) and **locker-only** (game data streams
from your own S3-compatible bucket, never a local folder). This guide covers the three
things only you can provision, then the config that turns it all on. Everything else is
already built and tested.

The two credentials below are the only blockers — I cannot create a Google OAuth app or an
S3 bucket for you.

---

## 1. Google OAuth app (≈5 minutes)

1. Go to <https://console.cloud.google.com/> → create a project (or pick one).
2. **APIs & Services → OAuth consent screen** → External → fill the app name + your email
   → Save. You do **not** need to submit for verification for personal/testing use; add
   your own Google account under **Test users**.
   - Scopes: leave default. We request only `openid profile` — **never** an email scope.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI (exactly, no trailing slash):
     - Local test: `http://127.0.0.1:8080/auth/google/callback`
     - Production: `https://YOUR-SERVER-HOST/auth/google/callback`
4. Copy the **Client ID** and **Client secret**.

You now have `clientId` + `clientSecret` for the config below.

> Discord and Microsoft work identically (`[auth.discord]`, `[auth.microsoft]`); their
> redirect URIs use `/auth/discord/callback` etc. Google is the example throughout.

---

## 2. S3-compatible bucket (Cloudflare R2 recommended — no egress fees)

Any S3 API works (AWS S3, Cloudflare R2, Backblaze B2, MinIO). **R2 is the best fit** — no
per-GB egress charge, which matters because players stream their data every session.

**Cloudflare R2:**

1. Cloudflare dashboard → **R2 → Create bucket** (e.g. `omw-lockers`). Note your **Account
   ID** (top of the R2 page).
2. **R2 → Manage R2 API Tokens → Create API Token**:
   - Permissions: **Object Read & Write**
   - Bucket: the one you made
   - Create → copy the **Access Key ID** and **Secret Access Key** (shown once).
3. Your endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`.
4. **CORS** (so the browser can PUT/GET directly). In the bucket → Settings → CORS policy:
   ```json
   [{
     "AllowedOrigins": ["http://127.0.0.1:8910", "https://YOUR-GAME-HOST"],
     "AllowedMethods": ["GET", "PUT"],
     "AllowedHeaders": ["*"],
     "ExposeHeaders": ["Content-Range", "Content-Length"]
   }]
   ```
   `Content-Range` must be exposed — the game streams via HTTP Range requests.

**AWS S3** is the same shape: bucket + an IAM user with `s3:GetObject`/`s3:PutObject`/
`s3:ListBucket`/`s3:DeleteObject` on `arn:aws:s3:::your-bucket/*`, endpoint
`https://s3.<region>.amazonaws.com`, real region, plus the same CORS rule on the bucket.

---

## 3. The vanilla-manifest (so the locker accepts your retail files)

The locker only accepts recognized game files — that is what keeps it a backup locker and
not general file hosting. Generate the manifest from your own legal copy:

```bash
node server/tools/gen-vanilla-manifest.mjs "/path/to/Morrowind/Data Files" \
     --out server/devdata/vanilla-manifest.json
```

Then place `vanilla-manifest.json` in the server's **shared dir** (`--shared`, or `--data`
for a single-world server). Until it exists the locker refuses every upload — the safe
default.

**Different distributions still connect.** Steam, GOG, disc, and localized copies of
`Morrowind.esm`/`.bsa` differ byte-for-byte, so an exact-hash gate built from *your* copy
would reject a friend's legitimate copy from a different store. So the locker accepts a
file when either its exact sha256 is known **or** its filename matches a manifest entry and
its size is within ±5% (a movie renamed to `Morrowind.esm` is nowhere near ~79.8MB, so it
is still refused). A newly-seen legit copy is logged (`locker.accepted_new_copy`) and its
hash remembered. To require exact hashes only, set `acceptByNameAndSize = false` under
`[locker]` in the config.

> The multiplayer content gate is name-based, so same-named files from different stores play
> together fine; only genuinely different *records* (e.g. a different language ESM) would
> desync, which is inherent to any content-sync system.

---

## 4. Config — turn it on

In your server's `config.toml` (in the data dir):

```toml
[auth]
requireSso  = true                                   # MP is SSO-only
returnUrl   = "http://127.0.0.1:8910/launcher.html"  # your game/launcher URL

[auth.google]
enabled      = true
clientId     = "…apps.googleusercontent.com"
clientSecret = "…"
redirectUri  = "http://127.0.0.1:8080/auth/google/callback"

[locker]
endpoint = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
region   = "auto"
bucket   = "omw-lockers"
```

S3 keys go in the **environment**, not the config file:

```bash
export S3_ACCESS_KEY_ID=…
export S3_SECRET_ACCESS_KEY=…
node server/dist/server.mjs --data /path/to/data --port 8080
```

Sanity checks once it's running:

```bash
curl -s localhost:8080/auth/providers      # -> {"providers":["google"],"allowPasswordLogin":false,…}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/locker/files   # 401 (needs a token), NOT 503
```

`503` from `/locker/files` means the locker is disabled — endpoint or S3 keys are missing.

---

## 5. Play

Open the launcher → **Multiplayer** card → enter the server address → it sends you through
Google → back to the game. First time, it asks for your Data Files folder once, hashes and
uploads them to your locker, then streams them back. After that, any device: sign in, and
your data (and your character) are already there.

For a two-player local test, use two browser profiles (each is one account).

---

## Production notes

- **HTTPS is required in production** for both hosts — OAuth redirect URIs and the locker's
  cross-origin fetches need it, and the SSO ticket is a credential.
- Rotate the R2 token if it ever leaks; the game keys are per-session and short-lived.
- `docs/LEGAL.md` covers the DMCA-agent registration and the storage-locker invariants that
  must not be relaxed. The one code-independent launch action is registering the agent.
