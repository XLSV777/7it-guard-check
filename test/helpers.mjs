// Test helpers: a local mock HTTP server (7IT server + GitHub REST API)
// and a runner that executes the real action entry point as a child process.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = join(ROOT, 'src', 'index.mjs');

// handlers: { check(req, body) => {status, json}, github: {comments: [], canWrite: true, pulls: []} }
export async function startMock({ check, github = {} } = {}) {
  const state = {
    checkRequests: [],
    githubRequests: [],
    comments: github.comments ? [...github.comments] : [],
    nextId: 1000,
    // Repository model for the ownership PR flow.
    defaultBranch: github.defaultBranch || 'main',
    files: { main: { ...(github.files || {}) } }, // branch -> {path: content}
    dirs: github.dirs || [], // top-level folders on the default branch
    prs: github.prs ? [...github.prs] : [],
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/ghcheck') {
      state.checkRequests.push({ headers: req.headers, body });
      const r = check ? check(req, body) : { status: 200, json: passResult() };
      return send(r.status, r.json);
    }
    if (url.pathname === '/_oidc') {
      // The runner's OIDC token endpoint (ACTIONS_ID_TOKEN_REQUEST_URL).
      state.oidcRequests = state.oidcRequests || [];
      state.oidcRequests.push({ headers: req.headers, audience: url.searchParams.get('audience'), query: url.search });
      if (github.oidcStatus && github.oidcStatus !== 200) return send(github.oidcStatus, { message: 'no' });
      return send(200, { value: github.oidcValue ?? 'eyJhbGciOiJSUzI1NiJ9.eyJyZXBvc2l0b3J5IjoiYWNtZS93ZWIifQ.c2ln' });
    }
    state.githubRequests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const canWrite = github.canWrite !== false;
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/pulls$/))) {
      return send(200, github.pulls || []);
    }
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return send(200, { default_branch: state.defaultBranch });
    }
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname)) {
      if (github.canRead === false) return send(403, { message: 'Resource not accessible by integration' });
      const head = url.searchParams.get('head');
      const st = url.searchParams.get('state') || 'open';
      return send(200, state.prs.filter((p) => (!head || `${'acme'}:${p.head}` === head) && (st === 'all' || p.state === st)));
    }
    if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname)) {
      if (!canWrite) return send(403, { message: 'Resource not accessible by integration' });
      const pr = { number: state.nextId++, state: 'open', head: body.head, base: body.base, title: body.title, body: body.body, html_url: `https://github.com/acme/web/pull/${state.nextId - 1}` };
      state.prs.push(pr);
      return send(201, pr);
    }
    if ((m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/))) {
      const path = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        const ref = url.searchParams.get('ref') || state.defaultBranch;
        const files = state.files[ref] || {};
        if (ref === state.defaultBranch && state.dirs.includes(path)) return send(200, [{ name: 'favicon.ico', type: 'file' }]);
        if (path in files) return send(200, { type: 'file', sha: `sha-${path}`, content: Buffer.from(files[path]).toString('base64'), encoding: 'base64' });
        return send(404, { message: 'Not Found' });
      }
      if (req.method === 'PUT') {
        if (!canWrite) return send(403, { message: 'Resource not accessible by integration' });
        state.lastPut = { path, ...body };
        state.files[body.branch] = state.files[body.branch] || {};
        state.files[body.branch][path] = Buffer.from(body.content, 'base64').toString('utf8');
        return send(201, { content: { path } });
      }
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/))) {
      return send(200, { object: { sha: 'basesha000' } });
    }
    if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(url.pathname)) {
      if (!canWrite) return send(403, { message: 'Resource not accessible by integration' });
      const name = body.ref.replace('refs/heads/', '');
      if (state.files[name]) return send(422, { message: 'Reference already exists' });
      state.files[name] = { ...state.files[state.defaultBranch] };
      return send(201, { ref: body.ref });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
      return send(200, state.comments.filter((c) => c.issue === Number(m[1])));
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
      if (!canWrite) return send(403, { message: 'Resource not accessible by integration' });
      const c = { id: state.nextId++, issue: Number(m[1]), body: body.body };
      state.comments.push(c);
      return send(201, c);
    }
    if (req.method === 'PATCH' && (m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/))) {
      if (!canWrite) return send(403, { message: 'Resource not accessible by integration' });
      const c = state.comments.find((x) => x.id === Number(m[1]));
      if (!c) return send(404, { message: 'Not Found' });
      c.body = body.body;
      return send(200, c);
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    endpoint: `http://127.0.0.1:${port}/api/ghcheck`,
    // Env that makes the runner offer an OIDC token (what `permissions: id-token: write` does on GitHub).
    oidcEnv: { ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/_oidc?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token' },
    close: () => new Promise((r) => server.close(r)),
  };
}

export function passResult(over = {}) {
  return {
    ok: true,
    status: 'pass',
    headline: 'All checks passed.',
    findings: [],
    result_url: 'https://7it.co.il/guard/r/abc',
    trial_url: 'https://7it.co.il/plans/',
    badge_url: 'https://7it.co.il/guard/badge/abc.svg',
    message_md: '### 7IT Guard: pass\n\nAll checks passed.',
    ...over,
  };
}

export function finding(i, severity = 'warn') {
  return {
    id: `f${i}`,
    severity,
    title: `Finding ${i}`,
    why: `Reason ${i}, with a comma: and a colon.`,
    fix: `Do thing ${i}.`,
    prompt: `Fix finding ${i} in my site.`,
  };
}

// Run the action. opts: {inputs, eventName, event, env}
export async function runAction(mock, { inputs = {}, eventName = 'push', event = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), '7itgc-'));
  const eventPath = join(dir, 'event.json');
  const summary = join(dir, 'summary.md');
  const output = join(dir, 'output.txt');
  writeFileSync(eventPath, JSON.stringify(event));
  const allInputs = { 'on-problem': 'warn', comment: 'auto', 'github-token': 'test-token', endpoint: mock?.endpoint ?? '', ...inputs };
  const childEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: 'acme/web',
    GITHUB_REPOSITORY_ID: '123456',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_API_URL: mock?.base ?? 'http://127.0.0.1:9',
    ...env,
  };
  for (const [k, v] of Object.entries(allInputs)) {
    if (v !== undefined && v !== null) childEnv[`INPUT_${k.toUpperCase()}`] = String(v);
  }
  const child = spawn(process.execPath, [ENTRY], { env: childEnv });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => child.on('close', r));
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { code, stdout, stderr, summary: read(summary), outputs: parseOutputs(read(output)) };
}

function parseOutputs(text) {
  const out = {};
  const re = /^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3];
  return out;
}
