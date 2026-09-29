import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_APP, CHECK_NAME, ENVIRONMENT_URL, buildLogUrl, createGitHubClient,
  reportDeployment, selectTrustedCheck } from '../../tooling/deploy/report-deployment.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const LOG_URL = 'https://console.cloud.google.com/cloud-build/builds;region=europe-west1/95ee6be0-28d0-411a-8b99-6bc2f0fd5f9d?project=250283665537';
const makeCheck = (overrides = {}) => ({ id: 123, name: CHECK_NAME, app: { slug: CHECK_APP },
  head_sha: SHA, status: 'completed', conclusion: 'success', details_url: LOG_URL, ...overrides });

function fixture({ checks = [makeCheck()], existing = [], prior = [], initialState, moveMainOnRead = Infinity,
  failureOnCheck = false } = {}) {
  const requests = [];
  const statuses = [];
  let clock = 0;
  let headReads = 0;
  let checkReads = 0;
  const options = {
    repository: 'sean1-git/uc-merced-campus-store', sha: SHA, now: () => clock,
    sleep: async (ms) => { clock += ms; }, log: () => {}, timeoutMs: 30, pollMs: 10,
    api: async (path, request = {}) => {
      requests.push({ path, ...request });
      if (path.endsWith('/commits/main')) return { sha: ++headReads >= moveMainOnRead ? OTHER_SHA : SHA };
      if (path.includes('/check-runs?')) {
        if (failureOnCheck) throw new Error('Simulated API outage');
        checkReads += 1;
        return { check_runs: typeof checks === 'function' ? checks(checkReads) : checks };
      }
      if (path.includes('/deployments?')) return path.includes('sha=') ? existing : [...existing, ...prior];
      if (path.endsWith('/deployments')) return { id: 456, sha: SHA };
      if (path.endsWith('/statuses?per_page=1')) {
        const state = prior.find((record) => path.includes(`/deployments/${record.id}/`))?.latestState ?? initialState;
        return state ? [{ state }] : [];
      }
      if (path.endsWith('/statuses') && request.method === 'POST') {
        statuses.push(request.body);
        return { id: statuses.length, ...request.body };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  return { options, requests, statuses };
}

test('only the primary Google check for the exact commit can establish success', () => {
  const trusted = makeCheck();
  const candidates = [
    makeCheck({ id: 999, name: 'cloudrun-projectdemo1-secondary' }),
    makeCheck({ id: 998, app: { slug: 'github-actions' } }),
    makeCheck({ id: 997, head_sha: OTHER_SHA }), trusted,
  ];
  assert.equal(selectTrustedCheck(candidates, SHA), trusted);
  assert.equal(selectTrustedCheck(candidates.slice(0, 3), SHA), undefined);
  assert.equal(selectTrustedCheck([trusted, makeCheck({ id: 124, conclusion: 'failure' })], SHA).id, 124);
});

test('observes queued and running states before reporting exact-SHA success with useful links', async () => {
  const f = fixture({ checks: (read) => read === 1 ? [] : [makeCheck({ status: read === 2 ? 'in_progress' : 'completed' })] });
  const result = await reportDeployment(f.options);
  assert.equal(result.state, 'success');
  assert.deepEqual(f.statuses.map(({ state }) => state), ['queued', 'in_progress', 'success']);
  const creation = f.requests.find(({ path }) => path.endsWith('/deployments')).body;
  assert.equal(creation.ref, SHA);
  assert.equal(creation.environment, 'Production');
  assert.equal(creation.auto_merge, false);
  assert.deepEqual(creation.required_contexts, []);
  assert.equal(f.statuses.at(-1).environment_url, ENVIRONMENT_URL);
  assert.equal(f.statuses.at(-1).log_url, LOG_URL);
});

test('failed, cancelled and timed-out checks never produce a successful deployment', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    const f = fixture({ checks: [makeCheck({ conclusion })] });
    const result = await reportDeployment(f.options);
    assert.ok(['failure', 'error'].includes(result.state));
    assert.equal(f.statuses.some(({ state }) => state === 'success'), false);
  }
});

test('a missing primary check times out even when the secondary service succeeds', async () => {
  const f = fixture({ checks: [makeCheck({ name: 'cloudrun-projectdemo1-secondary' })] });
  assert.equal((await reportDeployment(f.options)).state, 'timeout');
  assert.deepEqual(f.statuses.map(({ state }) => state), ['queued', 'error']);
});

test('a superseded commit cannot activate a deployment, including during the final success check', async () => {
  const stale = fixture({ moveMainOnRead: 1 });
  assert.equal((await reportDeployment(stale.options)).state, 'superseded');
  assert.equal(stale.requests.some(({ method }) => method === 'POST'), false);

  const superseded = fixture({ moveMainOnRead: 3 });
  assert.equal((await reportDeployment(superseded.options)).state, 'superseded');
  assert.deepEqual(superseded.statuses.map(({ state }) => state), ['inactive']);
});

test('retry reuses its deployment and does not append duplicate successful statuses', async () => {
  const existing = [{ id: 456, sha: SHA, payload: { source: 'cloud-build-observer' } }];
  const f = fixture({ existing, initialState: 'success' });
  const result = await reportDeployment(f.options);
  assert.equal(result.state, 'success');
  assert.equal(result.deploymentId, 456);
  assert.equal(f.requests.some(({ path, method }) => method === 'POST' && path.endsWith('/deployments')), false);
  assert.deepEqual(f.statuses, []);
});

test('a later successful commit retires only earlier observer-owned successes', async () => {
  const f = fixture({ prior: [
    { id: 111, sha: OTHER_SHA, payload: { source: 'cloud-build-observer' }, latestState: 'success' },
    { id: 112, sha: OTHER_SHA, payload: { source: 'manual-bootstrap' }, latestState: 'success' },
    { id: 113, sha: OTHER_SHA, payload: { source: 'cloud-build-observer' }, latestState: 'failure' },
  ] });
  assert.equal((await reportDeployment(f.options)).state, 'success');
  const retired = f.requests.filter(({ body }) => body?.state === 'inactive');
  assert.equal(retired.length, 1);
  assert.match(retired[0].path, /\/deployments\/111\/statuses$/);
  assert.deepEqual(f.statuses.map(({ state }) => state), ['success', 'inactive']);
});

test('observer retry failures preserve a previously confirmed successful deployment', async () => {
  const existing = [{ id: 456, sha: SHA, payload: { source: 'cloud-build-observer' } }];
  const missingCheck = fixture({ existing, initialState: 'success', checks: [] });
  assert.equal((await reportDeployment(missingCheck.options)).state, 'timeout');
  assert.deepEqual(missingCheck.statuses, []);
  const apiError = fixture({ existing, initialState: 'success', failureOnCheck: true });
  await assert.rejects(reportDeployment(apiError.options), /Simulated API outage/);
  assert.deepEqual(apiError.statuses, []);
});

test('an API error is surfaced and marks the observation as unverified', async () => {
  const f = fixture({ failureOnCheck: true });
  await assert.rejects(reportDeployment(f.options), /Simulated API outage/);
  assert.deepEqual(f.statuses.map(({ state }) => state), ['error']);
});

test('rejects symbolic or malformed commits before any requests', async () => {
  for (const sha of ['main', `${SHA}/check-runs`, '', 'a'.repeat(39)]) {
    const f = fixture();
    await assert.rejects(reportDeployment({ ...f.options, sha }), /exact 40-character/);
    assert.deepEqual(f.requests, []);
  }
});

test('untrusted log destinations cannot become the environment log link', () => {
  assert.equal(buildLogUrl(makeCheck()), LOG_URL);
  const fallback = 'https://console.cloud.google.com/cloud-build/builds?project=projectdemo-509505';
  for (const details_url of ['https://evil.test', LOG_URL.replace('250283665537', 'another-project'),
    LOG_URL.replace('console.cloud.google.com', 'username:password@console.cloud.google.com'),
    'http://console.cloud.google.com/cloud-build/builds?project=250283665537']) {
    assert.equal(buildLogUrl(makeCheck({ details_url })), fallback);
  }
});

test('GitHub client scopes the token to the API and does not expose response bodies on error', async () => {
  let request;
  const api = createGitHubClient('test-token', async (url, options) => {
    request = { url, options };
    return { ok: false, status: 403, json: () => ({ message: 'private response' }) };
  });
  await assert.rejects(api('/repos/example/repository'), /^Error: GitHub API GET .*failed \(403\)\.$/);
  assert.equal(request.url, 'https://api.github.com/repos/example/repository');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
});
