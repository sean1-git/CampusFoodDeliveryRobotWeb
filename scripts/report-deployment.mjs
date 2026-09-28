import { pathToFileURL } from 'node:url';

export const CHECK_NAME = 'cloudrun-projectdemo-europe-west1-sean1-git-CampusFoodDelivecnv (projectdemo-509505)';
export const CHECK_APP = 'google-cloud-developer-connect';
export const ENVIRONMENT = 'Production';
export const ENVIRONMENT_URL = 'https://projectdemo-qf2f7jkpma-ew.a.run.app/';
const SOURCE = 'cloud-build-observer';
const BUILD_LIST_URL = 'https://console.cloud.google.com/cloud-build/builds?project=projectdemo-509505';

export function selectTrustedCheck(checks, sha) {
  return checks
    .filter((check) => check.name === CHECK_NAME && check.app?.slug === CHECK_APP && check.head_sha === sha)
    .sort((left, right) => right.id - left.id)[0];
}

export function checkState(check) {
  if (!check || check.status === 'queued') return 'queued';
  if (check.status !== 'completed') return 'in_progress';
  if (check.conclusion === 'success') return 'success';
  return ['failure', 'timed_out'].includes(check.conclusion) ? 'failure' : 'error';
}

export function buildLogUrl(check) {
  try {
    const url = new URL(check?.details_url);
    if (url.protocol === 'https:' && url.hostname === 'console.cloud.google.com' && !url.username && !url.password
      && url.pathname.startsWith('/cloud-build/builds')
      && ['projectdemo-509505', '250283665537'].includes(url.searchParams.get('project'))) return url.href;
  } catch { /* Missing links use the project's build history. */ }
  return BUILD_LIST_URL;
}

export function createGitHubClient(token, fetchImpl = fetch) {
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed (${response.status}).`);
    return response.json();
  };
}

// This only mirrors Google's result; it never builds, deploys, or receives cloud credentials.
export async function reportDeployment({ repository, sha, api, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log,
  timeoutMs = 15 * 60_000, pollMs = 15_000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw new Error('A repository and exact 40-character commit SHA are required.');
  }
  if (!(timeoutMs > 0 && pollMs > 0)) throw new Error('Polling durations must be positive.');
  const base = `/repos/${repository}`;
  const deadline = now() + timeoutMs;
  let deployment;
  let previousState;
  let check;

  async function list(path, key) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const response = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? response[key] : response;
      items.push(...batch);
      if (batch.length < 100) return items;
      if (now() >= deadline) throw new Error('Timed out while reading GitHub results.');
    }
  }

  async function publish(state, description) {
    if (!deployment || previousState === state) return;
    // An observer retry cannot undo a deployment that Google already confirmed.
    if (previousState === 'success' && state !== 'inactive') return;
    await api(`${base}/deployments/${deployment.id}/statuses`, { method: 'POST', body: {
      state, description, environment: ENVIRONMENT, environment_url: ENVIRONMENT_URL,
      log_url: buildLogUrl(check), auto_inactive: false,
    } });
    previousState = state;
    log(`${sha.slice(0, 7)}: ${description}`);
  }

  async function isCurrent() {
    const head = await api(`${base}/commits/main`);
    if (head.sha === sha) return true;
    await publish('inactive', 'Superseded by a newer main commit; no deployment success reported.');
    return false;
  }

  async function retirePrevious() {
    const records = await list(`${base}/deployments?environment=${ENVIRONMENT}`);
    for (const record of records) {
      if (record.id === deployment.id || record.payload?.source !== SOURCE) continue;
      const statuses = await api(`${base}/deployments/${record.id}/statuses?per_page=1`);
      if (statuses[0]?.state !== 'success') continue;
      await api(`${base}/deployments/${record.id}/statuses`, { method: 'POST', body: {
        state: 'inactive', environment: ENVIRONMENT, auto_inactive: false,
        description: `Replaced by the confirmed deployment of ${sha.slice(0, 7)}.`,
      } });
    }
  }

  try {
    if (!await isCurrent()) return { state: 'superseded' };
    const existing = await list(`${base}/deployments?sha=${sha}&environment=${ENVIRONMENT}`);
    deployment = existing.find((item) => item.sha === sha && item.payload?.source === SOURCE);
    if (deployment) {
      const statuses = await api(`${base}/deployments/${deployment.id}/statuses?per_page=1`);
      previousState = statuses[0]?.state;
    } else {
      deployment = await api(`${base}/deployments`, { method: 'POST', body: {
        ref: sha, auto_merge: false, required_contexts: [], environment: ENVIRONMENT,
        production_environment: true, transient_environment: false,
        description: 'Observe the existing Cloud Build deployment to Cloud Run.',
        payload: { source: SOURCE, service: 'projectdemo', project: 'projectdemo-509505' },
      } });
    }

    while (now() < deadline) {
      if (!await isCurrent()) return { state: 'superseded', deploymentId: deployment.id };
      check = selectTrustedCheck(await list(`${base}/commits/${sha}/check-runs?filter=latest`, 'check_runs'), sha);
      if (now() >= deadline) break;
      const state = checkState(check);
      if (state === 'success') {
        // Recheck immediately before publishing: an old build must not replace the current deployment.
        if (!await isCurrent()) return { state: 'superseded', deploymentId: deployment.id };
        await publish('success', `Cloud Build check ${check.id} deployed this commit to Cloud Run.`);
        await retirePrevious();
        return { state, deploymentId: deployment.id, checkId: check.id };
      }
      if (state === 'failure' || state === 'error') {
        await publish(state, `Cloud Build check ${check.id} finished with ${check.conclusion ?? 'no conclusion'}.`);
        return { state, deploymentId: deployment.id, checkId: check.id };
      }
      // A rerun of the observer must not turn a confirmed success back into a pending status.
      if (previousState !== 'success') {
        await publish(state, check ? `Waiting for Cloud Build check ${check.id}.` : 'Waiting for the Cloud Build deployment check.');
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    await publish('error', 'Timed out waiting for Cloud Build; deployment success was not confirmed.');
    return { state: 'timeout', deploymentId: deployment.id };
  } catch (error) {
    try { await publish('error', 'Could not verify the Cloud Build deployment; see the observer workflow log.'); }
    catch { /* Preserve the original API error if status reporting also fails. */ }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await reportDeployment({
      repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
      api: createGitHubClient(process.env.GITHUB_TOKEN),
    });
    console.log(`Deployment observer: ${result.state}.`);
    if (!['success', 'superseded'].includes(result.state)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
