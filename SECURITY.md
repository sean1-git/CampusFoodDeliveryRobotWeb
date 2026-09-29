# Security

Report vulnerabilities through [GitHub private reporting](https://github.com/sean1-git/uc-merced-campus-store/security/advisories/new). Include reproduction steps and affected versions; do not post credentials in public issues.

## Credentials and checks

Keep credentials in deployment settings or a secret manager. Never put secrets in `VITE_*` variables: those values become public browser code. Git and Docker ignore local environment files, private keys, and common credential exports. These patterns supplement review; they cannot recognize every filename.

The Google Maps JavaScript key is intentionally sent to the browser. Restrict it to the Maps JavaScript API and the exact deployed website referrers. It is separate from any private server credential.

GitHub secret scanning and push protection are enabled, along with Dependabot security updates and CodeQL. The security workflow runs a redacted [Gitleaks](https://github.com/gitleaks/gitleaks) history scan and audits locked dependencies on pushes and pull requests. Actions use pinned commits; the scanner download is checksum-verified. Its only project-specific exception is the exact public inventory-cache identifier in `apps/web/src/shared/state/inventoryCache.ts`.

Before pushing, run `gitleaks git --redact=100 --pre-commit --staged` with Gitleaks 8.30.1 and `npm audit`. If a real credential is exposed, revoke or rotate it first, then remove it from current files and coordinate any necessary history cleanup. Deleting a file alone does not revoke its credentials.

## Demo limits

Sessions use HttpOnly cookies; checkout checks origin, CSRF, account ownership, server-side stock, and idempotency. New anonymous sessions are limited to a burst of 60, replenishing one per second. New checkout IDs allow a burst of 20 per account, replenishing one every three seconds. Limits return `429` with `Retry-After`; existing checkout retries, confirmation, cancellation, and reads remain available.

These bounded limits are per process/database binding and reset on restart. They reduce bursts, but are not distributed rate limits or a lifetime limit on demo wallets. Before connecting real payments, school accounts, or robots, add shared rate limits, real identity checks, durable storage, and operational monitoring.

The Docker runtime runs as a non-root user; within `/app`, only its data directory is writable. Android disables account-data backups and limits file sharing to a dedicated private cache directory. Native configuration changes still require device testing before an app-store release.
