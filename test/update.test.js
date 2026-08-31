import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  isNpmGlobalInstall,
  packageRoot,
  packageVersion,
  runUpdate,
} from '../src/update.js';

const GLOBAL_ROOT = path.join('/usr', 'local', 'lib', 'node_modules', '@kenarihq', 'cli');

test('package helpers read this package and refuse a git checkout', () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(packageRoot(), path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  assert.equal(isNpmGlobalInstall(packageRoot()), false);
  assert.equal(isNpmGlobalInstall(GLOBAL_ROOT), true);
  assert.equal(
    isNpmGlobalInstall('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@kenarihq\\cli'),
    true,
  );
  assert.equal(isNpmGlobalInstall(path.join('/tmp', 'cli')), false);
});

test('compareVersions is numeric, not lexicographic', () => {
  assert.equal(compareVersions('0.5.4', '0.5.4'), 0);
  assert.equal(compareVersions('0.5.5', '0.5.4'), 1);
  assert.equal(compareVersions('0.5.3', '0.5.4'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('runUpdate refuses a non-global install before touching the registry', async () => {
  let fetched = false;
  await assert.rejects(
    () => runUpdate({
      pkgRoot: packageRoot(),
      fetchImpl: async () => { fetched = true; return jsonResponse({ version: '9.0.0' }); },
    }),
    /npm global install/,
  );
  assert.equal(fetched, false);
});

test('runUpdate --check reports an available version and does not install', async () => {
  const spawned = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    assert.equal(await runUpdate({
      pkgRoot: GLOBAL_ROOT,
      currentVersion: '0.5.4',
      checkOnly: true,
      fetchImpl: async () => jsonResponse({ version: '0.6.0' }),
      spawnImpl: (...args) => { spawned.push(args); return { status: 0 }; },
    }), 0);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logs, ['current  0.5.4', 'latest   0.6.0', 'update available']);
  assert.deepEqual(spawned, []);
});

test('runUpdate is a no-op when already current', async () => {
  const spawned = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    assert.equal(await runUpdate({
      pkgRoot: GLOBAL_ROOT,
      currentVersion: '0.6.0',
      fetchImpl: async () => jsonResponse({ version: '0.6.0' }),
      spawnImpl: (...args) => { spawned.push(args); return { status: 0 }; },
    }), 0);
  } finally {
    console.log = originalLog;
  }
  assert.match(logs.join('\n'), /already up to date/);
  assert.deepEqual(spawned, []);
});

test('runUpdate installs the latest global package', async () => {
  const spawned = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    assert.equal(await runUpdate({
      pkgRoot: GLOBAL_ROOT,
      currentVersion: '0.5.4',
      platform: 'linux',
      fetchImpl: async () => jsonResponse({ version: '0.6.1' }),
      spawnImpl: (command, args) => {
        spawned.push([command, args]);
        return { status: 0 };
      },
    }), 0);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(spawned, [['npm', ['install', '-g', '@kenarihq/cli@0.6.1']]]);
  assert.match(logs.join('\n'), /ok: updated to 0.6.1/);
});

test('runUpdate uses npm.cmd on Windows and surfaces a failed install', async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      () => runUpdate({
        pkgRoot: GLOBAL_ROOT,
        currentVersion: '0.1.0',
        platform: 'win32',
        fetchImpl: async () => jsonResponse({ version: '0.2.0' }),
        spawnImpl: (command) => {
          assert.equal(command, 'npm.cmd');
          return { status: 1 };
        },
      }),
      /npm install -g @kenarihq\/cli failed/,
    );
  } finally {
    console.log = originalLog;
  }
});
