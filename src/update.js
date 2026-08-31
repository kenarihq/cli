// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KenariError } from './store.js';

const require = createRequire(import.meta.url);
const REGISTRY_LATEST = 'https://registry.npmjs.org/@kenarihq/cli/latest';

export function packageRoot() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function packageVersion() {
  return require('../package.json').version;
}

export function isNpmGlobalInstall(root = packageRoot()) {
  const normalized = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.endsWith('/node_modules/@kenarihq/cli');
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((part) => parseInt(part, 10) || 0);
  const pb = String(b).split('.').map((part) => parseInt(part, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function npmBin(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export async function runUpdate(options = {}) {
  const currentVersion = options.currentVersion ?? packageVersion();
  const pkgRoot = options.pkgRoot ?? packageRoot();
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const checkOnly = Boolean(options.checkOnly);
  const registryUrl = options.registryUrl ?? REGISTRY_LATEST;
  const platform = options.platform ?? process.platform;

  if (!isNpmGlobalInstall(pkgRoot)) {
    throw new KenariError(
      'kenari update only supports the npm global install. Run: npm install -g @kenarihq/cli',
    );
  }

  let response;
  try {
    response = await fetchImpl(registryUrl, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new KenariError(`cannot reach npm registry: ${error.cause?.code || error.message}`);
  }
  if (!response.ok) {
    throw new KenariError(`cannot read npm registry (HTTP ${response.status})`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new KenariError('npm registry returned invalid JSON');
  }
  const latest = typeof body?.version === 'string' ? body.version : '';
  if (!latest) throw new KenariError('npm registry returned no version');

  console.log(`current  ${currentVersion}`);
  console.log(`latest   ${latest}`);
  if (compareVersions(latest, currentVersion) <= 0) {
    console.log('ok: already up to date');
    return 0;
  }
  if (checkOnly) {
    console.log('update available');
    return 0;
  }

  const result = spawnImpl(npmBin(platform), ['install', '-g', `@kenarihq/cli@${latest}`], {
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new KenariError('npm install -g @kenarihq/cli failed');
  }
  console.log(`ok: updated to ${latest}`);
  return 0;
}
