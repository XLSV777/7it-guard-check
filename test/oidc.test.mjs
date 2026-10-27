import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, runAction, passResult } from './helpers.mjs';
import { OIDC_AUDIENCE, NO_TOKEN_NOTICE, getIdToken } from '../src/index.mjs';

const SITE = 'https://example.com';
const VERIFY = { path: '/7it-verify.txt', content: 'tok\n7it-ghc-0123456789abcdef0123456789ab\n', hint: '' };

function withMock(opts, fn) {
  return async () => {
    const mock = await startMock(opts);
    try { await fn(mock); } finally { await mock.close(); }
  };
}

test('OIDC: with id-token: write the token is requested with our audience and sent as id_token', withMock({}, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE }, env: mock.oidcEnv });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(OIDC_AUDIENCE, '7it-guard-check');
  assert.equal(mock.state.oidcRequests.length, 1);
  const o = mock.state.oidcRequests[0];
  assert.equal(o.audience, '7it-guard-check');
  assert.match(o.query, /api-version=2\.0/, 'the runner query is kept');
  assert.equal(o.headers.authorization, 'Bearer runner-request-token');
  const { body } = mock.state.checkRequests[0];
  assert.match(body.id_token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.match(body.repo, /^[0-9a-f]{64}$/, 'the repository hash is still sent (the server checks it matches the token)');
  assert.ok(!r.stdout.includes(body.id_token), 'the token never appears in the log');
  assert.ok(!r.stdout.includes(NO_TOKEN_NOTICE.slice(0, 40)));
}));

test('OIDC: no permission = reduced mode with a clear notice, the check still runs', withMock({}, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.checkRequests.length, 1);
  assert.equal(mock.state.checkRequests[0].body.id_token, undefined);
  assert.match(r.stdout, /::notice title=7IT Guard::.*id-token: write/);
  assert.equal(r.outputs.status, 'pass');
}));

test('OIDC: a pull request from a fork gets no token and no notice (expected there)', withMock({}, async (mock) => {
  const event = { repository: { fork: false }, pull_request: { number: 4, head: { sha: 'abc1234', repo: { full_name: 'stranger/web', fork: true } } } };
  const r = await runAction(mock, { inputs: { site: SITE }, eventName: 'pull_request', event, env: { GITHUB_TOKEN: '' } });
  assert.equal(r.code, 0);
  assert.ok(!/id-token: write/.test(r.stdout.split('\n').filter((l) => l.startsWith('::notice')).join('\n')));
}));

test('OIDC: the runner refusing the token is reduced mode, never a failure', withMock({ github: { oidcStatus: 500 } }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE }, env: mock.oidcEnv });
  assert.equal(r.code, 0);
  assert.equal(mock.state.checkRequests[0].body.id_token, undefined);
  assert.match(r.stdout, /id-token: write/);
}));

test('OIDC: a malformed runner answer is not sent', async () => {
  const fake = async () => new Response(JSON.stringify({ value: 'not a jwt' }), { status: 200 });
  const r = await getIdToken({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://runner.example/x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' }, fake);
  assert.deepEqual(r, { token: '', reason: 'bad-answer' });
  assert.equal((await getIdToken({}, fake)).reason, 'no-permission');
});

test('OIDC: server requires the token (401 need_id_token) = skipped with the message, exit 0', withMock({ check: () => ({ status: 401, json: { ok: false, error: 'need_id_token', need_id_token: true, message_md: '### 7IT Guard\n\nThis check needs the GitHub identity token. Add `id-token: write`.' } }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE, 'on-problem': 'block' } });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, 'skipped');
  assert.match(r.stdout, /needs the GitHub identity token/);
  assert.match(r.summary, /id-token: write/);
}));

test('OIDC: server rejects the token (401 bad_id_token) = skipped, exit 0', withMock({ check: () => ({ status: 401, json: { ok: false, error: 'bad_id_token', message_md: '### 7IT Guard\n\nThe token could not be confirmed.' } }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE, 'on-problem': 'block' }, env: mock.oidcEnv });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, 'skipped');
  assert.match(r.stdout, /could not confirm this repository/);
}));

test('OIDC: repo_verified false = no ownership pull request, the summary says to add id-token: write', withMock({ github: { dirs: ['public'] }, check: () => ({ status: 200, json: passResult({ status: 'warn', verify: VERIFY, repo_verified: false }) }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE }, event: { repository: { fork: false, default_branch: 'main' } } });
  assert.equal(r.code, 0);
  assert.ok(!mock.state.githubRequests.some((x) => x.method === 'POST' && /\/pulls$/.test(x.path)), 'no pull request opened');
  assert.match(r.summary, /add `id-token: write` under `permissions:` in the workflow first/);
}));

test('OIDC: repo_verified true = the ownership pull request as before', withMock({ github: { dirs: ['public'] }, check: () => ({ status: 200, json: passResult({ status: 'warn', verify: VERIFY, repo_verified: true }) }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE }, event: { repository: { fork: false, default_branch: 'main' } }, env: mock.oidcEnv });
  assert.equal(r.code, 0);
  assert.ok(mock.state.githubRequests.some((x) => x.method === 'POST' && /\/pulls$/.test(x.path)), 'pull request opened');
}));
