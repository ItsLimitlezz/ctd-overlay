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
- The setup endpoint **MUST** refuse requests that do not come from a loopback or private
  address (behind a trusted proxy, the client it forwards, §7.8), so an exposed fresh install
  cannot be claimed by a stranger who finds it first. It matters in `public` mode: in `local`
  mode only this machine reaches setup, and `lan` mode serves the local network only.

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
  prefix (`__Host-skp_session`). Over plain HTTP on a LAN: `skp_session` without `Secure`. Over
  HTTPS only the `__Host-` cookie is read; signing out there clears both names.
- Idle timeout 12 h; absolute lifetime 30 days ("keep me signed in") or 24 h otherwise.
- Rotate the session ID on login and on any privilege change. Invalidate all of a user's
  sessions on password change, 2FA change or role change.
- Users can see and revoke their active sessions (device, IP, last seen).

**CSRF.** State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) authenticated by cookie
**MUST** carry `X-SKP-CSRF` equal to the session's CSRF token (from `GET /auth/session`), and
the `Origin` header, when present, **MUST** match the platform's origin. Token-authenticated
requests are exempt.

**Login protection.** 10 failed attempts per account or per IP within 15 minutes triggers an
exponential delay (1 s → 2 s → … → 15 min). The count is a streak: each failure within 15
minutes of the last one counts, so the delay can reach its cap (a sliding 15-minute window would
empty before it did); 15 quiet minutes, or a success for the account, start it over. The same
protection covers setup codes. The password asked for again (a new password, turning two-factor
on or off) counts with the sign-ins, and each failure is audited as `login.failure` (reason
`recheck`). Error messages never reveal whether the account exists, and an unknown name costs one
hash too. Failed and successful logins go to the audit log.

**The command line.** On the platform's own machine, `skp` drives the running platform with a
local token (03 §3.3) the platform writes at each start into the config directory (`0600` on
POSIX, §7.7), beside the master key: whoever can read one can read the other. It acts as the
owner, is accepted only from a loopback address and never through a proxy (§7.8), and is removed
when the platform stops. Its changes are recorded as `cli:<user>` (§7.12). It reaches the
platform at 127.0.0.1 (or `::1`) when the platform listens on every interface, and over HTTPS
with built-in TLS, trusting only the certificate in `SKP_TLS_CERT`, checked before the token is
sent. It works in every exposure mode, but not when `SKP_HOST` is a specific address that isn't
loopback (exit 78). It is how the owner resets a forgotten password (`skp user password <name>`).
The owner's own password and two-factor change only with the current password
(`POST /auth/password`, `DELETE /auth/totp`) or from the command line: `PATCH /users/{id}`
refuses them to a session or a token (`403`).

## 7.4 Two-factor authentication

TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) with 10 single-use recovery codes stored hashed.
A code is accepted once (a later step only), and enrolling or turning it off takes the password.
In `public` mode 2FA **SHOULD** be required for owner and admin roles and the UI nags until it
is enabled. WebAuthn passkeys **MAY** be supported in addition. The TOTP secret is a secret at
rest (§7.7). Recovery codes are kept as hashes, so they still sign in when the TOTP secret can't
be decrypted (data restored without its master key).

## 7.5 Roles and API tokens

| Capability | owner | admin | operator | viewer |
|---|:-:|:-:|:-:|:-:|
| Take scenes, fire actions & cues, pause alerts | ✓ | ✓ | ✓ | |
| Edit overlays, timeline, lineup | ✓ | ✓ | ✓ | |
| Install templates, manage media | ✓ | ✓ | | |
| Manage connections & credentials | ✓ | ✓ | | |
| Manage users, exposure, backups, plugins | ✓ | | | |
| View dashboard & previews | ✓ | ✓ | ✓ | ✓ |

Operators are who runs the show on the night; they cannot see or change credentials. The audit
log (§7.12) is for owners and admins (`audit:read`). There is one owner, made at setup; the
owner gives the other roles.

**API tokens** — `skp_pat_` + 32 random bytes (base62). Shown once at creation; stored as
SHA-256. Each has scopes (03 §3.3), an optional expiry, an optional IP allow-list, and a
last-used timestamp. A token can never exceed its creator's role.

Revoking a token, removing a user or ending a session also ends their open `/api/v1/events`
streams, at the next heartbeat or event (03 §3.4).

## 7.6 Overlay keys

OBS browser sources can't log in, so overlays use capability URLs.

- `skp_ovl_` + 24 random bytes, one per overlay.
- Grants read access to that overlay's page, snapshot, stream and poll — nothing else.
- **Files are not behind the key.** An OBS browser source requests template files and images as
  plain URLs, which can't carry `?key=`. So template files (`/o/<slug>/t/<build>/…`, 04 §4.5)
  and uploaded media (`/media/<fileId>/…`) are served without it. A `fileId` carries at least
  128 random bits, and only the keyed page or an authenticated API call reveals it. A `<build>`
  is not a secret: it is a hash of the package, so anyone who has the same package (a bundled or
  published template) can compute it, and a slug is not secret either. Template files are
  therefore public to anyone who can reach the platform; they hold design files, never live
  data or credentials, and a template **MUST NOT** ship anything its author wouldn't publish.
- Stored encrypted (not hashed), because the UI must be able to show the URL again for copying.
- Rotating it is explicit and warns that OBS sources must be updated.
- Overlay responses send `Referrer-Policy: no-referrer`; the platform **MUST** redact `key=`
  values from access logs and error reports.
- In `local`/`lan` mode the owner **MAY** mark an overlay "no key required" (`system:admin`;
  other roles may require the key again or rotate it, never drop it). Rotating the key, or
  requiring it again, ends the overlay's open streams; a page reconnects only with the key that
  works now.

## 7.7 Secrets at rest

All third-party credentials, OAuth tokens, overlay keys and webhook secrets **MUST** be
encrypted with **AES-256-GCM** (random 96-bit nonce per record, record ID as associated data).

- The 32-byte **master key** comes from `SKP_MASTER_KEY` (base64) or `SKP_MASTER_KEY_FILE`.
- If neither is set on first start, the platform generates one into the config directory with
  `0600` permissions — deliberately **outside** the data directory — and warns that backing up
  data without the key makes secrets unrecoverable. The `0600` mode is POSIX: on Windows the key
  takes the config directory's permissions, so keep `SKP_CONFIG_DIR` in the user's profile (the
  platform warns otherwise).
- Command-line commands never make a master key: they use the platform's, from the config
  directory or the same `SKP_MASTER_KEY` / `SKP_MASTER_KEY_FILE`.
- Ciphertexts carry a key ID so the key can be rotated (`skp key rotate` re-encrypts in place).
  It never replaces an existing `master.key.next`: a rotation that stopped part way is finished
  with that key, and a `.next` left without its `master.key` is put in place the next time the
  key is read.
- Decrypted secrets live only in connector memory.
- What is encrypted, and with what associated data: an overlay's key (its id); a TOTP secret
  (`totp:<user id>`); a connection's secret settings, as one value (`connection:<id>`); its
  account's tokens (`tokens:<id>`); credentials the v0 importer keeps (their record's id). A
  connection's settings, its secrets and tokens and what it keeps between starts are deleted
  together. The API never answers a secret: a connection lists which secret settings hold a
  value (`secretFields`), and the admin UI never fills a secret field in.

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
`X-Forwarded-For` is read from the right, past any trusted proxies. Entries may carry a port
(`ip:port`, `[v6]:port`); an entry that isn't an address ends the walk, and the client counts as
outside. A trusted proxy **MUST** send `X-Forwarded-For` and `X-Forwarded-Proto` on every request
it forwards (Caddy and Traefik do; nginx once `proxy_set_header` sets them): a request from its
address with no forwarding header is treated as that machine's own, and one it forwards without
`X-Forwarded-For` (or with an empty one) comes from an unknown client, outside: refused in `lan`
mode and at setup, and logged once so the proxy gets fixed. `SKP_TRUST_PROXY` matches any
spelling of an address.

In `public` mode, a client on the local network may still use plain HTTP (OBS on the LAN needs
no certificate); anyone else gets HTTPS only. API requests must be addressed to one of the
platform's names: loopback, its addresses and host name (read again as they change),
`SKP_HOSTS` and `SKP_PUBLIC_URL`'s host. In a container its own addresses aren't the host's:
name those in `SKP_HOSTS` (10 §10.3). The command line's local token is refused on a request that
came through a proxy: one that carries a forwarding header (`X-Forwarded-For`,
`X-Forwarded-Proto`, `X-Forwarded-Host`, `Forwarded`, `X-Real-IP`, `Via`). The command line's own
requests carry none, so it works beside a proxy.

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
| CORS | none by default; per-origin allow-list for external web apps | `*` for `GET`, and for the CORS-simple `POST /o/{slug}/log` (03 §3.4), so the sandboxed preview's `SK.log` doesn't log a CORS error each time; no credentials |
| Template files | — | `/o/{slug}/t/{build}/*` add `Content-Security-Policy: sandbox; default-src 'none'; …`, so a package's own HTML or SVG opened directly runs without script or origin (04 §4.8) |

## 7.11 Input, uploads and processing

- Validate every request body against its schema; reject unknown fields on writes.
- Resolve every filesystem path and confirm it stays inside its root directory.
- URL-decoding errors and malformed requests return `400` — they **MUST NOT** crash the process.
- Uploads: size caps (media 600 MiB, templates 100 MiB), at most 2 concurrent transcodes,
  partial files deleted on abort, content type sniffed rather than trusted.
- Time limits: headers must arrive within 30 s; a JSON body within 60 s (`408`); a package
  within the time its size limit takes at 64 KiB/s (about 27 minutes); a streamed media upload
  is dropped after 60 s with nothing arriving; and every request must arrive whole within 30
  minutes.
- ffmpeg is invoked with an argument array (never a shell), a fixed output directory, a time
  limit and lowered priority.
- Template archives are extracted with zip-slip and zip-bomb protection (ratio and total-size
  caps).
- Outbound requests the platform makes on a user's behalf (template install from URL, webhook
  delivery) **MUST** block private, loopback and link-local destinations unless the owner
  enables them, to prevent server-side request forgery. That includes IPv4-mapped IPv6 in any
  notation, and addresses written directly in the URL; of 192.0.0.0/16 only 192.0.0.0/24 and
  192.0.2.0/24 are private.
- Connections reach three kinds of destination (06 §6.1.1): **service** (the connector's own
  API, HTTPS only); **lan** (an address the operator typed in a connection's settings, such as OBS
  or CTD Multi-Stream: resolved once and connected to that address, plain HTTP only to private and
  loopback addresses, never link-local, unspecified or multicast; a self-signed certificate is
  trusted by its SHA-256 fingerprint, checked before any request is sent); **public** (the
  internet, as above). An address with a user name or password in it is refused: those go in the
  connection's secret settings. A redirect is never followed.

## 7.12 Audit log

Append-only record of: logins (success and failure), session revocations, user and role
changes, token creation and revocation, connection changes, template installs, overlay key
rotations, exposure changes, backups and restores; also overlay upgrades, cue overrides, media
changes and the platform's own template updates. Each entry: time, actor, IP, action, target.
Retained 90 days by default (`SKP_AUDIT_DAYS`). Never contains secrets. Changes made from the
command line are recorded as `cli:<user>` (its OS user), whether it drives the running platform
with the local token or changes the data directory itself.

## 7.13 Backups

`POST /system/backup` produces an archive of configuration, overlays, timelines, templates and
media. Secrets inside stay encrypted with the master key; the export **MAY** additionally be
wrapped with a user passphrase (scrypt-derived key, AES-256-GCM) for off-site storage. Restore
requires owner role and the matching master key or passphrase.
