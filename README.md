# DREP — Dietary Registry for Event Planning

![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-containerised-2496ED?logo=docker&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Status](https://img.shields.io/badge/Status-Production-brightgreen)

A secure, self-hosted family health registry for multi-generational event planning. Deployed on a home-lab NAS, served via Cloudflare Tunnel, and actively used by an extended family across three generations.

---

## The Problem

Organising a multi-generational family gathering means tracking a non-trivial combination of dietary restrictions, clinical food requirements, severe allergies, and personal preferences — across people who don't use the same messaging apps and aren't going to fill out a Google Form every time. The information changes as family members age or develop new conditions. Without a central record, the host ends up chasing the same details before every event.

This solves that. A single URL, accessible by any family member with a PIN, that gives the host everything they need at a glance.

---

## Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Node.js 20 (Alpine) | LTS, matches host Node version |
| Framework | Express.js 4.22 | Mature, minimal |
| Database | SQLite via `better-sqlite3` | See architecture note 1 |
| Auth | JWT (HS256) + bcryptjs | See security section |
| Frontend | Vanilla HTML/CSS/JS | See architecture note 2 |
| Container | Docker + Compose | Portable, reproducible |
| Host | Ugreen DXP4800 NAS | Home lab |
| Edge | Cloudflare Tunnel | See architecture note 5 |
| Logging | winston | Structured JSON, file rotation |

---

## Architecture Decisions

Five deliberate choices worth explaining.

**1. SQLite, not Postgres.**
For a private family application with at most a few dozen concurrent users, running a separate database service adds operational overhead with no measurable benefit. SQLite in WAL mode handles concurrent reads cleanly, foreign keys are enforced, and the database is a single file — trivially backed up with a single API call, trivially restored from a copy. The backup route uses `better-sqlite3`'s native `backup()` API (safe online backup, no file lock required) and requires no database server to restore.

**2. No frontend framework.**
No build pipeline means no supply chain attack surface from npm dependencies in the client bundle, no Webpack or Vite configuration to maintain, and a single `index.html` that any developer can read and understand in one sitting. The UI is complex enough to justify separation of concerns but not complex enough to justify a framework's compilation and abstraction overhead.

**3. Two-track authentication.**
Named accounts (register → pending → admin-activated) for family members who submit updates; a shared guest PIN for read-only access. This matches real-world family dynamics: not everyone wants to create an account to check whether Grandma is still vegetarian before cooking. The guest PIN is bcrypt-hashed in memory, never written to disk.

**4. Optimistic pending state.**
Submissions from members (new dietary tags, new events) appear immediately in the UI as pending — visually faded with an amber indicator — without waiting for admin approval. This was deliberate. In moderated systems, the most common failure mode is the submitter not knowing whether their input was received. Showing the pending state immediately removes that ambiguity, and the admin approval workflow proceeds asynchronously.

**5. Cloudflare Tunnel over port-forwarding.**
The NAS origin IP is never exposed. No inbound firewall rules are required on the home router. TLS is handled at the edge. The operational tradeoff: the application depends on Cloudflare availability for external access, which is an acceptable risk for a family app where Tailscale provides a direct fallback for the operator. The alternative — punching holes in a home router's firewall — trades a managed dependency for an unmanaged attack surface.

---

## Features

### Authentication and Access Control

- **Role hierarchy:** `owner → admin → member → guest → pending`
- **Guest access:** shared PIN, read-only, no account required
- **Named accounts:** self-registration with admin-approval gate
- **JWT sessions:** HS256 with explicit algorithm enforcement; tokens invalidated on password change via `iat` comparison against `last_password_change`
- **Timing-safe login:** bcrypt comparison always runs against a dummy hash when the email is not found, preventing user enumeration via response timing

### Dietary Registry

- Three-generation family member profiles (Gen 1 / 2 / 3)
- Four tag types: `restriction`, `allergy`, `preference`, `clinical`
- Allergy entries flagged with prominent red border and ⚠ indicator
- Pending submissions visible immediately to all authenticated users; activated on admin approval
- Generation filter and allergy quick-filter
- Admin: add, edit, delete members and tags directly; edit pending submissions before approval

### Events

| Viewer | Visible fields |
|--------|---------------|
| Unauthenticated | Event type only |
| Guest / Member | Full details: date, time, location, dietary notes, hero image |
| Admin | Full details + share link management |

- Member-submitted events enter pending state; go live on admin approval
- Optional hero image (Google Drive or Imgur URL, server-side allowlist enforced)
- **Shareable public links:** 64-character cryptographically random token, stored in DB, timing-safe comparison on lookup, 90-day expiry, individually revocable
- Public share response returns aggregate dietary counts only — no member names, no PII

### Admin Panel

- Pending queue: dietary tag approvals and event approvals in one view
- User management: activate, deactivate, promote to admin, demote to member
- Member management: add and edit family member profiles
- Database backup: owner-only route, safe online backup, download as `.db` file

---

## Security

### HTTP Security Headers

Applied globally via `helmet` before all routes:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: drive.google.com i.imgur.com *.imgur.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

`unsafe-inline` is permitted for `style-src` only, which is a known tradeoff for an app with dynamic avatar colour classes applied inline via JavaScript.

### Rate Limiting

Three independent tiers via `express-rate-limit`:

| Tier | Routes | Limit |
|------|--------|-------|
| Auth | `/api/auth/*` | 20 requests / 15 minutes |
| API | All `/api/*` routes | 120 requests / minute |
| Share | `/share/*` | 30 requests / minute |
| Backup | `/api/admin/backup` | 5 requests / hour |

### Input Validation and Sanitisation

- Email fields: format-validated and normalised via `validator.js` before any DB operation
- Text fields: HTML stripped before insertion into the database
- Hero image URLs: server-side allowlist (`drive.google.com`, `i.imgur.com`) — rejected at the API layer, not just the frontend
- All SQLite queries use parameterised statements; no string concatenation in SQL

### JWT Hardening

```js
jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] })
```

Explicit algorithm enforcement prevents algorithm confusion attacks (e.g., `none` or RS256 with a public key as the secret). Tokens carry an `iat` claim that is compared against `last_password_change` on every authenticated request — a password change immediately invalidates all existing sessions.

### Timing-Safe Authentication

```js
const match = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
```

bcrypt comparison always runs, regardless of whether the email exists. This prevents distinguishing valid from invalid accounts via response timing. `DUMMY_HASH` is generated fresh on each server startup and lives only in memory.

### Non-Root Container Execution

The container starts as root solely to fix volume ownership via an entrypoint script, then drops to `appuser` via `su-exec` before the Node.js process starts. The application process runs with `no-new-privileges: true`.

### Share Link Design

- **Token:** `crypto.randomBytes(32).toString('hex')` — 64 hex characters, 256 bits of entropy
- **Comparison:** `crypto.timingSafeEqual` prevents timing-based token enumeration
- **Expiry:** 90 days from generation, enforced server-side
- **Revocation:** admin can invalidate any token immediately
- **PII:** the public share response returns aggregate dietary counts only (e.g., "3 vegetarian, 1 nut allergy") — member names and profiles are never included

### Cloudflare Tunnel

The NAS origin IP is never exposed to the public internet. TLS is terminated at Cloudflare's edge. No inbound firewall rules are required. DDoS mitigation and bot scoring are provided at the edge layer without any application-layer configuration.

### Dependency Audit

The Dockerfile includes an opt-in audit gate:

```bash
make audit   # runs npm audit --audit-level=high as a build step; blocks on failure
make deploy  # standard deploy, skips audit
```

`make audit` passes clean at `high` severity. Dependencies are pinned to exact versions in `package.json`.

### Deliberate Out-of-Scope Decisions

| Feature | Reason not implemented |
|---------|----------------------|
| Two-factor authentication | Usability tradeoff: family members across generations, some unfamiliar with authenticator apps. The risk profile (private family data, no financial or medical records) does not justify the friction |
| Postgres | Scale does not justify a separate service. SQLite in WAL mode is adequate and operationally simpler |
| Email notifications | No email infrastructure in the home lab; the guest model means most users have no account email anyway |
| Refresh tokens | 7-day JWT expiry with password-change invalidation covers the risk window for this use case |

---

## Operations

### First Run

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET, GUEST_PIN, OWNER_SEED_PASSWORD
make deploy
```

On first boot the server seeds the owner account using `OWNER_SEED_PASSWORD`. After the container is running:

1. Log in with the owner email and the seed password
2. **Profile → Change Password** to rotate it out
3. Update `OWNER_SEED_PASSWORD` in `.env` to any value — it is ignored once the account exists

`OWNER_SEED_PASSWORD` is validated at startup. The server refuses to start without it, preventing silent failures from an incomplete `.env`.

### Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `JWT_SECRET` | Yes | Min 32 characters. Generate: `openssl rand -hex 32` |
| `GUEST_PIN` | Yes | Shared family PIN for guest access |
| `OWNER_SEED_PASSWORD` | Yes | Used only on first boot to seed the owner account |
| `DB_PATH` | No | Defaults to `/app/data/registry.db` |
| `PORT` | No | Defaults to `3000` |
| `NODE_ENV` | No | Set to `production` for JSON-only logging |

### Guest PIN Rotation

No rebuild required:

```bash
# Edit .env — update GUEST_PIN
docker compose restart drep
```

The new PIN hash is generated in memory on startup.

### Database Backup and Restore

**Via the UI (owner only):** Admin panel → Download Backup.

**Via CLI:**

```bash
curl -H "Authorization: Bearer <owner-token>" \
  https://<your-domain>/api/admin/backup \
  -o backup-$(date +%F).db
```

**Restore:**

```bash
docker compose down
cp backup-2026-05-07.db /var/lib/docker/volumes/drep-data/_data/registry.db
docker compose up -d
```

Because the database is a single file, restore is a file copy. No dump or restore tooling is required.

### Logs

Structured JSON logs are written to `/app/data/logs/app.log` (persisted via the named volume). winston handles rotation: 10 MB per file, 5 files retained.

```bash
make logs                                                    # tail live container output
docker exec drep tail -50 /app/data/logs/app.log # JSON log file directly
```

### Container Health

```bash
make health   # curl GET /health → {"status":"ok"}
make status   # docker ps + docker stats
```

The Compose healthcheck polls `/health` every 30 seconds. The container is marked unhealthy after 3 consecutive failures.

### Nginx Reverse Proxy

If running behind nginx on the same host:

```nginx
location / {
    proxy_pass         http://localhost:3100;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

The Express app is configured with `trust proxy: 1`, so rate limiting and IP logging work correctly behind a single proxy hop.

### Makefile Reference

```bash
make deploy   # build image (fast, no audit) + start
make audit    # build with npm audit gate (blocks on high/critical) + start
make up       # start without rebuilding
make down     # stop and remove container
make restart  # restart without rebuild
make logs     # tail live container logs
make health   # check /health endpoint
make status   # container state + resource usage
make shell    # exec into running container
```

---

## Project Structure

```text
drep/
├── server.js          # Express app: all routes, middleware, DB logic
├── public/
│   ├── index.html     # Single-page app shell
│   ├── app.js         # Client-side logic (vanilla JS, no framework)
│   └── style.css      # All styles
├── data/              # Persisted via Docker named volume
│   ├── registry.db    # SQLite database
│   └── logs/
│       └── app.log    # Structured JSON application logs
├── entrypoint.sh      # Volume ownership fix + privilege drop to appuser
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── package.json
└── .env.example
```

---

## Engineering Notes

This project started because the problem was real and recurring, and because every existing solution — shared spreadsheets, messaging threads, third-party food preference apps — required trusting a third party with family health information, or chasing people across platforms before every gathering.

The constraint of deploying on a home-lab NAS with no cloud spend and no tolerance for operational complexity shaped the architecture better than an unconstrained greenfield would have. SQLite is the right database here — not because it scales, but because it does not need to. Vanilla JS is the right frontend here — not because frameworks are bad, but because a build pipeline is an operational liability that this project does not need. Cloudflare Tunnel is the right edge layer here — not because it is the only option, but because the alternative involves exposing a home IP address.

Security was applied at the layer where it matters: rate limiting and header hardening at the application layer, TLS and DDoS mitigation at the edge, input validation at the route handler, and process isolation at the container level. Each control addresses a specific, named threat. No security theatre.

The project went from concept to production-deployed and in active use in a short iteration cycle, with a single person acting as architect, developer, operator, and primary user. The only success metric that mattered at the end of that cycle was whether the family was actually using it before the next gathering.

They were.

---

*Built by [Andrew Yeo (thegeekybeng)](https://github.com/thegeekybeng) · Singapore*
