import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMock, runAction, passResult, finding, ROOT } from './helpers.mjs';
import { VERSION, DEFAULT_ENDPOINT, COMMENT_MARKER, repoHash, resolveTarget, resolveEndpoint } from '../src/index.mjs';

const SITE = 'https://example.com';

function withMock(opts, fn) {
  return async () => {
    const mock = await startMock(opts);
    try { await fn(mock); } finally { await mock.close(); }
  };
}

const warnResult = () => passResult({ status: 'warn', headline: '2 things to look at.', findings: [finding(1), finding(2)], message_md: '### 7IT Guard: warn\n\n2 things to look at.' });
const failResult = () => passResult({ status: 'fail', headline: 'A problem was found.', findings: [finding(1, 'fail'), finding(2, 'warn')], message_md: '### 7IT Guard: fail\n\nA problem was found.' });

// ---------- request contract ----------

test('request body, headers and repo hash match the contract', withMock({}, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(mock.state.checkRequests.length, 1);
  const { body, headers } = mock.state.checkRequests[0];
  assert.deepEqual(Object.keys(body).sort(), ['event', 'preview', 'repo', 'sha', 'site', 'version']);
  assert.equal(body.site, 'https://example.com/');
  assert.equal(body.event, 'push');
  assert.equal(body.sha, '0123456');
  assert.equal(body.preview, false);
  assert.equal(body.version, VERSION);
  assert.match(body.repo, /^[0-9a-f]{64}$/);
  assert.equal(body.repo, createHash('sha256').update('acme/web#123456').digest('hex'));
  assert.equal(headers['user-agent'], `7it-guard-check/${VERSION}`);
}));

test('repoHash is sha256 hex of "<repo>#<id>"', () => {
  const h = repoHash('acme/web', '123456');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, createHash('sha256').update('acme/web#123456').digest('hex'));
  assert.notEqual(h, repoHash('acme/web', '123457'));
});

test('endpoint is one constant and only https (or localhost http) overrides are accepted', () => {
  assert.equal(DEFAULT_ENDPOINT, 'https://7it.co.il/guard/check');
  assert.equal(resolveEndpoint(''), DEFAULT_ENDPOINT);
  assert.equal(resolveEndpoint('http://evil.example/x'), null);
  assert.equal(resolveEndpoint('http://127.0.0.1:3000/api/ghcheck'), 'http://127.0.0.1:3000/api/ghcheck');
  const src = readFileSync(join(ROOT, 'src', 'index.mjs'), 'utf8');
  assert.equal(src.split('7it.co.il/guard/check').length - 1, 1, 'endpoint URL appears exactly once');
});

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('action.yml meets Marketplace basics', () => {
  const yml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.match(yml, /^name: '7IT Guard check'$/m);
  const desc = yml.match(/^description: '(.*)'$/m)[1];
  assert.ok(desc.length < 125, `description is ${desc.length} chars`);
  assert.match(yml, /icon: 'shield'/);
  assert.match(yml, /color: 'blue'/);
  assert.match(yml, /using: 'node24'/);
});

// ---------- results and modes ----------

test('pass: exit 0, outputs, summary written with 7IT Guard name', withMock({}, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, 'pass');
  assert.equal(r.outputs['result-url'], 'https://7it.co.il/guard/r/abc');
  assert.equal(r.outputs['findings-count'], '0');
  assert.match(r.summary, /7IT Guard/);
  assert.match(r.summary, /All checks passed/);
  assert.doesNotMatch(r.stdout, /::warning/);
}));

test('summary gets the 7IT Guard name even if message_md lacks it', withMock({ check: () => ({ status: 200, json: passResult({ message_md: 'Looks good.' }) }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.match(r.summary, /### 7IT Guard check/);
  assert.match(r.summary, /Looks good\./);
}));

test('warn: exit 0 with one ::warning:: annotation per finding', withMock({ check: () => ({ status: 200, json: warnResult() }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, 'warn');
  assert.equal(r.outputs['findings-count'], '2');
  const warnings = r.stdout.split('\n').filter((l) => l.startsWith('::warning'));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^::warning title=7IT Guard%3A Finding 1::Reason 1, with a comma: and a colon\. Fix: Do thing 1\.$/);
}));

test('fail in warn mode: exit 0', withMock({ check: () => ({ status: 200, json: failResult() }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE, 'on-problem': 'warn' } });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, 'fail');
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('::warning')).length, 2);
  assert.doesNotMatch(r.stdout, /::error/);
}));

test('fail in block mode: exit 1 with error annotation', withMock({ check: () => ({ status: 200, json: failResult() }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE, 'on-problem': 'block' } });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, 'fail');
  assert.match(r.stdout, /::error title=7IT Guard%3A Finding 1::/);
  assert.match(r.summary, /A problem was found/);
}));

test('warn in block mode: exit 0', withMock({ check: () => ({ status: 200, json: warnResult() }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE, 'on-problem': 'block' } });
  assert.equal(r.code, 0);
}));

test('more than 10 findings: annotations capped with a notice', withMock({ check: () => ({ status: 200, json: passResult({ status: 'warn', findings: Array.from({ length: 13 }, (_, i) => finding(i)) }) }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('::warning')).length, 10);
  assert.match(r.stdout, /::notice title=7IT Guard::3 more findings/);
}));

// ---------- our side never fails the job ----------

for (const [label, status, json, pattern] of [
  ['429 limited', 429, { limited: true, message_md: 'You have used this hour of checks.' }, /used this hour/],
  ['503 off', 503, { off: true }, /paused/],
  ['410 killed version', 410, { message_md: 'Version retired. Upgrade to the latest v1.' }, /Upgrade to the latest v1/],
  ['500 unexpected', 500, { error: 'boom' }, /unexpected answer/],
]) {
  for (const mode of ['warn', 'block']) {
    test(`${label} in ${mode} mode: exit 0 with a notice`, withMock({ check: () => ({ status, json }) }, async (mock) => {
      const r = await runAction(mock, { inputs: { site: SITE, 'on-problem': mode } });
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /^::notice title=7IT Guard::/m);
      assert.equal(r.outputs.status, 'skipped');
      assert.match(r.summary, /7IT Guard/);
      assert.match(r.summary, pattern);
      assert.equal(mock.state.githubRequests.length, 0, 'no PR comment on skipped runs');
    }));
  }
}

test('410 without message_md still shows the upgrade line', withMock({ check: () => ({ status: 410, json: {} }) }, async (mock) => {
  const r = await runAction(mock, { inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /retired\. Upgrade to the latest v1 release/);
  assert.match(r.summary, /latest `@v1` tag/);
}));

test('network error in block mode: exit 0 with a notice', async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  const r = await runAction(null, { inputs: { site: SITE, 'on-problem': 'block', endpoint: `http://127.0.0.1:${port}/api/ghcheck` } });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /::notice title=7IT Guard::.*could not reach/);
  assert.equal(r.outputs.status, 'skipped');
  assert.match(r.summary, /could not reach/);
});

test('missing site with no preview: configuration error', withMock({}, async (mock) => {
  const r = await runAction(mock, { inputs: { site: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error title=7IT Guard::Set the "site" input/);
  assert.equal(mock.state.checkRequests.length, 0);
}));

// ---------- preview detection ----------

const deployEvent = (over = {}) => ({
  deployment_status: { state: 'success', environment_url: 'https://web-git-feature-acme.vercel.app', ...over.status },
  deployment: { sha: 'feedfacecafebeef00000000000000000000000', environment: 'Preview', production_environment: false, ...over.deployment },
});

test('deployment_status success on a preview: checks environment_url with preview:true', withMock({}, async (mock) => {
  const r = await runAction(mock, { eventName: 'deployment_status', event: deployEvent(), inputs: { site: SITE } });
  assert.equal(r.code, 0);
  const { body } = mock.state.checkRequests[0];
  assert.equal(body.site, 'https://web-git-feature-acme.vercel.app/');
  assert.equal(body.preview, true);
  assert.equal(body.event, 'deployment_status');
  assert.equal(body.sha, 'feedfac');
}));

test('deployment_status preview works without the site input (Netlify)', withMock({}, async (mock) => {
  const r = await runAction(mock, {
    eventName: 'deployment_status',
    event: deployEvent({ status: { environment_url: 'https://deploy-preview-42--acme.netlify.app' }, deployment: { environment: 'deploy-preview' } }),
    inputs: { site: '' },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(mock.state.checkRequests[0].body.site, 'https://deploy-preview-42--acme.netlify.app/');
  assert.equal(mock.state.checkRequests[0].body.preview, true);
}));

test('deployment_status on production: checks site with preview:false', withMock({}, async (mock) => {
  const r = await runAction(mock, {
    eventName: 'deployment_status',
    event: deployEvent({ deployment: { environment: 'Production', production_environment: true } }),
    inputs: { site: SITE },
  });
  assert.equal(r.code, 0);
  assert.equal(mock.state.checkRequests[0].body.site, 'https://example.com/');
  assert.equal(mock.state.checkRequests[0].body.preview, false);
}));

test('deployment_status not success: skipped, no request, exit 0', withMock({}, async (mock) => {
  const r = await runAction(mock, { eventName: 'deployment_status', event: deployEvent({ status: { state: 'pending' } }), inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.checkRequests.length, 0);
  assert.match(r.stdout, /::notice/);
}));

test('resolveTarget: push uses site, adds https://', () => {
  const t = resolveTarget({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'abcdef1234' }, {}, 'example.com');
  assert.deepEqual(t, { site: 'https://example.com/', preview: false, sha: 'abcdef1234' });
});

// ---------- PR comment ----------

const prEvent = { pull_request: { number: 7, head: { sha: 'abc1234def567' } } };

test('PR comment: created once, then updated in place', withMock({ check: () => ({ status: 200, json: warnResult() }) }, async (mock) => {
  const r1 = await runAction(mock, { eventName: 'pull_request', event: prEvent, inputs: { site: SITE } });
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(mock.state.comments.length, 1);
  assert.ok(mock.state.comments[0].body.startsWith(COMMENT_MARKER));
  assert.match(mock.state.comments[0].body, /2 things to look at/);
  assert.equal(mock.state.checkRequests[0].body.sha, 'abc1234');
  const post = mock.state.githubRequests.find((x) => x.method === 'POST');
  assert.equal(post.path, '/repos/acme/web/issues/7/comments');
  assert.equal(post.headers.authorization, 'Bearer test-token');

  const r2 = await runAction(mock, { eventName: 'pull_request', event: prEvent, inputs: { site: SITE } });
  assert.equal(r2.code, 0);
  assert.equal(mock.state.comments.length, 1, 'still one comment');
  assert.ok(mock.state.githubRequests.some((x) => x.method === 'PATCH' && x.path === `/repos/acme/web/issues/comments/${mock.state.comments[0].id}`));
}));

test('PR comment: ignores other comments without the marker', withMock({ github: { comments: [{ id: 5, issue: 7, body: 'LGTM' }] } }, async (mock) => {
  await runAction(mock, { eventName: 'pull_request', event: prEvent, inputs: { site: SITE } });
  assert.equal(mock.state.comments.length, 2);
  assert.equal(mock.state.comments[0].body, 'LGTM');
}));

test('PR comment: no permission (403) is skipped silently, exit 0', withMock({ github: { canWrite: false } }, async (mock) => {
  const r = await runAction(mock, { eventName: 'pull_request', event: prEvent, inputs: { site: SITE } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.comments.length, 0);
  assert.doesNotMatch(r.stdout, /::(warning|error|notice)/);
}));

test('PR comment: off mode makes no GitHub API calls', withMock({}, async (mock) => {
  const r = await runAction(mock, { eventName: 'pull_request', event: prEvent, inputs: { site: SITE, comment: 'off' } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.githubRequests.length, 0);
}));

test('PR comment: no token means no GitHub API calls', withMock({}, async (mock) => {
  const r = await runAction(mock, { eventName: 'pull_request', event: prEvent, inputs: { site: SITE, 'github-token': '' } });
  assert.equal(r.code, 0);
  assert.equal(mock.state.githubRequests.length, 0);
}));

test('PR comment: push event never comments', withMock({}, async (mock) => {
  await runAction(mock, { inputs: { site: SITE } });
  assert.equal(mock.state.githubRequests.length, 0);
}));

test('PR comment on deployment_status: finds the PR by commit', withMock({ github: { pulls: [{ number: 9, state: 'open' }] } }, async (mock) => {
  const r = await runAction(mock, { eventName: 'deployment_status', event: deployEvent(), inputs: {} });
  assert.equal(r.code, 0);
  assert.equal(mock.state.comments.length, 1);
  assert.equal(mock.state.comments[0].issue, 9);
}));

// ---------- hygiene ----------

test('no em dashes or bidi marks in shipped files', () => {
  const files = ['src/index.mjs', 'action.yml', 'README.md', 'SECURITY.md', 'RELEASING.md', 'CHANGELOG.md', 'scripts/release.mjs',
    'examples/vercel-netlify-previews.yml', 'examples/any-host.yml', 'examples/block-on-fail.yml'];
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /—/, `em dash in ${f}`);
    assert.doesNotMatch(text, /[‎‏‪-‮⁦-⁩]/, `bidi mark in ${f}`);
  }
});
