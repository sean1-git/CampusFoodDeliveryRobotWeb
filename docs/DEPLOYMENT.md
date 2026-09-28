# Deployment

## Docker packaging

The Dockerfile builds the frontend, then copies its output and the Node API into a
runtime image. Shop photos and other files in `public/` are included in
`dist/client`; `assets/app-logo.png` generates the smaller app icons during the
build. Original artwork, build dependencies, tests, and documentation stay out
of the runtime image. Explicit build inputs also let backend-only changes reuse
the frontend build cache.

This suits the demo's fixed images and makes each release self-contained. Docker
does not make image downloads smaller; the existing optimized assets, compression,
and PWA cache handle that. Future uploads and frequently changing product photos
should use object storage, optionally behind a CDN, so they can change without
rebuilding the app. Files written inside a Cloud Run container are
[temporary](https://docs.cloud.google.com/run/docs/container-contract#file_system).

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
