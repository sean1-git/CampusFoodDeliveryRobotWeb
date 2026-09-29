# Deployment

## Custom domain

`ucmcampusstore.com` is mapped to the `projectdemo` Cloud Run service in
`europe-west1`. Domain mapping uses a Google-managed certificate; DNS being
configured does not mean HTTPS is ready. Check that the mapping reports
`Ready=True` and the HTTPS site loads before sharing the new address.

In Namecheap **Advanced DNS → Host Records**, the apex uses these records returned
by this Cloud Run mapping. Each row is a separate record with host `@` and
Automatic TTL:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `216.239.32.21` |
| A | `@` | `216.239.34.21` |
| A | `@` | `216.239.36.21` |
| A | `@` | `216.239.38.21` |
| AAAA | `@` | `2001:4860:4802:32::15` |
| AAAA | `@` | `2001:4860:4802:34::15` |
| AAAA | `@` | `2001:4860:4802:36::15` |
| AAAA | `@` | `2001:4860:4802:38::15` |

Replace conflicting apex parking or URL Redirect records; keep verification TXT,
SPF, and MX records. Namecheap redirects can create an
[implicit A record](https://www.namecheap.com/support/knowledgebase/article.aspx/385/2237/how-to-set-up-a-url-redirect-for-a-domain/)
that disappears when the redirect is removed. `www` requires its own mapping and
DNS record. If CAA restrictions are added, allow both `pki.goog` and
`letsencrypt.org`.

For application access, use `https://ucmcampusstore.com` as `CANONICAL_ORIGIN` or
add it to `ALLOWED_ORIGINS`. Keep both existing origins allowed:

- `https://projectdemo-qf2f7jkpma-ew.a.run.app`
- `https://projectdemo-250283665537.europe-west1.run.app`

Add `https://ucmcampusstore.com/*` to the Maps browser key's website restrictions,
preserving both existing `run.app` entries and the Maps JavaScript API restriction.
Native builds still default to the second `run.app` origin; changing DNS does not
change installed apps. Cookies, saved bags, and PWA installations are separate
for each origin, so a browser visiting the new domain starts a separate demo session.

[Cloud Run domain mapping](https://docs.cloud.google.com/run/docs/mapping-custom-domains)
is a preview feature suitable for this demo; Google does not recommend it for
production services. An external Application Load Balancer is the production
option to consider as the project grows.

## Docker packaging

The Dockerfile builds the frontend, then copies its output and the Node API into a
runtime image. Shop photos and other files in `public/` are included in
`dist/client`; `assets/app-logo.png` generates the smaller app icons during the
build. Original artwork, build dependencies, tests, and documentation stay out
of the runtime image. Explicit build inputs also let backend-only changes reuse
the frontend build cache.

The runtime uses the unprivileged `node` user. Application files remain root-owned;
the local `.data` directory is writable for SQLite. Credentials stay outside the
image in runtime configuration. See [Security](../SECURITY.md) for key restrictions
and the demo's per-process abuse limits.

This suits the demo's fixed images and makes each release self-contained. Docker
does not make image downloads smaller; the existing optimized assets, compression,
and PWA cache handle that. Future uploads and frequently changing product photos
should use object storage, optionally behind a CDN, so they can change without
rebuilding the app. Files written inside a Cloud Run container are
[temporary](https://docs.cloud.google.com/run/docs/container-contract#file_system).

## Traffic and live updates

The Node server exposes `/api/events` as an authenticated Server-Sent Events
stream. It sends account-specific invalidations after checkout mutations and at
the saved simulation's pickup and delivery times. A connected browser fetches a
fresh wallet/order snapshot on a change or reconnect; heartbeat messages do not
trigger database snapshots. Timers schedule simulation transitions instead of
repeatedly querying order state. This still represents simulated robot movement.

Streams pause when the page is hidden or offline, rotate after four minutes, and
reconnect with bounded backoff. Checkout recovery retains its five-second checks;
the native app, unsupported hosts, and failed streams use polling as a fallback.
Inventory keeps its fifteen-minute freshness policy. Session cookies scope every
stream to its account, expired sessions close the stream, and account/API data
remains `no-store`.

The demo limits streams to four per account and 32 per process, leaving room for
checkout within the current Cloud Run concurrency limit of 80. Its event hub is
local to one process. Before adding instances, move to a shared database and a
shared event broker. Long-lived streams consume request capacity and billable
time; fewer HTTP requests alone do not guarantee lower hosting costs.

Static responses use ETags and return `304 Not Modified` for unchanged files.
Fingerprinted assets keep their long cache lifetime; HTML, icons, and shop photos
revalidate so new deployments can replace them safely. A bounded 8 MiB file cache
avoids repeated disk reads, while the PWA cache continues to support offline use.
These changes optimize the existing Cloud Run hosting. A CDN and object storage
are still future infrastructure, not part of this deployment.

References: [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events),
[Cloud Run request timeouts](https://docs.cloud.google.com/run/docs/configuring/request-timeout),
[Cloud CDN with Cloud Run](https://docs.cloud.google.com/cdn/docs/setting-up-cdn-with-serverless).

## Deployment reporting

Google Cloud Build builds this repository and deploys Cloud Run. The GitHub workflow
`deployment-status.yml` only records that existing result in the `Production`
environment, with a link to the app and Google's build log. It does not deploy a
second copy or need Google Cloud credentials.

View the public [deployment reports](https://github.com/sean1-git/uc-merced-campus-store/actions/workflows/deployment-status.yml)
or the [Production history](https://github.com/sean1-git/uc-merced-campus-store/deployments/activity_log?environments_filter=Production).
GitHub may require sign-in to view its deployment history; the reports and live app
remain accessible without signing in.

The observer runs on pushes to `main` and through **Actions → Report Cloud Run
deployment → Run workflow**. It waits up to 15 minutes for the exact commit's
`cloudrun-projectdemo-europe-west1-sean1-git-CampusFoodDelivecnv (projectdemo-509505)`
check from the `google-cloud-developer-connect` app. The `projectdemo1` check is
deliberately excluded. The original trigger name remains valid after the
repository rename.

Only a successful primary deployment check produces a successful GitHub
deployment. Failures, missing checks, API errors, and timeouts do not. The observer
exits when a newer commit reaches `main`; manual runs must target `main`. Retrying
the workflow reuses its deployment record for the same commit. An observer-only
failure never overwrites an already-confirmed success. After a successful report,
earlier successful records created by this observer become inactive; manually
created records are left alone. Reports are serialized to prevent overlapping
observers.

The workflow uses the repository's short-lived `GITHUB_TOKEN`, with only contents
and checks read access plus deployment write access. It checks out the reporting
script without persisting credentials and installs no packages. GitHub reports
Google's result; it does not independently verify which revision currently receives
Cloud Run traffic. Changes made directly in Cloud Run are not reported here.

If reporting fails, inspect the workflow log and the linked Cloud Build result.
After fixing a connection, trigger, or reporting problem, rerun the observer on
the current `main` commit. If the Cloud Build trigger/check name changes, update
`CHECK_NAME` in `scripts/report-deployment.mjs` to the verified primary check.

When renaming the repository, update the Cloud Build triggers and their connected
repository reference as well as the git remote. GitHub redirects git operations,
but Cloud Build does not follow repository renames automatically.

References: [Cloud Build triggers](https://docs.cloud.google.com/build/docs/automating-builds/create-manage-triggers),
[GitHub deployments](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment),
[deployment statuses](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status).
