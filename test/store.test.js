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
  const { statePath } = await import('../src/paths.js');
  // Legacy version 1 path, unreachable from src (setToolState and clearToolState have
  // no callers there) and unavailable after the version 2 migration. A fresh install
  // now reads as version 2, so this has to state its version 1 file explicitly.
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), '{"version":1,"tools":{}}');
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

test('loadState rejects an unknown newer state schema version', async () => {
  const { loadState, KenariError } = await import('../src/store.js');
  const { statePath } = await import('../src/paths.js');
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), '{"version":3,"tools":{}}');
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

test('version 2 effort record survives state roundtrip', async () => {
  const { saveState, loadState } = await import('../src/store.js');
  const effort = {
    model: 'gpt-5-6-luna', requested: 'max', gated: 'xhigh', status: 200, at: 1754745600000,
  };
  saveState({ version: 2, migration: {}, tools: {}, effort: { [effort.model]: effort } });
  assert.deepEqual(loadState().effort[effort.model], effort);
});

test('effort record survives the roundtrip a fresh install actually takes', async () => {
  const { saveState, loadState } = await import('../src/store.js');
  const { statePath } = await import('../src/paths.js');
  // No state.json yet, which is every new user. This is the path onEffort writes
  // through in practice, so seeding a state first is exactly what hides bugs here.
  assert.equal(fs.existsSync(statePath()), false);
  const base = loadState();
  // A fresh install is a version 2 install. Defaulting to 1 wrote a version 1 file on
  // the first session, which made detectV1State true and sent the next launch through
  // a migration that had nothing to migrate and dropped the record on the way.
  assert.equal(base.version, 2);
  const effort = {
    model: 'glm-5-2', requested: 'max', gated: 'xhigh', status: 200, at: 1754745600000,
  };
  saveState({ ...base, effort: { [effort.model]: effort } });
  assert.deepEqual(loadState().effort[effort.model], effort);
});

test('malformed version 2 effort record loads as null', async () => {
  const { loadState } = await import('../src/store.js');
  const { statePath } = await import('../src/paths.js');
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify({ version: 2, tools: {}, effort: { bad: { model: 42 } } }));
  assert.doesNotThrow(() => loadState());
  assert.deepEqual(loadState().effort, {});
});

test('a fresh install does not fabricate a version 1 file that triggers migration', async () => {
  const { loadState, recordEffort } = await import('../src/store.js');
  const { detectV1State } = await import('../src/migrate.js');
  const { statePath } = await import('../src/paths.js');
  assert.equal(fs.existsSync(statePath()), false);
  await recordEffort({ model: 'glm-5-2', requested: 'max', gated: 'xhigh', status: 200, at: 1754745600000 });
  // Writing a version 1 shape here made the NEXT launch run migrateV1, which rewrites
  // state.json to version 2 and discards the record, so the fix has to hold across
  // launches and not merely within one.
  assert.equal(detectV1State(), null, 'must not look like a version 1 install');
  assert.equal(loadState().effort['glm-5-2'].gated, 'xhigh');
});

test('effort records are per model, bounded, and merge across sessions', async () => {
  const { loadState, recordEffort } = await import('../src/store.js');
  await recordEffort({ model: 'glm-5-2', requested: 'max', gated: 'xhigh', status: 200, at: 1000 });
  await recordEffort({ model: 'gpt-5-6-luna', requested: 'max', gated: 'max', status: 200, at: 2000 });
  // Two slots at two models in one session: the second must not evict the first, which
  // is what a single global record did.
  const both = loadState().effort;
  assert.equal(both['glm-5-2'].gated, 'xhigh');
  assert.equal(both['gpt-5-6-luna'].gated, 'max');
  // Same model again replaces rather than accumulates.
  await recordEffort({ model: 'glm-5-2', requested: 'low', gated: 'high', status: 200, at: 3000 });
  assert.equal(Object.keys(loadState().effort).length, 2);
  assert.equal(loadState().effort['glm-5-2'].requested, 'low');
  // Bounded, keeping the most recent, so a long-lived install cannot grow without end.
  for (let i = 0; i < 12; i += 1) {
    await recordEffort({ model: `m${i}`, requested: 'max', gated: 'max', status: 200, at: 10000 + i });
  }
  const kept = loadState().effort;
  assert.equal(Object.keys(kept).length, 8);
  assert.ok(kept.m11, 'newest kept');
  assert.equal(kept['glm-5-2'], undefined, 'oldest evicted');
});

test('recordEffort does not clobber a concurrent migration write', async () => {
  const { loadState, saveState, recordEffort } = await import('../src/store.js');
  // migration.tools is what blocks a launch on an unresolved v1 routing conflict.
  // An unlocked read-modify-write dropped it, and the loss is permanent: the file is
  // then version 2 with empty migration, so detectV1State returns null and it never re-runs.
  saveState({
    version: 2,
    migration: { tools: { claude: { status: 'conflict', keys: ['ANTHROPIC_MODEL'] } } },
    tools: {},
    effort: {},
  });
  await recordEffort({ model: 'glm-5-2', requested: 'max', gated: 'xhigh', status: 200, at: 1000 });
  const after = loadState();
  assert.deepEqual(after.migration.tools.claude.keys, ['ANTHROPIC_MODEL']);
  assert.equal(after.effort['glm-5-2'].gated, 'xhigh');
});
