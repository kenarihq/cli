import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-store-'));
  process.env.KENARI_HOME = home;
});

test('writeFileAtomic creates parents and writes', async () => {
  const { writeFileAtomic } = await import('../src/store.js');
  const f = path.join(home, 'a', 'b.txt');
  writeFileAtomic(f, 'hello');
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
});

test('writeFileAtomic refuses symlink', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink perms on windows');
  const { writeFileAtomic, KenariError } = await import('../src/store.js');
  const real = path.join(home, 'real.txt');
  fs.writeFileSync(real, 'x');
  const link = path.join(home, 'link.txt');
  fs.symlinkSync(real, link);
  assert.throws(() => writeFileAtomic(link, 'y'), KenariError);
  assert.equal(fs.readFileSync(real, 'utf8'), 'x');
});

test('writeFileAtomic preserves existing mode', async (t) => {
  if (process.platform === 'win32') return t.skip('chmod on windows');
  const { writeFileAtomic } = await import('../src/store.js');
  const f = path.join(home, 'm.txt');
  fs.writeFileSync(f, 'x');
  fs.chmodSync(f, 0o644);
  writeFileAtomic(f, 'y');
  assert.equal(fs.statSync(f).mode & 0o777, 0o644);
});

test('readJson: null when missing, KenariError on garbage', async () => {
  const { readJson, KenariError } = await import('../src/store.js');
  assert.equal(readJson(path.join(home, 'nope.json')), null);
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, '{oops');
  assert.throws(() => readJson(bad), KenariError);
});

test('key roundtrip, validation, masking', async () => {
  const { setKey, getKey, deleteKey, maskKey, KenariError } = await import('../src/store.js');
  assert.equal(getKey(), null);
  assert.throws(() => setKey('sk-nope'), KenariError);
  setKey('kn-f4kef4kef4kef4kef4kef4kef4kef4kef4kef4kef4ke1234');
  assert.equal(getKey(), 'kn-f4kef4kef4kef4kef4kef4kef4kef4kef4kef4kef4ke1234');
  assert.equal(maskKey(getKey()), 'kn-f4k...234');
  deleteKey();
  assert.equal(getKey(), null);
});

test('credentials and state files are 0600', async (t) => {
  if (process.platform === 'win32') return t.skip('mode on windows');
  const { setKey, saveState, loadState } = await import('../src/store.js');
  setKey('kn-f4kef4kef4kef4kef4kef4kef4ke1234');
  saveState(loadState());
  const { credentialsPath, statePath } = await import('../src/paths.js');
  assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(statePath()).mode & 0o777, 0o600);
});

test('tool state roundtrip', async () => {
  const { getToolState, setToolState, clearToolState } = await import('../src/store.js');
  assert.equal(getToolState('claude'), null);
  setToolState('claude', { fileCreated: false, containerCreated: true, keys: {} });
  assert.deepEqual(getToolState('claude').keys, {});
  clearToolState('claude');
  assert.equal(getToolState('claude'), null);
});

test('withLock: serializes, detects stale lock', async () => {
  const { withLock, KenariError } = await import('../src/store.js');
  const { lockDir } = await import('../src/paths.js');
  const out = await withLock(async () => 42);
  assert.equal(out, 42);
  assert.equal(fs.existsSync(lockDir()), false);
  // stale lock: dead pid, backdated past the mid-acquisition window
  fs.writeFileSync(lockDir(), '999999999');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lockDir(), old, old);
  assert.equal(await withLock(async () => 'ok'), 'ok');
  assert.equal(fs.existsSync(lockDir()), false);
  // live lock: our own pid counts as another live process
  fs.writeFileSync(lockDir(), String(process.pid));
  await assert.rejects(withLock(async () => 'nope'), KenariError);
  fs.rmSync(lockDir(), { force: true });
});

test('withLock: empty lock file younger than 2s rejects (mid-acquisition)', async () => {
  const { withLock, KenariError } = await import('../src/store.js');
  const { lockDir } = await import('../src/paths.js');
  fs.mkdirSync(path.dirname(lockDir()), { recursive: true });
  fs.writeFileSync(lockDir(), '');
  await assert.rejects(withLock(async () => 'nope'), KenariError);
  fs.rmSync(lockDir(), { force: true });
});

test('withLock: empty lock file backdated 5s is stale', async () => {
  const { withLock } = await import('../src/store.js');
  const { lockDir } = await import('../src/paths.js');
  fs.mkdirSync(path.dirname(lockDir()), { recursive: true });
  fs.writeFileSync(lockDir(), '');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lockDir(), old, old);
  assert.equal(await withLock(async () => 'ok'), 'ok');
  assert.equal(fs.existsSync(lockDir()), false);
});

test('loadState rejects a newer state schema version', async () => {
  const { loadState, KenariError } = await import('../src/store.js');
  const { statePath } = await import('../src/paths.js');
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), '{"version":2,"tools":{}}');
  assert.throws(() => loadState(), KenariError);
});

test('loadState normalizes missing tools', async () => {
  const { getToolState, setToolState } = await import('../src/store.js');
  const { statePath } = await import('../src/paths.js');
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), '{"version":1}');
  assert.equal(getToolState('x'), null);
  setToolState('x', { ok: true });
  assert.deepEqual(getToolState('x'), { ok: true });
});
