# SecureResident — Operations & Knowledge Base

Operational runbook and reference for running, monitoring, and troubleshooting the
SecureResident apartment security & visitor management platform.

- **Audience:** deployment engineers, SRE/on-call, security operators, tenant admins.
- **Source of truth:** the code. This document summarizes behavior; when in doubt confirm in
  `server/src/lib/rbac.ts` (permissions), `server/src/lib/settings.ts` (settings defaults), and
  `server/src/services/verification.service.ts` (verification engine).

## Table of contents
1. [System overview](#1-system-overview)
2. [Configuration reference](#2-configuration-reference)
3. [Roles & permissions](#3-roles--permissions)
4. [Deployment](#4-deployment)
5. [Day-2 operations](#5-day-2-operations)
6. [Runbooks](#6-runbooks)
7. [Reference](#7-reference)
8. [On-call checklist](#8-on-call-checklist)

---

## 1. System overview

| Component | Tech | Dev port | Prod port | Notes |
| --- | --- | --- | --- | --- |
| API | Fastify 5 + TS (ESM) | 4000 | 4000 | REST under `/api`, OpenAPI UI at `/docs`, WS at `/ws`, uploads at `/uploads` |
| Web | React 19 + Vite 7 | 5173 | 80 (container) / 8080 (host) | nginx serves the SPA and proxies `/api`, `/uploads`, `/docs`, `/ws` |
| Database | SQLite via Prisma 6 | `prisma/dev.db` | `/data/dev.db` (volume) | Single-writer; back up as a file |
| Uploads | Local disk | `server/uploads/` | `/data/uploads` (volume) | Visitor photos; encrypted camera creds live in the DB |

**In-process background jobs** (`server/src/jobs/sweeps.ts`, started at boot):

| Job | Interval | Behavior |
| --- | --- | --- |
| Overstay sweep | every 60s | If `overstayEnabled`, flags `INSIDE` visits past `expectedExitAt + overstayGraceMinutes` once → creates a `HIGH` `OVERSTAY` alert + resident notification |
| Retention sweep | every 6h | If `retentionAnonymizationEnabled`, anonymizes `EXITED` visits older than `visitorDataRetentionDays` (name → "Redacted", clears phone/vehicle/notes/photo) |

**Request lifecycle for a visit:** invite → QR/code (`VIS-YYYY-XXXXXX`, QR payload `SVC:`) →
guard verify → approval (per policy) → entry → inside tracking → exit. Verification is
**fail-secure**: the code/QR alone never grants entry; the DB is always re-checked.

---

## 2. Configuration reference

### 2.1 Environment variables — API (`server/.env`)

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db` | SQLite path; relative to `prisma/`, or absolute (`file:/data/dev.db`) |
| `NODE_ENV` | `development` | `production` enables the insecure-secret boot guard |
| `PORT` | `4000` | API listen port |
| `HOST` | `0.0.0.0` | API bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed browser origin |
| `WEB_ORIGIN` | `http://localhost:5173` | Base URL used in outbound links |
| `JWT_ACCESS_SECRET` | dev default | HMAC secret, access tokens (**must change in prod**) |
| `JWT_REFRESH_SECRET` | dev default | HMAC secret, refresh tokens (**must change in prod**) |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `JWT_REFRESH_TTL` | `7d` | Refresh token lifetime |
| `ENCRYPTION_KEY` | dev default | base64 32-byte key for camera credentials + integration secrets (**must change in prod**) |
| `RATE_LIMIT_MAX` | `300` | General requests/min/IP |
| `AUTH_RATE_LIMIT_MAX` | `10` | Auth endpoints requests/min/IP |
| `UPLOAD_DIR` | `uploads` | Visitor photo storage directory |
| `SEED_DEMO` | (unset) | Docker entrypoint seeds demo data when `true` |

### 2.2 Environment variables — Web

| Var | Default | Purpose |
| --- | --- | --- |
| `API_URL` | `http://localhost:4000` | Vite **dev** proxy target. Ignored in production builds (nginx proxies instead) |

### 2.3 System settings (change at runtime via `PUT /api/settings` / Admin → Settings)

Defaults from `server/src/lib/settings.ts`:

| Key | Default | Notes |
| --- | --- | --- |
| `approvalPolicy` | `RESIDENT` | `AUTO` \| `RESIDENT` \| `SECURITY` \| `BOTH`; watchlist match escalates |
| `lockdownActive` | `false` | Toggled by lockdown activate/release, not edited directly |
| `overstayEnabled` | `true` | Master switch for overstay alerts |
| `overstayGraceMinutes` | `15` | Grace past `expectedExitAt` before an overstay alert |
| `visitorDataRetentionDays` | `90` | Age threshold for anonymization |
| `retentionAnonymizationEnabled` | `false` | Off by default |
| `voiceAlertsEnabled` | `true` | Voice warnings on verification failures |
| `allowInvitationExtension` | `true` | Residents may extend invitations |
| `maxInvitationDaysAhead` | `30` | Furthest future invite date |
| `invitationDefaultDurationMinutes` | `120` | Default visit length |
| `invitationArrivalWindowMinutes` | `60` | Arrival window around `expectedAt` |
| `requireVehicleNumber` | `false` | Require vehicle number on invite |
| `notifyChannels` | `IN_APP,PUSH` | Notification channels |
| `alertChannels` | `IN_APP,PUSH` | Alert channels |
| `securityStatusNormalThreshold` | `0` | Dashboard "normal" threshold |
| `systemName` | `SecureResident` | Display name |
| `integrationApiKey` | `""` | Shared key for `POST /api/integrations/detector-events` |

> Missing keys fall back to these defaults on read, so the app stays consistent even on a
> partially populated settings table.

---

## 3. Roles & permissions

Roles: `SUPER_ADMIN`, `ADMIN`, `SECURITY`, `RESIDENT`, `GUARD`. Enforcement is by
`requirePermission(...)` (OR semantics) on every route; the web mirrors the same strings in
`web/src/App.tsx`. **`server/src/lib/rbac.ts` is the single source of truth.**

High-level capabilities:

| Capability | SUPER_ADMIN | ADMIN | SECURITY | GUARD | RESIDENT |
| --- | :-: | :-: | :-: | :-: | :-: |
| Manage users/buildings/devices/settings | ✅ | ✅ | — | — | — |
| View audit log / reports | ✅ | ✅ | —* | — | — |
| Activate/release lockdown | ✅ | ✅ | —* | — | — |
| Manage watchlist | ✅ | ✅ | —* | — | — |
| Alerts / incidents / detector events | ✅ | ✅ | ✅ | alerts* | — |
| Verify visitors, entry/exit | ✅ | ✅ | ✅ | ✅ | — |
| Create/manage own invitations, approve own visitors | ✅ | ✅ | — | — | ✅ |

`—*` **Deliberate:** `SECURITY` lacks `lockdown:manage`, `watchlist:manage`, and `audit:read`
(asserted by `server/tests/unit/rbac.test.ts`). SECURITY receives `403 MISSING_PERMISSION` on
those endpoints; the corresponding UI controls are hidden. Only `ADMIN`/`SUPER_ADMIN` manage
lockdown/watchlist/audit. If a tenant needs SECURITY to manage these, change `rbac.ts` **and**
the tests together.

---

## 4. Deployment

### 4.1 Local development

```bash
# API
cd server
npm install
cp .env.example .env
npx prisma db push
npm run seed          # demo data (destructive reset of demo rows)
npm run dev           # http://localhost:4000  (docs at /docs)

# Web (separate shell)
cd web
npm install
npm run dev           # http://localhost:5173 (proxies /api,/uploads,/docs,/ws → :4000)
```

Demo accounts (password `Secure@Demo123!`): `superadmin@`, `admin@`, `security@`,
`guard1@`, `guard2@` `@secureresident.local`; residents `ali@`, `hamza@`, `fatima@`, `sara@`
`@resident.local`. Seeded codes `VIS-2026-GUEST1`, `VIS-2026-INSID1`; gate `MAIN-1`.

### 4.2 Docker (recommended production path)

Secrets are **required**; compose fails fast and the API refuses to boot with defaults.

```bash
export JWT_ACCESS_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -base64 32)
export SEED_DEMO=false          # true only for a demo environment
docker compose up --build
# web → http://localhost:8080   api → http://localhost:4000 (also via nginx)
```

- On start the server entrypoint runs `prisma migrate deploy`, optionally seeds, then starts the API.
- State persists in the `server-data` named volume (`/data` = DB + uploads).
- Healthcheck polls `/api/public/health`; `web` waits for `server` to be healthy.

### 4.3 Manual / VM production

```bash
# API
cd server
npm ci
npx prisma migrate deploy
npm run build
NODE_ENV=production node dist/server.js   # behind a process manager (systemd/pm2)

# Web
cd ../web
npm ci
npm run build                             # outputs web/dist
# serve dist via nginx (see web/nginx.conf for SPA + /api,/uploads,/docs,/ws proxy)
```

Run the API under a supervisor (systemd `Restart=always`, or a container) and terminate TLS at
your reverse proxy. Point `CORS_ORIGIN`/`WEB_ORIGIN` at the public web origin.

### 4.4 Production hardening checklist

- [ ] Generate fresh `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` (never reuse dev values).
- [ ] `SEED_DEMO` unset/`false`; delete or rotate every `Secure@Demo123!` account.
- [ ] Put the API and web behind TLS (HTTPS/WSS).
- [ ] Restrict network access to the API (only nginx / reverse proxy trusted).
- [ ] Schedule off-host backups of `/data` (SQLite + uploads).
- [ ] Set `CORS_ORIGIN`/`WEB_ORIGIN` to the real origin.
- [ ] Set `integrationApiKey` if using AI/CCTV detector ingest.
- [ ] Review `approvalPolicy`, `overstayGraceMinutes`, and retention settings for the site.

---

## 5. Day-2 operations

### 5.1 Health & monitoring

| Check | Command / endpoint | Expected |
| --- | --- | --- |
| Liveness | `GET /api/public/health` | `200` |
| OpenAPI | `GET /docs` | UI loads |
| Lockdown + active alerts | `GET /api/security/status` | `{ lockdownActive, activeAlerts }` |
| Dashboard | security `GET /api/dashboard/security`, resident `GET /api/dashboard/resident` | metrics JSON |
| Container health | `docker compose ps` | `server` healthy |

Log lines to watch: `[job:overstay]`, `[job:retention]`, `[FATAL] Refusing to start…`, and any
Fastify 5xx. The API logs to stdout/stderr — collect with your platform's log driver.

### 5.2 Backup & restore

State = **SQLite DB** + **uploads directory**. In Docker both live in the `server-data` volume.

```bash
# Backup (Docker): stop writes briefly for a consistent copy, then archive the volume
docker compose stop server
docker run --rm -v surveillance_server-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/secureresident-$(date +%F).tgz -C /data .
docker compose start server

# Backup (bare metal): copy prisma/dev.db (or the absolute DATABASE_URL file) + uploads/
```

Restore: stop the API, replace the DB file and uploads with the backup, start the API. Run
`prisma migrate deploy` if the backup predates a schema migration.

> SQLite is single-writer. Always stop the API (or use SQLite's `.backup`) before copying the
> DB file to avoid a torn snapshot.

### 5.3 Migrations & upgrades

1. Back up first (see 5.2).
2. Deploy the new build. Docker runs `prisma migrate deploy` automatically at start; for bare
   metal run `npx prisma migrate deploy` before restarting.
3. Health-check `/api/public/health`, then smoke-test login + a verify.
4. Roll back by restoring the DB backup and redeploying the previous image/build.

Development schema changes: `npx prisma migrate dev` (creates a migration). Tests use a
separate `tests/test.db` provisioned by the vitest global setup.

### 5.4 Secret rotation

- **JWT secrets:** rotating `JWT_*` invalidates all existing access/refresh tokens (everyone
  re-logs in). Rotate during a maintenance window, then restart the API.
- **`ENCRYPTION_KEY`:** encrypts camera credentials + integration secrets. Rotating it without
  re-encrypting existing rows makes stored credentials unreadable — re-enter them in
  Admin → Devices after rotation, or plan a re-encrypt migration.
- **`integrationApiKey`:** update it in Settings and on the detector devices together.

### 5.5 Seeding / resetting demo data

```bash
cd server && npm run seed        # resets demo rows
```
Never run the seed against a production database unless you intend to overwrite demo data.

---

## 6. Runbooks

### 6.1 A guard cannot verify a visitor

1. Ask the reason string shown at the gate. Map it via [§7.2](#72-verification-failure-reasons).
2. Common causes:
   - `NOT_FOUND` — wrong code / wrong gate; re-scan the QR (`SVC:` prefix is auto-normalized).
   - `EXPIRED` / `OUTSIDE_WINDOW` — arrival outside `expectedAt ± arrivalWindow`; extend or re-invite.
   - `ALREADY_INSIDE` — the visitor already has an open entry; have them exit first.
   - `BLOCKED` — watchlist match; do **not** admit; escalate to security/admin.
   - `LOCKDOWN_ACTIVE` — see §6.3.
   - `GATE_NOT_ALLOWED` / `APARTMENT_INACTIVE` / `RESIDENT_INACTIVE` — policy/status; escalate to admin.
3. Every failed attempt creates a `securityAlert` (except `LOCKDOWN_ACTIVE`) and, if
   `voiceAlertsEnabled`, a voice event. Review in Security → Alerts.

### 6.2 A visitor is stuck "inside" / missing exit

- The overstay job raises a `HIGH` `OVERSTAY` alert + notifies the resident after
  `expectedExitAt + overstayGraceMinutes`.
- To close a visit manually: guard/security performs the exit (`POST /api/visitors/:id/exit`),
  or run the **missing-exits** report (`GET /api/reports/missing-exits`) to find open visits.
- If `overstayEnabled=false`, no automatic alert is raised.

### 6.3 Lockdown activate / release

- Activate: `POST /api/security/lockdown { reason }` (requires `lockdown:manage`; duplicate → `409`).
  During lockdown all verifications fail with `LOCKDOWN_ACTIVE`.
- Release: `POST /api/security/lockdown/release { notes? }` → `409 NO_LOCKDOWN` if not active.
- History: `GET /api/security/emergency/events` (`alerts:read`).
- Status: `GET /api/security/status`.
- The UI (Security → Dashboard) shows the lockdown banner and, for admins, activate/release controls.

### 6.4 Account locked / "too many requests"

- Lockout after 5 failed logins for 15 minutes → `429 ACCOUNT_LOCKED`.
- Auth endpoints are rate-limited at `AUTH_RATE_LIMIT_MAX` (default 10/min/IP) → `429 RATE_LIMITED`.
- Wait out the window, or raise `AUTH_RATE_LIMIT_MAX`/`RATE_LIMIT_MAX` and restart. Investigate
  repeated hits as possible credential-stuffing.

### 6.5 Alerts & incidents workflow

- Alert lifecycle: `NEW → ACKNOWLEDGED → RESOLVED` via
  `POST /api/security/alerts/:id/acknowledge` and `POST /api/security/alerts/:id/resolve {resolution}`.
- Incidents: `POST /api/security/incidents`, then `PUT /api/security/incidents/:id`
  (`status`, `actionsTaken`, `resolution`) to investigate → close.
- `GET /api/security/status` exposes the active-alert count for dashboards/alerting.

### 6.6 Watchlist management

- Add: `POST /api/security/watchlist { name?, phone?, vehicle?, reason, level }`
  (`BLOCKED` \| `WATCHLIST` \| `RESTRICTED`).
- Remove: `DELETE /api/security/watchlist/:id` (soft delete).
- A match at verify time escalates the approval policy automatically.
- Requires `watchlist:manage` (ADMIN/SUPER_ADMIN only).

### 6.7 AI/CCTV detector integration

- Ingest: `POST /api/integrations/detector-events` with header `x-api-key: <integrationApiKey>`
  (or a bearer token with `detector:ingest`). Rate limit 120/min.
- Send `cameraId` (and optionally `area`) so the alert/incident is attributable. When
  `cameraId` is present the detecting camera's name and area are added to the alert, and the
  camera appears under "Detecting cameras" on the incident.
- `UNKNOWN_PERSON` without a matching inside entry creates a `CRITICAL` alert, incident, and voice warning.
- **AI events never grant access.**
- View: `GET /api/security/detector-events`.
- Snapshot of the detecting camera: `GET /api/cameras/:id/snapshot` (`cameras:read`) returns
  `image/jpeg`. HTTP/MJPEG/ONVIF cameras with a still-image URL work directly; RTSP cameras are
  decoded with **`ffmpeg`**, which must be installed on the API host (bundled in
  `server/Dockerfile`). A failure returns `502 SNAPSHOT_UNAVAILABLE` with a reason.

### 6.8 Real-time (WebSocket) not updating

- Clients connect to `/ws?token=<accessToken>`; topics are assigned per role
  (see [§7.3](#73-websocket-topics--events)).
- If updates stop: check token expiry (15m) — the client refreshes automatically, but a network
  blip may require a page reload. Ensure the proxy forwards `Upgrade`/`Connection` headers
  (see `web/nginx.conf`). Confirm `GET /api/public/health` is reachable.

### 6.9 Database errors

- **"database is locked"** — too many concurrent writers or a stray `sqlite3` session; SQLite
  allows one writer. Reduce concurrency, ensure a single API instance, and avoid copying the DB
  while running.
- **Missing tables** — run `prisma migrate deploy` (the Docker entrypoint does this).
- **Corruption** — restore the latest backup; investigate disk health.

---

## 7. Reference

### 7.1 Error codes

Responses use `{ "error": { "code", "message", "details?" } }`. Common codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request failed zod validation (includes weak/short fields) |
| `WEAK_PASSWORD` | 400 | Password policy: ≥10 chars + upper + lower + digit + symbol, not common |
| `UNAUTHORIZED` | 401 | Missing/invalid token |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password |
| `MISSING_PERMISSION` | 403 | Role lacks the required permission |
| `FOREIGN_INVITATION` | 403 | Acting on an invitation that isn't yours |
| `NOT_HOST_RESIDENT` | 403 | Approval by a non-host resident |
| `NOT_FOUND` | 404 | Resource not found |
| `REPORT_NOT_FOUND` | 404 | Unknown report name |
| `ACCOUNT_LOCKED` | 429 | Login lockout (5 failures / 15 min) |
| `RATE_LIMITED` | 429 | Per-IP rate limit exceeded |
| `LOCKDOWN_ACTIVE` | 409/200 | Lockdown blocks the operation (verify returns 200 `verified:false`) |
| `ALREADY_INSIDE` | 409/200 | Visitor already has an open entry |
| `NO_LOCKDOWN` | 409 | Release requested while no lockdown is active |
| `UNAUTHORIZED_INTEGRATION` | 400 | Bad detector integration credentials |

### 7.2 Verification failure reasons

Returned in the verify response as `reason` (HTTP 200 with `verified:false`):

`NOT_FOUND`, `LOCKDOWN_ACTIVE`, `REJECTED`, `EXPIRED`, `ALREADY_INSIDE`, `EXHAUSTED`,
`OUTSIDE_WINDOW`, `RESIDENT_INACTIVE`, `APARTMENT_INACTIVE`, `GATE_NOT_ALLOWED`, `BLOCKED`.

Successful verify response includes: `{ verified, banner, ok, invitation, policy,
requiredApprovals, pendingApprovals, entryAllowed, watchlisted }` (the human-readable string is
`banner`). Failures (except `LOCKDOWN_ACTIVE`) create an alert and may emit voice warnings.

### 7.3 WebSocket topics & events

Topics (`topicsForUser`): `broadcast`, `user:<id>`, `role:<ROLE>`, plus `staff`
(ADMIN/SECURITY/GUARD), `security` (ADMIN/SECURITY), `guards` (GUARD), `admins`
(ADMIN/SUPER_ADMIN), `residents` (RESIDENT).

Envelope: `{ type, data, at }`. Event types include `voice-alert`, `lockdown`, `notification`,
`approval-pending`, `approval-request`, `approval-decided`, `visitor-entry`, `visitor-exit`.
(Approval events are published to both `guards` and `security`.)

### 7.4 Reports

`GET /api/reports` lists names; `GET /api/reports/:name?format=json|csv&from&to`.

| Report | Purpose |
| --- | --- |
| `daily-visitors` | Visits per day in range |
| `currently-inside` | Open (not exited) visits right now |
| `unauthorized-attempts` | Failed verifications / unauthorized attempts |
| `incidents` | Incident log in range |
| `missing-exits` | Visits still open past expectation |
| `by-apartment` | Visitor volume per apartment |
| `alerts-summary` | Alert counts by type/status |

CSV responses carry `Content-Disposition: attachment`. Every generation writes a
`REPORT_GENERATED` audit entry.

### 7.5 API quick index

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/login`, `/refresh`, `/logout`, `/change-password`; `GET /api/auth/me` |
| Invitations | `/api/invitations` (CRUD, extend, approve/reject) |
| Visitors | `/api/visitors` (verify, entry, exit, currently-inside, search, `/:id`) |
| Security | `/api/security/alerts`, `/incidents`, `/watchlist`, `/lockdown`, `/lockdown/release`, `/status`, `/emergency/events`, `/detector-events` |
| Dashboards | `/api/dashboard/security`, `/api/dashboard/resident` |
| Admin | `/api/users`, `/api/buildings`, `/api/gates`, `/api/cameras`, `/api/cameras/:id`, `/api/cameras/:id/snapshot`, `/api/settings` |
| Audit & reports | `/api/audit`, `/api/audit/actions`, `/api/reports`, `/api/reports/:name` |
| Notifications | `/api/notifications`, `/api/notifications/:id/read`, `/api/notifications/read-all` |
| Voice | `GET/PUT /api/voice-alerts/:event` |
| Integrations | `POST /api/integrations/detector-events` |
| Public | `GET /api/public/health`, public invite lookup for `/invite/:code` |

See `/docs` for the live, complete schema.

### 7.6 Seeded reference data

- Demo password: `Secure@Demo123!`
- Accounts: `superadmin@`, `admin@`, `security@`, `guard1@`, `guard2@` `@secureresident.local`;
  `ali@`, `hamza@`, `fatima@`, `sara@` `@resident.local`
- Visitor codes: `VIS-2026-GUEST1` (awaiting approval), `VIS-2026-INSID1` (inside)
- Gate: `MAIN-1`

---

## 8. On-call checklist

**When paged:**
1. `GET /api/public/health` — is the API up?
2. `GET /api/security/status` — lockdown active? how many active alerts?
3. Check logs for `[FATAL]`, job errors, and 5xx.
4. If lockdown is active, confirm it's intentional before releasing.
5. For a gate outage, follow §6.1; for stuck visitors, §6.2; for DB issues, §6.9.
6. Record the incident via `POST /api/security/incidents` so it's captured in the audit trail.

**Periodic (daily/weekly):**
- Review unresolved alerts and open incidents.
- Verify the latest backup exists and is restorable.
- Check disk space on the data volume (SQLite + uploads).
- Confirm the overstay/retention jobs are running (log heartbeat / alert volume).

**Escalation:** site security supervisor → admin → platform on-call. Use the audit log
(`GET /api/audit`) for a precise timeline of who did what.
