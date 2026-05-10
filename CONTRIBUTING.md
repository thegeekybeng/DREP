# Contributing to DREP

DREP is a self-hosted family dietary registry. Contributions that improve reliability, security, or usability for private family deployments are welcome.

## Before You Start

- Check the [open issues](../../issues) to avoid duplicating work
- For significant changes, open an issue first to discuss the approach
- DREP is intentionally simple — no frontend framework, no build pipeline. Keep it that way unless there is a compelling reason

## Development Setup

### Prerequisites

- Docker and Docker Compose, or Node.js 20+ for local dev
- SQLite (bundled via `better-sqlite3`)

### Local run

```bash
cp .env.example .env
# Edit .env — set JWT_SECRET, GUEST_PIN, OWNER_SEED_PASSWORD

# Option 1: Docker
make deploy

# Option 2: Direct Node
npm install
node server.js
```

App runs at `http://localhost:3000`.

On first boot, log in with the owner email and `OWNER_SEED_PASSWORD`, then change the password immediately.

## Contribution Guidelines

### Code style

- Vanilla JS only — no frontend frameworks, no build step
- All SQLite queries must use parameterised statements; no string concatenation in SQL
- Input validated and HTML-stripped before any DB write
- Comments explain **why**, not what — remove commented-out code before submitting

### Security — mandatory checks before any PR

Every PR that touches authentication, database queries, or HTTP handling must confirm:

- [ ] All SQL queries use parameterised statements — no string interpolation
- [ ] User-supplied text is HTML-stripped before database insertion
- [ ] Email inputs are format-validated via `validator.js` before any DB operation
- [ ] Image URLs validated against the server-side allowlist (not just frontend)
- [ ] JWT verification uses `{ algorithms: ['HS256'] }` explicit enforcement
- [ ] Any new auth route includes timing-safe comparison (bcrypt always runs against real or dummy hash)
- [ ] New role-gated routes include middleware enforcement — not just client-side hiding
- [ ] `npm audit --audit-level=high` passes

These are merge blockers.

### Commits

Follow conventional commits:

```
feat: add generation filter to event dietary summary
fix: prevent guest PIN enumeration via timing
docs: update backup restore procedure
refactor: extract share token generation to util
```

First line: imperative mood, 50 characters max. No period at the end.

### Branch naming

```
feature/event-dietary-summary
fix/guest-pin-timing
docs/backup-restore
```

## Pull Request Process

1. Fork the repository and create your branch from `master`
2. Run `npm audit --audit-level=high` and fix any high or critical CVEs
3. Fill in the pull request template completely
4. Link the issue your PR resolves with `Closes #123`

## What Will Not Be Merged

- SQL queries built via string concatenation
- Frontend-only access control (server-side enforcement is the rule)
- Changes that expose member PII via the public share endpoint
- New npm dependencies without documented justification — the low dependency count is intentional
- Frontend framework introductions

## Questions

Open a [Discussion](../../discussions) for questions that are not bug reports or feature requests.
