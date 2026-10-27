// 7IT Guard check: a thin GitHub Action client.
// All check logic lives on the 7IT server. This file only collects the
// site URL and a few anonymous facts about the run, sends them, and reports.
// Zero runtime dependencies: global fetch and node:crypto only.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
export const DEFAULT_ENDPOINT = 'https://7it.co.il/guard/check';
export const NAME = '7IT Guard';
export const COMMENT_MARKER = '<!-- 7it-guard-check:comment -->';
export const USER_AGENT = `7it-guard-check/${VERSION}`;
const REQUEST_TIMEOUT_MS = 100_000; // the server stops waiting at 48 s and reports slow parts as not measured
const MAX_ANNOTATIONS = 10;
const STATUSES = new Set(['pass', 'warn', 'fail']);
// The audience of the GitHub OIDC token this Action asks for. The 7IT server accepts only this audience.
export const OIDC_AUDIENCE = '7it-guard-check';
const OIDC_TIMEOUT_MS = 10_000;

// ---------- small runner helpers (no @actions/core) ----------

export function getInput(env, name) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (env[key] ?? '').trim();
}

function escapeData(s) {
  return String(s ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function annotation(kind, message, title) {
  const props = title ? ` title=${escapeProperty(title)}` : '';
  return `::${kind}${props}::${escapeData(message)}`;
}

function makeIO(env, out) {
  const write = (line) => out.push(line);
  return {
    log: write,
    notice: (msg, title) => write(annotation('notice', msg, title)),
    warning: (msg, title) => write(annotation('warning', msg, title)),
    error: (msg, title) => write(annotation('error', msg, title)),
    debug: (msg) => write(`::debug::${escapeData(msg)}`),
    summary(md) {
      const file = env.GITHUB_STEP_SUMMARY;
      if (!file) return;
      try { appendFileSync(file, md.endsWith('\n') ? md : md + '\n'); } catch { /* never fatal */ }
    },
    output(name, value) {
      const file = env.GITHUB_OUTPUT;
      const v = String(value ?? '');
      if (!file) return;
      try {
        const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
        appendFileSync(file, `${name}<<${delim}\n${v}\n${delim}\n`);
      } catch { /* never fatal */ }
    },
  };
}

// ---------- context ----------

export function repoHash(repository, repositoryId) {
  return createHash('sha256').update(`${repository ?? ''}#${repositoryId ?? ''}`).digest('hex');
}

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return {};
  try { return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { return {}; }
}

export function normalizeSite(raw) {
  if (!raw) return '';
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function resolveEndpoint(raw) {
  if (!raw) return DEFAULT_ENDPOINT;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.hostname))) return u.toString();
  } catch { /* fall through */ }
  return null;
}

// Decide what to check. Returns {skip, reason} or {site, preview, sha}.
export function resolveTarget(env, event, siteInput) {
  const eventName = env.GITHUB_EVENT_NAME || '';
  let sha = env.GITHUB_SHA || '';
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    sha = event?.pull_request?.head?.sha || sha;
  }
  if (eventName === 'deployment_status') {
    const ds = event?.deployment_status || {};
    const dep = event?.deployment || {};
    sha = dep.sha || sha;
    if (ds.state !== 'success') {
      return { skip: true, reason: `Deployment state is "${ds.state || 'unknown'}". ${NAME} runs when a deployment succeeds.` };
    }
    const envName = String(dep.environment || ds.environment || '');
    const production = dep.production_environment === true || /^production$/i.test(envName);
    const envUrl = normalizeSite(ds.environment_url || ds.target_url || '');
    if (!production && envUrl) return { site: envUrl, preview: true, sha };
    const site = normalizeSite(siteInput) || envUrl;
    return { site, preview: false, sha };
  }
  return { site: normalizeSite(siteInput), preview: false, sha };
}

// ---------- GitHub identity token (OIDC) ----------

// Asks the runner for a GitHub Actions OIDC token with our audience, so the server can confirm the repository from
// GitHub's signed claims instead of trusting the body. The runner only offers it when the workflow grants
// `permissions: id-token: write`; pull requests from forks never get it. Returns {token} or {token: '', reason}.
// The token is sent only to the 7IT endpoint and is never written to the log.
export async function getIdToken(env, fetchImpl) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL || '';
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '';
  if (!url || !bearer) return { token: '', reason: 'no-permission' };
  try {
    const u = new URL(url);
    u.searchParams.set('audience', OIDC_AUDIENCE);
    const res = await fetchImpl(u.toString(), {
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json; api-version=2.0', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
    if (!res.ok) return { token: '', reason: `http-${res.status}` };
    const j = await res.json().catch(() => null);
    const token = typeof j?.value === 'string' ? j.value : '';
    if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { token: '', reason: 'bad-answer' };
    return { token };
  } catch {
    return { token: '', reason: 'error' };
  }
}

export const NO_TOKEN_NOTICE = `${NAME} ran without the GitHub identity token, so only the outside checks ran and the site cannot be proven yours. Add "id-token: write" under "permissions:" in the workflow. Pull requests from forks never get the token.`;

// ---------- server call ----------

async function callServer(endpoint, payload, fetchImpl) {
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, error: err };
  }
}

// ---------- PR comment ----------

async function findPullNumber(ctx) {
  const { event, eventName } = ctx;
  if (event?.pull_request?.number) return event.pull_request.number;
  if (eventName === 'deployment_status' && ctx.sha) {
    const r = await gh(ctx, 'GET', `/repos/${ctx.repository}/commits/${ctx.sha}/pulls`);
    if (r.ok && Array.isArray(r.body)) {
      const open = r.body.find((p) => p.state === 'open') || r.body[0];
      if (open?.number) return open.number;
    }
  }
  return null;
}

async function gh(ctx, method, path, body) {
  try {
    const res = await ctx.fetch(`${ctx.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, body: json };
  } catch (err) {
    return { ok: false, status: 0, error: err };
  }
}

async function upsertComment(ctx, io, markdown) {
  if (!ctx.token || !ctx.repository) { io.debug('No token: PR comment skipped.'); return 'skipped'; }
  const number = await findPullNumber(ctx);
  if (!number) { io.debug('No pull request for this run: comment skipped.'); return 'skipped'; }
  const body = `${COMMENT_MARKER}\n${markdown}`;
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const r = await gh(ctx, 'GET', `/repos/${ctx.repository}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!r.ok || !Array.isArray(r.body)) { if (!r.ok) { io.debug(`Comment list failed (${r.status}): skipped.`); return 'skipped'; } break; }
    existing = r.body.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER)) || null;
    if (r.body.length < 100) break;
  }
  const r = existing
    ? await gh(ctx, 'PATCH', `/repos/${ctx.repository}/issues/comments/${existing.id}`, { body })
    : await gh(ctx, 'POST', `/repos/${ctx.repository}/issues/${number}/comments`, { body });
  if (!r.ok) { io.debug(`Comment write failed (${r.status}): the token likely lacks pull-requests: write. Skipped.`); return 'skipped'; }
  return existing ? 'updated' : 'created';
}

// ---------- ownership PR (one merge proves the site is yours) ----------

export const VERIFY_BRANCH = '7it-guard/verify';
export const OWNERSHIP_COMMIT = 'Add the 7IT Guard ownership file';
export const OWNERSHIP_MARKER = '<!-- 7it-guard-check:ownership -->';

// verify: {path, content, hint}. path is relative to the site root, e.g.
// ".well-known/7it-guard.txt". Reject anything that could escape the folder.
export function sanitizeVerify(v) {
  if (!v || typeof v !== 'object') return null;
  const path = String(v.path || '').replace(/^\/+/, '');
  const content = typeof v.content === 'string' ? v.content : '';
  if (!path || !content || path.length > 200 || content.length > 10_000) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return null;
  if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return { path, content, hint: typeof v.hint === 'string' ? v.hint : '' };
}

export function isForkRun(event, repository) {
  if (event?.repository?.fork === true) return true;
  const pr = event?.pull_request;
  if (pr) {
    const head = pr.head?.repo;
    if (!head) return true; // head repo deleted: treat as a fork
    if (head.fork === true && head.full_name !== repository) return true;
    if (head.full_name && repository && head.full_name !== repository) return true;
  }
  return false;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function getFile(ctx, path, ref) {
  const r = await gh(ctx, 'GET', `/repos/${ctx.repository}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return { exists: false };
  if (!r.ok) return { error: r.status };
  if (Array.isArray(r.body)) return { exists: true, dir: true };
  const content = r.body?.content ? Buffer.from(r.body.content, 'base64').toString('utf8') : '';
  return { exists: true, dir: r.body?.type === 'dir', sha: r.body?.sha, content };
}

// Order: public/, static/; if neither exists, SvelteKit (package.json) means
// static/, anything else public/. found=false means we created the folder.
export async function detectStaticFolder(ctx, ref) {
  for (const dir of ['public', 'static']) {
    const f = await getFile(ctx, dir, ref);
    if (f.exists && f.dir) return { folder: dir, found: true };
  }
  const pkg = await getFile(ctx, 'package.json', ref);
  if (pkg.exists && !pkg.dir && /"@sveltejs\/kit"/.test(pkg.content || '')) return { folder: 'static', found: false, framework: 'SvelteKit' };
  return { folder: 'public', found: false };
}

function prBody(host, filePath, verify, folderInfo) {
  const lines = [
    `This pull request adds one small file, \`${filePath}\`, so 7IT Guard can confirm that you control **${host}**.`,
    '',
    '**What the file is.** A short public token that 7IT Guard reads from your live site. When the file is there, the check knows the site is yours.',
    '',
    '**What it is not.** It holds no secret and nothing about your code. Anyone can see it once it is deployed, and that is fine: it only proves control of the site.',
    '',
    `**What happens next.** Merge this pull request and let your site deploy. The next 7IT Guard check finds the file, unlocks the full results, and starts the 14-day 7IT Guard Pro trial for ${host}.`,
    '',
    `**How to remove it.** Delete \`${filePath}\` in any later commit. Nothing else depends on it. To stop these pull requests, set \`ownership-pr: off\` in the workflow.`,
  ];
  if (!folderInfo.found) {
    lines.push('', folderInfo.framework
      ? `Note: no \`public/\` or \`static/\` folder was found. This looks like ${folderInfo.framework}, so the file goes in \`${folderInfo.folder}/\`. Move it if your site serves static files from another folder.`
      : `Note: no \`public/\` or \`static/\` folder was found, so the file goes in \`public/\`. Move it to the folder your site serves static files from, so it is reachable at \`/${verify.path}\`.`);
  }
  if (verify.hint) lines.push('', verify.hint);
  lines.push('', OWNERSHIP_MARKER);
  return lines.join('\n');
}

// Returns {done, reason, url?, filePath?}
export async function ensureOwnershipPr(ctx, io, verify, site) {
  const host = new URL(site).host;
  if (!ctx.token || !ctx.repository) return { done: false, reason: 'no-token' };
  if (isForkRun(ctx.event, ctx.repository)) return { done: false, reason: 'fork' };
  const owner = ctx.repository.split('/')[0];

  // At most once per repo: any PR (open, closed or merged) from our branch.
  const prs = await gh(ctx, 'GET', `/repos/${ctx.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${VERIFY_BRANCH}`)}&per_page=10`);
  if (!prs.ok) return { done: false, reason: 'no-permission' };
  if (Array.isArray(prs.body) && prs.body.length) {
    const open = prs.body.find((p) => p.state === 'open');
    return { done: false, reason: open ? 'pr-open' : 'pr-before', url: open?.html_url || '' };
  }

  let base = ctx.event?.repository?.default_branch;
  if (!base) {
    const repo = await gh(ctx, 'GET', `/repos/${ctx.repository}`);
    if (!repo.ok) return { done: false, reason: 'no-permission' };
    base = repo.body?.default_branch || 'main';
  }

  const folderInfo = await detectStaticFolder(ctx, base);
  const filePath = `${folderInfo.folder}/${verify.path}`;
  const current = await getFile(ctx, filePath, base);
  if (current.exists && !current.dir && current.content === verify.content) return { done: false, reason: 'file-present', filePath };

  const ref = await gh(ctx, 'GET', `/repos/${ctx.repository}/git/ref/heads/${encPath(base)}`);
  if (!ref.ok || !ref.body?.object?.sha) return { done: false, reason: 'no-permission', filePath };
  const created = await gh(ctx, 'POST', `/repos/${ctx.repository}/git/refs`, { ref: `refs/heads/${VERIFY_BRANCH}`, sha: ref.body.object.sha });
  if (!created.ok && created.status !== 422) return { done: false, reason: 'no-permission', filePath };

  const onBranch = created.ok ? current : await getFile(ctx, filePath, VERIFY_BRANCH);
  const put = await gh(ctx, 'PUT', `/repos/${ctx.repository}/contents/${encPath(filePath)}`, {
    message: OWNERSHIP_COMMIT,
    content: Buffer.from(verify.content, 'utf8').toString('base64'),
    branch: VERIFY_BRANCH,
    ...(onBranch.exists && onBranch.sha ? { sha: onBranch.sha } : {}),
  });
  if (!put.ok) return { done: false, reason: 'no-permission', filePath };

  const pr = await gh(ctx, 'POST', `/repos/${ctx.repository}/pulls`, {
    title: `7IT Guard: prove you own ${host} (one merge)`,
    head: VERIFY_BRANCH,
    base,
    body: prBody(host, filePath, verify, folderInfo),
  });
  if (!pr.ok) return { done: false, reason: 'no-permission', filePath };
  return { done: true, reason: 'created', url: pr.body?.html_url || '', filePath };
}

export function ownershipSummary(verify, site, r) {
  const host = new URL(site).host;
  if (r.done) return `\n**Prove you own ${host}:** ${NAME} opened a pull request that adds one small file. Merge it and deploy to unlock the full results and the 14-day 7IT Guard Pro trial.${r.url ? ` ${r.url}` : ''}\n`;
  if (r.reason === 'pr-open') return `\n**Prove you own ${host}:** the ownership pull request is open. Merge it and deploy.${r.url ? ` ${r.url}` : ''}\n`;
  if (r.reason === 'no-id-token') return `\n**Prove you own ${host}:** add \`id-token: write\` under \`permissions:\` in the workflow first. The ownership file proves the site only on a run that sends the GitHub identity token, so no pull request was opened this time.\n`;
  if (r.reason === 'file-present') return `\n**Prove you own ${host}:** the ownership file \`${r.filePath}\` is in the repository. Deploy the site and the next check confirms it.\n`;
  return [
    '',
    `**Prove you own ${host} (one step):** add a file to your site so it is served at \`/${verify.path}\` with exactly this content:`,
    '',
    '```text',
    verify.content,
    '```',
    '',
    `Usually that means \`public/${verify.path}\` (or \`static/${verify.path}\`). Deploy, and the next check unlocks the full results and the 14-day 7IT Guard Pro trial.`,
    verify.hint ? `\n${verify.hint}` : '',
    '',
  ].join('\n');
}

// ---------- reporting ----------

function withName(md) {
  const text = String(md || '').trim();
  if (/7IT Guard/.test(text)) return text;
  return `### ${NAME} check\n\n${text}`;
}

function fallbackMarkdown(r) {
  const lines = [`### ${NAME} check: ${r.status}`, '', r.headline || ''];
  for (const f of r.findings || []) lines.push(`- **${f.title}** (${f.severity}): ${f.why || ''} ${f.fix ? `Fix: ${f.fix}` : ''}`.trim());
  if (r.result_url) lines.push('', `Full result: ${r.result_url}`);
  return lines.join('\n');
}

function skipped(io, message, md) {
  io.notice(message, NAME);
  io.summary(withName(md || message));
  io.output('status', 'skipped');
  io.output('result-url', '');
  io.output('findings-count', '0');
  return 0;
}

// ---------- main ----------

export async function run({ env = process.env, fetch: fetchImpl = globalThis.fetch, out = [] } = {}) {
  const io = makeIO(env, out);
  const mode = (getInput(env, 'on-problem') || 'warn').toLowerCase();
  const commentMode = (getInput(env, 'comment') || 'auto').toLowerCase();
  if (mode !== 'warn' && mode !== 'block') { io.error(`on-problem must be "warn" or "block", got "${mode}".`, NAME); return 1; }
  if (commentMode !== 'auto' && commentMode !== 'off') { io.error(`comment must be "auto" or "off", got "${commentMode}".`, NAME); return 1; }
  const ownershipInput = (getInput(env, 'ownership-pr') || 'auto').toLowerCase();
  if (ownershipInput !== 'auto' && ownershipInput !== 'off') { io.error(`ownership-pr must be "auto" or "off", got "${ownershipInput}".`, NAME); return 1; }

  const endpoint = resolveEndpoint(getInput(env, 'endpoint'));
  if (!endpoint) { io.error('endpoint must be an https URL.', NAME); return 1; }

  const event = readEvent(env);
  const eventName = env.GITHUB_EVENT_NAME || '';
  const target = resolveTarget(env, event, getInput(env, 'site'));
  if (target.skip) return skipped(io, target.reason);
  if (!target.site) {
    io.error('Set the "site" input to the URL to check (for example https://example.com), or run on deployment_status for deploy previews.', NAME);
    return 1;
  }

  const payload = {
    site: target.site,
    repo: repoHash(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY_ID),
    event: eventName,
    sha: (target.sha || '').slice(0, 7),
    preview: target.preview,
    version: VERSION,
  };
  const idt = await getIdToken(env, fetchImpl);
  if (idt.token) {
    payload.id_token = idt.token;
    io.log(`${NAME}: sending the GitHub identity token (audience ${OIDC_AUDIENCE}) so the repository can be confirmed.`);
  } else {
    io.debug(`No GitHub identity token (${idt.reason}).`);
    if (!isForkRun(event, env.GITHUB_REPOSITORY || '')) io.notice(NO_TOKEN_NOTICE, NAME);
  }
  io.log(`${NAME} checking ${payload.site}${payload.preview ? ' (deploy preview)' : ''}`);

  const res = await callServer(endpoint, payload, fetchImpl);
  const b = res.body || {};

  if (res.status === 0) return skipped(io, `${NAME} could not reach the check service right now. The job is not affected.`);
  if (res.status === 429 || b.limited) return skipped(io, `${NAME} check limit reached for now. The job is not affected.`, b.message_md);
  if (res.status === 503 || b.off) return skipped(io, `${NAME} checks are paused right now. The job is not affected.`, b.message_md);
  if (res.status === 410) {
    const md = b.message_md || `This version of ${NAME} check (${VERSION}) is retired. Point your workflow at the latest \`@v1\` tag of 7IT Guard check to keep checking.`;
    return skipped(io, `This version (${VERSION}) is retired. Upgrade to the latest v1 release to keep checking.`, md);
  }
  if (res.status === 401 && b.need_id_token) {
    return skipped(io, `${NAME} needs the GitHub identity token: add "id-token: write" under "permissions:" in the workflow. The job is not affected.`, b.message_md);
  }
  if (res.status === 401) {
    return skipped(io, `${NAME} could not confirm this repository from its GitHub identity token. The job is not affected.`, b.message_md);
  }
  if (res.status !== 200 || !STATUSES.has(b.status)) {
    return skipped(io, `${NAME} got an unexpected answer (HTTP ${res.status}). The job is not affected.`);
  }

  const findings = Array.isArray(b.findings) ? b.findings : [];
  const md = withName(b.message_md || fallbackMarkdown(b));
  io.summary(md);
  io.output('status', b.status);
  io.output('result-url', b.result_url || '');
  io.output('findings-count', String(findings.length));

  const blocking = mode === 'block' && b.status === 'fail';
  findings.slice(0, MAX_ANNOTATIONS).forEach((f) => {
    const msg = [f.why, f.fix ? `Fix: ${f.fix}` : ''].filter(Boolean).join(' ') || f.title || '';
    const title = `${NAME}: ${f.title || f.id || 'finding'}`;
    if (blocking && /^(fail|high|critical)$/i.test(String(f.severity || ''))) io.error(msg, title);
    else io.warning(msg, title);
  });
  if (findings.length > MAX_ANNOTATIONS) io.notice(`${findings.length - MAX_ANNOTATIONS} more findings in the job summary.`, NAME);
  io.log(`${NAME}: ${b.status}. ${b.headline || ''}`.trim());
  if (b.result_url) io.log(`Result: ${b.result_url}`);

  const ctx = {
    fetch: fetchImpl,
    token: getInput(env, 'github-token'),
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    repository: env.GITHUB_REPOSITORY || '',
    event,
    eventName,
    sha: target.sha,
  };
  if (commentMode === 'auto') {
    try { await upsertComment(ctx, io, md); } catch (e) { io.debug(`Comment skipped: ${e?.message || e}`); }
  }

  const verify = sanitizeVerify(b.verify);
  if (verify) {
    const ownershipMode = (getInput(env, 'ownership-pr') || 'auto').toLowerCase();
    let r = { done: false, reason: 'off' };
    // The ownership file proves a site only on a run whose repository the server confirmed from the identity token.
    if (b.repo_verified === false) r = { done: false, reason: 'no-id-token' };
    else if (ownershipMode === 'auto') {
      try { r = await ensureOwnershipPr(ctx, io, verify, target.site); } catch (e) { r = { done: false, reason: 'error' }; io.debug(`Ownership PR skipped: ${e?.message || e}`); }
    }
    io.summary(ownershipSummary(verify, target.site, r));
    io.output('ownership-pr', r.url || '');
  }

  if (blocking) {
    io.error(`${NAME} found problems and on-problem is "block". ${b.headline || ''}`.trim(), NAME);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = { push: (line) => process.stdout.write(line + '\n') };
  run({ out }).then((code) => { process.exitCode = code; }, (err) => {
    // An unexpected bug in this client must never break the user's job.
    process.stdout.write(annotation('notice', `${NAME} hit an internal error and skipped: ${err?.message || err}`, NAME) + '\n');
    process.exitCode = 0;
  });
}
