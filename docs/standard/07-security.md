# 07 · Security

The platform runs on someone's NAS or laptop and is often port-forwarded so a phone can run the
show from anywhere. Internet scanners will find it within hours. This document is what makes
that safe.

## 7.1 Threat model

| Asset | Threat | Primary control |
|---|---|---|
| Platform OAuth tokens & API keys | Theft → hijacked channel | Encryption at rest (§7.7); never sent to browsers or templates |
| Admin access | Credential stuffing, session theft | Strong hashing, rate limits, 2FA, secure cookies |
| Live broadcast | Someone takes scenes or posts a fake alert on air | Roles; CSRF; scoped tokens |
| Overlay pages | Data scraping, URL leakage | Per-overlay read-only keys, rotatable |
| The host | Crafted uploads, path traversal, crashing requests | Input validation, sandboxed media processing, crash isolation |
| Operators | Malicious template | CSP sandbox (04 §4.8); templates never hold secrets |

## 7.2 First-run setup

There are **no default credentials**, ever.

- On first start with no owner account, the platform prints a one-time **setup code** to its
  log (and, on desktop, shows it in the app window).
- `POST /api/v1/setup` requires that code and creates the owner. The code expires after 1 hour
  or first use; a restart issues a new one.
- In `public` exposure mode the setup endpoint **MUST** additionally refuse requests that do not
  come from a loopback or private address, so an exposed fresh install cannot be claimed by a
  stranger who finds it first.

## 7.3 Passwords and sessions

**Hashing.** Passwords **MUST** be hashed with a memory-hard KDF:
- **scrypt** — N = 2¹⁷, r = 8, p = 1, 16-byte random salt, 32-byte output (available in the
  Node.js standard library, keeping the core dependency-free); or
- **Argon2id** — m = 19 MiB, t = 2, p = 1, where the runtime provides it without an added
  dependency (README decision 8).

**One hash at a time.** scrypt at these parameters needs 128 MiB of working memory per call
(`128 × N × r` bytes). The platform **MUST** run password hashing serially, in one queue for
logins, password changes and setup, and answer `429` with `Retry-After` when more than 10
requests are waiting. A burst of logins then can't exhaust memory on a small device (10 §10.2).
In Node.js, pass `maxmem` above 128 MiB (160 MiB, say): the default limit of 32 MiB makes the
call throw.

Store `alg$params$salt$hash` so parameters can be raised later; rehash on next login when they
change. Minimum length 12, maximum 256; check against a bundled list of common passwords; no
composition rules.

**Sessions.**
- Session IDs: 256 bits from a CSPRNG. Store only their SHA-256 server-side.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`. Over HTTPS: `Secure` and the `__Host-` name
  prefix (`__Host-skp_session`). Over plain HTTP on a LAN: `skp_session` without `Secure`.
- Idle timeout 12 h; absolute lifetime 30 days ("keep me signed in") or 24 h otherwise.
- Rotate the session ID on login and on any privilege change. Invalidate all of a user's
  sessions on password change, 2FA change or role change.
- Users can see and revoke their active sessions (device, IP, last seen).

**CSRF.** State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) authenticated by cookie
**MUST** carry `X-SKP-CSRF` equal to the session's CSRF token (from `GET /auth/session`), and
the `Origin` header, when present, **MUST** match the platform's origin. Token-authenticated
requests are exempt.

**Login protection.** 10 failed attempts per account or per IP within 15 minutes triggers an
exponential delay (1 s → 2 s → … → 15 min). Error messages never reveal whether the account
exists. Failed and successful logins go to the audit log.

## 7.4 Two-factor authentication

TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) with 10 single-use recovery codes stored hashed.
In `public` mode 2FA **SHOULD** be required for owner and admin roles and the UI nags until it
is enabled. WebAuthn passkeys **MAY** be supported in addition.

## 7.5 Roles and API tokens

| Capability | owner | admin | operator | viewer |
|---|:-:|:-:|:-:|:-:|
| Take scenes, fire actions & cues, pause alerts | ✓ | ✓ | ✓ | |
| Edit overlays, timeline, lineup | ✓ | ✓ | ✓ | |
| Install templates, manage media | ✓ | ✓ | | |
| Manage connections & credentials | ✓ | ✓ | | |
| Manage users, exposure, backups, plugins | ✓ | | | |
| View dashboard & previews | ✓ | ✓ | ✓ | ✓ |

Operators are who runs the show on the night; they cannot see or change credentials.

**API tokens** — `skp_pat_` + 32 random bytes (base62). Shown once at creation; stored as
SHA-256. Each has scopes (03 §3.3), an optional expiry, an optional IP allow-list, and a
last-used timestamp. A token can never exceed its creator's role.

## 7.6 Overlay keys

OBS browser sources can't log in, so overlays use capability URLs.

- `skp_ovl_` + 24 random bytes, one per overlay.
- Grants read access to that overlay's page, snapshot, stream and poll — nothing else.
- **Files are not behind the key.** An OBS browser source requests template files and images as
  plain URLs, which can't carry `?key=`. So template files (`/o/<slug>/t/<build>/…`, 04 §4.5)
  and uploaded media (`/media/<fileId>/…`) are served without it. Their paths protect them:
  `<build>` carries at least 64 bits of the package hash and `fileId` at least 128 random bits,
  and only the keyed page or an authenticated API call reveals either. They hold design files
  and media, never live data or credentials.
- Stored encrypted (not hashed), because the UI must be able to show the URL again for copying.
- Rotating it is explicit and warns that OBS sources must be updated.
- Overlay responses send `Referrer-Policy: no-referrer`; the platform **MUST** redact `key=`
  values from access logs and error reports.
- In `local`/`lan` mode the owner **MAY** mark an overlay "no key required".

## 7.7 Secrets at rest

All third-party credentials, OAuth tokens, overlay keys and webhook secrets **MUST** be
encrypted with **AES-256-GCM** (random 96-bit nonce per record, record ID as associated data).

- The 32-byte **master key** comes from `SKP_MASTER_KEY` (base64) or `SKP_MASTER_KEY_FILE`.
- If neither is set on first start, the platform generates one into the config directory with
  `0600` permissions — deliberately **outside** the data directory — and warns that backing up
  data without the key makes secrets unrecoverable.
- Ciphertexts carry a key ID so the key can be rotated (`skp key rotate` re-encrypts in place).
- Decrypted secrets live only in connector memory.

## 7.8 Exposure modes

`SKP_EXPOSURE` declares how reachable the installation is. The platform enforces the matching
posture and shows it on the dashboard.

| Mode | Binds | Requires | Notes |
|---|---|---|---|
| `local` | 127.0.0.1 | — | Single machine (desktop install default) |
| `lan` | all interfaces; serves only private/loopback clients | Login | Default for TrueNAS/Docker |
| `public` | all interfaces | TLS, login, `SKP_PUBLIC_URL` | Needed for remote control and Kick webhooks |

In `public` mode the platform **MUST** refuse to start unless TLS is available — either its own
certificate (`SKP_TLS_CERT`, `SKP_TLS_KEY`) or a trusted reverse proxy (`SKP_TRUST_PROXY` set to
the proxy's address, with `X-Forwarded-Proto: https`). Recommended: a reverse proxy such as
Caddy or Traefik with automatic certificates, or a tunnel that terminates HTTPS.
`X-Forwarded-*` headers **MUST** be ignored unless they come from a configured trusted proxy.

## 7.9 Inbound webhooks

- **Kick:** verify the signature with Kick's published public key, require a fresh timestamp,
  dedupe by message ID (06 §6.6).
- **Custom hooks:** each has its own secret; accept HMAC-SHA256 over `"<timestamp>.<raw body>"`
  in a `SKP-Signature` header, or a shared secret header for services that can't sign; reject
  timestamps older than 5 minutes.
- Verification uses the **raw** request body, before JSON parsing, with a constant-time compare.
- Unverified deliveries return `401` and are counted, not logged in full.

## 7.10 HTTP hardening

| Header | Admin UI & API | Overlay pages |
|---|---|---|
| `Content-Security-Policy` | strict: `default-src 'self'; frame-ancestors 'none'; object-src 'none'` (+ `frame-src 'self'` for previews) | 04 §4.8 |
| `Strict-Transport-Security` | when served over HTTPS: `max-age=31536000` | same |
| `X-Content-Type-Options` | `nosniff` | `nosniff` |
| `Referrer-Policy` | `same-origin` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` | — |
| CORS | none by default; per-origin allow-list for external web apps | `*` for `GET` only, no credentials |

## 7.11 Input, uploads and processing

- Validate every request body against its schema; reject unknown fields on writes.
- Resolve every filesystem path and confirm it stays inside its root directory.
- URL-decoding errors and malformed requests return `400` — they **MUST NOT** crash the process.
- Uploads: size caps (media 600 MiB, templates 100 MiB), at most 2 concurrent transcodes,
  partial files deleted on abort, content type sniffed rather than trusted.
- ffmpeg is invoked with an argument array (never a shell), a fixed output directory, a time
  limit and lowered priority.
- Template archives are extracted with zip-slip and zip-bomb protection (ratio and total-size
  caps).
- Outbound requests the platform makes on a user's behalf (template install from URL, webhook
  delivery) **MUST** block private, loopback and link-local destinations unless the owner
  enables them, to prevent server-side request forgery.

## 7.12 Audit log

Append-only record of: logins (success and failure), session revocations, user and role
changes, token creation and revocation, connection changes, template installs, overlay key
rotations, exposure changes, backups and restores. Each entry: time, actor, IP, action, target.
Retained 90 days by default. Never contains secrets.

## 7.13 Backups

`POST /system/backup` produces an archive of configuration, overlays, timelines, templates and
media. Secrets inside stay encrypted with the master key; the export **MAY** additionally be
wrapped with a user passphrase (scrypt-derived key, AES-256-GCM) for off-site storage. Restore
requires owner role and the matching master key or passphrase.
