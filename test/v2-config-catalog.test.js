import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  validateConfig, saveConfig, loadConfig, hasKenariRoutes,
} from '../src/config.js';
import {
  validateCatalogResponse, saveCatalogCache, loadCatalogCache, loadCatalogForLaunch,
} from '../src/catalog.js';

function roles(tool) {
  return tool === 'claude'
    ? Object.fromEntries(['main', 'opus', 'sonnet', 'haiku', 'fable', 'subagents']
      .map((role) => [role, { mode: 'native' }]))
    : {
        main: { mode: 'native' },
        review: { mode: 'inherit' },
        subagents: { mode: 'inherit' },
      };
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-v2-'));
  const old = process.env.KENARI_HOME;
  process.env.KENARI_HOME = dir;
  t.after(() => {
    if (old === undefined) delete process.env.KENARI_HOME;
    else process.env.KENARI_HOME = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('v2 config validates complete roles, persists securely, and detects Kenari routes', (t) => {
  const dir = tempHome(t);
  const value = {
    version: 2,
    tools: {
      claude: { roles: roles('claude') },
      codex: { roles: { ...roles('codex'), main: { mode: 'picker' } } },
    },
  };
  assert.deepEqual(validateConfig(value), value);
  saveConfig(value);
  assert.deepEqual(loadConfig(), value);
  assert.equal(hasKenariRoutes(value), true);
  assert.equal(hasKenariRoutes(value, 'claude'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  }
});

test('v2 config rejects partial roles, bad mode placement, and unprefixed fixed model', () => {
  assert.throws(() => validateConfig({
    version: 2, tools: { claude: { roles: { main: { mode: 'native' } } } },
  }), /missing role/);
  const claude = roles('claude');
  claude.main = { mode: 'picker' };
  assert.throws(() => validateConfig({ version: 2, tools: { claude: { roles: claude } } }), /unsupported mode/);
  claude.main = { mode: 'fixed', model: 'gpt-5' };
  assert.throws(() => validateConfig({ version: 2, tools: { claude: { roles: claude } } }), /kenari/);
});

test('catalog normalizes reasoning options and capability', () => {
  const cases = [
    [{}, null, false],
    [{ reasoning_options: [] }, [], false],
    [{ reasoning_options: ['high', 'xhigh'] }, ['high', 'xhigh'], false],
    [{ reasoning_options: ['high', 'high', 'xhigh'] }, ['high', 'xhigh'], false],
    [{ reasoning_options: ['high', 5, null] }, ['high'], false],
    [{ reasoning_options: 'high' }, null, false],
  ];
  for (const [model, options, reasoning] of cases) {
    const result = validateCatalogResponse({ data: [{ id: 'model', ...model }] }, 'https://gateway.example');
    assert.deepEqual(result.models[0].reasoning_options, options);
    assert.equal(result.models[0].reasoning, reasoning);
  }
  for (const value of [true, false]) {
    const result = validateCatalogResponse({ data: [{ id: 'model', reasoning: value }] }, 'https://gateway.example');
    assert.equal(result.models[0].reasoning, value);
  }
});

test('a catalog cache of any other version is discarded, never fatal', (t) => {
  const dir = tempHome(t);
  // Version 3 stands for a file written by a newer CLI. Discarding beats throwing:
  // the cache is regenerable, so a launch must not die on one.
  for (const version of [1, 3]) {
    fs.writeFileSync(path.join(dir, 'model-cache.json'), JSON.stringify({
      version,
      fetched_at: new Date().toISOString(),
      gateway: 'https://gateway.example',
      models: [],
    }));
    assert.equal(loadCatalogCache(), null, `version ${version} should be discarded`);
  }
});

test('a cached model missing the field reads as unknown, not undefined', (t) => {
  const dir = tempHome(t);
  // validateCatalogCache checks ids, not per-model fields, so a version 2 file whose
  // models predate the field loads fine. Consumers branch on === null and would then
  // hit .length on undefined, crashing a launch on a display line.
  fs.writeFileSync(path.join(dir, 'model-cache.json'), JSON.stringify({
    version: 2,
    fetched_at: new Date().toISOString(),
    gateway: 'https://gateway.example',
    models: [{ id: 'glm-5-2' }, { id: 'gpt-5-6-luna', reasoning_options: ['high', 'high'] }],
  }));
  const cache = loadCatalogCache();
  assert.equal(cache.models[0].reasoning_options, null);
  assert.equal(cache.models[0].reasoning, false);
  // The same normalization the fetch path applies, so both entry points agree.
  assert.deepEqual(cache.models[1].reasoning_options, ['high']);
});

test('catalog refresh failure falls back with cache age', async (t) => {
  tempHome(t);
  const fetchedAt = new Date(Date.now() - 3 * 60 * 60 * 1000 - 30_000).toISOString();
  const cache = {
    ...validateCatalogResponse({ data: [{ id: 'glm-5', context_length: 200000 }] }, 'https://127.0.0.1.invalid'),
    fetched_at: fetchedAt,
  };
  saveCatalogCache(cache);
  const result = await loadCatalogForLaunch({
    key: 'kn-test12345',
    requireKenari: true,
    now: Date.parse(fetchedAt) + 3 * 60 * 60 * 1000,
    base: 'https://127.0.0.1.invalid',
    timeoutMs: 10,
  });
  assert.equal(result.cache.models[0].id, 'glm-5');
  assert.match(result.warning, /catalog refresh failed, using catalog from 3h ago:/);
});

test('catalog refresh failure without cache still throws when required', async (t) => {
  tempHome(t);
  await assert.rejects(
    loadCatalogForLaunch({
      key: 'kn-test12345', requireKenari: true,
      base: 'https://127.0.0.1.invalid', timeoutMs: 10,
    }),
    /catalog request|cannot reach|timed out/,
  );
});

test('catalog from another gateway is never reused for a Kenari route', async (t) => {
  tempHome(t);
  const cache = validateCatalogResponse({
    data: [{ id: 'old-model', context_length: 1000 }],
  }, 'https://old.example');
  saveCatalogCache(cache);
  await assert.rejects(
    loadCatalogForLaunch({
      requireKenari: true,
      refresh: false,
      base: 'https://new.example',
    }),
    /catalog unavailable/,
  );
});

test('catalog refresh uses bounded authenticated request', async (t) => {
  tempHome(t);
  const oldAllow = process.env.KENARI_ALLOW_HTTP;
  process.env.KENARI_ALLOW_HTTP = '1';
  t.after(() => {
    if (oldAllow === undefined) delete process.env.KENARI_ALLOW_HTTP;
    else process.env.KENARI_ALLOW_HTTP = oldAllow;
  });
  let auth;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gpt-5', context_length: 1000 }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await loadCatalogForLaunch({
    key: 'kn-test12345', requireKenari: true, base,
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.cache.models[0].id, 'gpt-5');
  assert.equal(auth, 'Bearer kn-test12345');
});

test('catalog always fetches despite recent cache', async (t) => {
  tempHome(t);
  const oldAllow = process.env.KENARI_ALLOW_HTTP;
  process.env.KENARI_ALLOW_HTTP = '1';
  t.after(() => {
    if (oldAllow === undefined) delete process.env.KENARI_ALLOW_HTTP;
    else process.env.KENARI_ALLOW_HTTP = oldAllow;
  });
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fresh-model', context_length: 1000 }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  saveCatalogCache(validateCatalogResponse({ data: [{ id: 'old-model' }] }, base));
  const result = await loadCatalogForLaunch({ key: 'kn-test12345', requireKenari: true, base });
  assert.equal(requests, 1);
  assert.equal(result.cache.models[0].id, 'fresh-model');
});
