import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, runAction, passResult } from './helpers.mjs';
import { sanitizeVerify, isForkRun, VERIFY_BRANCH, OWNERSHIP_COMMIT, OWNERSHIP_MARKER } from '../src/index.mjs';

const SITE = 'https://example.com';
const VERIFY = { path: '.well-known/7it-guard.txt', content: '7it-guard-verify=abc123', hint: 'Questions: https://7it.co.il/guard/' };
const verifyCheck = () => ({ status: 200, json: passResult({ verify: VERIFY }) });
const pushEvent = { repository: { fork: false, default_branch: 'main' } };

function withMock(github, fn) {
  return async () => {
    const mock = await startMock({ check: verifyCheck, github });
    try { await fn(mock); } finally { await mock.close(); }
  };
}

const writes = (mock) => mock.state.githubRequests.filter((r) => r.method !== 'GET');

test('ownership PR: created once, then not duplicated', withMock({ dirs: ['public'] }, async (mock) => {
  const r1 = await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(mock.state.prs.length, 1);
  const pr = mock.state.prs[0];
  assert.equal(pr.head, VERIFY_BRANCH);
  assert.equal(pr.base, 'main');
  assert.equal(pr.title, '7IT Guard: prove you own example.com (one merge)');
  assert.match(pr.body, /no secret and nothing about your code/);
  assert.match(pr.body, /14-day 7IT Guard Pro trial/);
  assert.match(pr.body, /How to remove it/);
  assert.match(pr.body, /public\/\.well-known\/7it-guard\.txt/);
  assert.doesNotMatch(pr.body, /no `public\/` or `static\/` folder was found/);
  assert.ok(pr.body.includes(OWNERSHIP_MARKER));
  assert.equal(mock.state.lastPut.message, OWNERSHIP_COMMIT);
  assert.equal(mock.state.lastPut.branch, VERIFY_BRANCH);
  assert.equal(mock.state.files[VERIFY_BRANCH]['public/.well-known/7it-guard.txt'], VERIFY.content);
  assert.match(r1.summary, /opened a pull request/);
  assert.equal(r1.outputs['ownership-pr'], pr.html_url);

  const before = writes(mock).length;
  const r2 = await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
  assert.equal(r2.code, 0);
  assert.equal(mock.state.prs.length, 1, 'no duplicate PR');
  assert.equal(writes(mock).length, before, 'no new writes');
  assert.match(r2.summary, /ownership pull request is open/);
}));

test('ownership PR: a closed earlier PR means never again (once per repo)', withMock({ dirs: ['public'], prs: [{ number: 3, state: 'closed', head: VERIFY_BRANCH }] }, async (mock) => {
  const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.prs.length, 1);
  assert.equal(writes(mock).length, 0);
  assert.match(r.summary, /add a file to your site/);
}));

test('ownership PR: skipped when the file already exists with the same content', withMock({ dirs: ['public'], files: { 'public/.well-known/7it-guard.txt': VERIFY.content } }, async (mock) => {
  const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.prs.length, 0);
  assert.equal(writes(mock).length, 0);
  assert.match(r.summary, /is in the repository\. Deploy the site/);
}));

test('ownership PR: file with different content gets a PR', withMock({ dirs: ['public'], files: { 'public/.well-known/7it-guard.txt': 'old' } }, async (mock) => {
  await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
  assert.equal(mock.state.prs.length, 1);
  assert.equal(mock.state.lastPut.sha, 'sha-public/.well-known/7it-guard.txt');
}));

test('ownership PR: no write permission skips quietly and adds the manual step', withMock({ dirs: ['public'], canWrite: false }, async (mock) => {
  const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE }, env: mock.oidcEnv });
  assert.equal(r.code, 0);
  assert.equal(mock.state.prs.length, 0);
  assert.doesNotMatch(r.stdout, /::(warning|error|notice)/);
  assert.match(r.summary, /Prove you own example\.com \(one step\)/);
  assert.ok(r.summary.includes(VERIFY.content));
  assert.ok(r.summary.includes('/.well-known/7it-guard.txt'));
}));

test('ownership PR: no read permission skips quietly and adds the manual step', withMock({ dirs: ['public'], canRead: false }, async (mock) => {
  const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(writes(mock).length, 0);
  assert.match(r.summary, /one step/);
}));

test('ownership PR: no token adds the manual step without API calls', withMock({ dirs: ['public'] }, async (mock) => {
  const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE, 'github-token': '' } });
  assert.equal(mock.state.githubRequests.length, 0);
  assert.match(r.summary, /one step/);
}));

test('ownership PR: never on a fork repository', withMock({ dirs: ['public'] }, async (mock) => {
  const r = await runAction(mock, { event: { repository: { fork: true, default_branch: 'main' } }, inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.githubRequests.length, 0);
  assert.match(r.summary, /one step/);
}));

test('ownership PR: never on a pull_request from a fork', withMock({ dirs: ['public'] }, async (mock) => {
  const event = { repository: { fork: false, default_branch: 'main' }, pull_request: { number: 4, head: { sha: 'abc1234', repo: { full_name: 'stranger/web', fork: true } } } };
  const r = await runAction(mock, { eventName: 'pull_request', event, inputs: { site: SITE, comment: 'off' } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.githubRequests.length, 0);
  assert.equal(mock.state.prs.length, 0);
}));

test('ownership PR: allowed on a pull_request from the same repo', withMock({ dirs: ['public'] }, async (mock) => {
  const event = { repository: { fork: false, default_branch: 'main' }, pull_request: { number: 4, head: { sha: 'abc1234', repo: { full_name: 'acme/web', fork: false } } } };
  await runAction(mock, { eventName: 'pull_request', event, inputs: { site: SITE, comment: 'off' } });
  assert.equal(mock.state.prs.length, 1);
}));

test('ownership PR: off mode makes no calls and adds the manual step', withMock({ dirs: ['public'] }, async (mock) => {
  const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE, 'ownership-pr': 'off' } });
  assert.equal(mock.state.githubRequests.length, 0);
  assert.match(r.summary, /one step/);
}));

test('ownership PR: nothing happens when the server sends no verify', async () => {
  const mock = await startMock({ github: { dirs: ['public'] } });
  try {
    const r = await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
    assert.equal(mock.state.githubRequests.length, 0);
    assert.doesNotMatch(r.summary, /Prove you own/);
  } finally { await mock.close(); }
});

test('ownership PR: default branch fetched when the event lacks it', withMock({ dirs: ['public'], defaultBranch: 'trunk' }, async (mock) => {
  mock.state.files.trunk = {};
  await runAction(mock, { event: {}, inputs: { site: SITE } });
  assert.equal(mock.state.prs[0].base, 'trunk');
}));

// ---------- static folder detection ----------

for (const [label, github, expected, note] of [
  ['public/ exists', { dirs: ['public', 'static'] }, 'public', null],
  ['only static/ exists', { dirs: ['static'] }, 'static', null],
  ['SvelteKit without folders', { files: { 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2.0.0"}}' } }, 'static', /looks like SvelteKit/],
  ['nothing found', { files: { 'package.json': '{"dependencies":{"next":"15"}}' } }, 'public', /no `public\/` or `static\/` folder was found, so the file goes in `public\/`/],
]) {
  test(`static folder detection: ${label} -> ${expected}/`, withMock(github, async (mock) => {
    await runAction(mock, { event: pushEvent, inputs: { site: SITE } });
    assert.equal(mock.state.lastPut.path, `${expected}/.well-known/7it-guard.txt`);
    if (note) assert.match(mock.state.prs[0].body, note);
    else assert.doesNotMatch(mock.state.prs[0].body, /folder was found/);
  }));
}

// ---------- unit ----------

test('sanitizeVerify rejects unsafe paths', () => {
  assert.equal(sanitizeVerify({ path: '../secrets', content: 'x' }), null);
  assert.equal(sanitizeVerify({ path: 'a/../../b', content: 'x' }), null);
  assert.equal(sanitizeVerify({ path: 'a b.txt', content: 'x' }), null);
  assert.equal(sanitizeVerify({ path: 'ok.txt', content: '' }), null);
  assert.equal(sanitizeVerify(null), null);
  assert.deepEqual(sanitizeVerify({ path: '/.well-known/x.txt', content: 'y' }), { path: '.well-known/x.txt', content: 'y', hint: '' });
});

test('isForkRun', () => {
  assert.equal(isForkRun({ repository: { fork: true } }, 'acme/web'), true);
  assert.equal(isForkRun({ pull_request: { head: { repo: { full_name: 'x/web', fork: true } } } }, 'acme/web'), true);
  assert.equal(isForkRun({ pull_request: { head: { repo: null } } }, 'acme/web'), true);
  assert.equal(isForkRun({ pull_request: { head: { repo: { full_name: 'acme/web' } } } }, 'acme/web'), false);
  assert.equal(isForkRun({}, 'acme/web'), false);
});
