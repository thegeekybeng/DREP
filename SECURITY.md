# Security Policy

## Scope

DREP is a **self-hosted family application**. Security reports are welcomed for:

- Authentication and session vulnerabilities (JWT, bcrypt, timing attacks)
- Privilege escalation between the role hierarchy (owner → admin → member → guest → pending)
- SQL injection or parameterised query bypasses
- Input validation gaps (email, text fields, image URLs)
- Share link token weaknesses (generation, comparison, expiry, revocation)
- HTTP security header misconfigurations
- Container escape or privilege escalation
- Information disclosure via the public share endpoint (member PII leaking)

## Reporting a Vulnerability

**Use GitHub's Private Vulnerability Reporting.** Do not open a public issue for security vulnerabilities.

1. Go to the [Security tab](../../security) of this repository
2. Click **Report a vulnerability**
3. Describe the issue, reproduction steps, and potential impact

This keeps the report confidential until a fix is in place.

## Response Timeline

| Stage | Target |
|---|---|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix or workaround | Within 30 days for confirmed vulnerabilities |

## Out of Scope

- Vulnerabilities that require physical access to the NAS host
- Issues in Cloudflare Tunnel itself (report those to Cloudflare)
- Theoretical attacks with no demonstrated impact against the application
- Social engineering attacks against family members

## Disclosure Policy

Once a fix is released, the vulnerability will be disclosed publicly via a GitHub Security Advisory. Credit will be given to the reporter unless anonymity is requested.

## Important Note

DREP is designed for private family use and is not hardened for exposure to untrusted users at scale. If you are deploying this beyond a trusted family group, review the authentication model carefully — the shared guest PIN is intentionally simple and assumes a trusted audience.
