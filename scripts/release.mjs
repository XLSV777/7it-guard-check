#!/usr/bin/env node
// Release helper for 7IT Guard check.
// Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--push]
// Bumps package.json and the VERSION constant, moves the CHANGELOG
// "Unreleased" section under the new version, commits, tags vX.Y.Z and
// force-moves the major tag vX. With --push it also pushes main and both tags.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const push = args.includes('--push');
const bump = args.find((a) => !a.startsWith('--'));

function git(...a) {
  if (dry) { console.log(`[dry-run] git ${a.join(' ')}`); return ''; }
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function nextVersion(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`Bad current version ${current}`);
  let [maj, min, pat] = m.slice(1).map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(kind || '')) return kind;
  throw new Error('Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--push]');
}

function main() {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (status && !dry) throw new Error('Working tree is not clean. Commit or stash first.');

  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = nextVersion(pkg.version, bump);
  const major = `v${version.split('.')[0]}`;
  const tag = `v${version}`;
  const today = new Date().toISOString().slice(0, 10);

  const srcPath = join(ROOT, 'src', 'index.mjs');
  const src = readFileSync(srcPath, 'utf8');
  const re = /export const VERSION = '[^']+';/;
  if (!re.test(src)) throw new Error('VERSION constant not found in src/index.mjs');

  const clPath = join(ROOT, 'CHANGELOG.md');
  const cl = readFileSync(clPath, 'utf8');
  if (!cl.includes('## [Unreleased]')) throw new Error('CHANGELOG.md needs a "## [Unreleased]" section.');

  console.log(`Releasing ${pkg.version} -> ${version} (${tag}, moving ${major})`);
  if (!dry) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(srcPath, src.replace(re, `export const VERSION = '${version}';`));
    const updated = cl
      .replace(/## \[Unreleased\]\n\nPlanned as [^\n]*\n/, '## [Unreleased]\n')
      .replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${today}`);
    writeFileSync(clPath, updated);
  }
  git('add', 'package.json', 'src/index.mjs', 'CHANGELOG.md');
  git('commit', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `7IT Guard check ${tag}`);
  git('tag', '-f', '-a', major, '-m', `7IT Guard check ${major} -> ${tag}`);
  if (push) {
    git('push', 'origin', 'HEAD');
    git('push', 'origin', tag);
    git('push', '-f', 'origin', major);
  } else {
    console.log(`Next: git push origin HEAD && git push origin ${tag} && git push -f origin ${major}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
