## Summary

<!-- One paragraph: what this PR does and why. Link to the issue it resolves. -->

Closes #

---

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] Security fix

---

## Security checklist

_Required for any PR touching `server.js`, database queries, authentication, or HTTP handling._

- [ ] All SQL queries use parameterised statements — no string interpolation
- [ ] User-supplied text is HTML-stripped before database insertion
- [ ] Email inputs validated via `validator.js` before DB operation
- [ ] Image URLs validated against the server-side allowlist
- [ ] JWT verification uses explicit `{ algorithms: ['HS256'] }` enforcement
- [ ] Any auth route uses timing-safe comparison (bcrypt always runs)
- [ ] Role-gated routes enforced server-side, not just hidden client-side
- [ ] Public share endpoint returns aggregate counts only — no member PII
- [ ] `npm audit --audit-level=high` passes
- [ ] N/A — this PR does not touch auth, DB queries, or security controls

---

## Testing

<!-- How was this tested? Include commands or screenshots. -->

---

## Breaking changes

- [ ] No breaking changes
- [ ] Yes — describe below (env vars, DB schema, API contracts, Docker config):

---

## Documentation

- [ ] README updated if behaviour changed
- [ ] No documentation changes needed
