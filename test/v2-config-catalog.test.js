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
  validateCatalogResponse, saveCatalogCache, loadCatalogCache,
  catalogIsFresh, loadCatalogForLaunch,
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

test('catalog validation and stale fallback preserve cache metadata', async (t) => {
  tempHome(t);
  const cache = validateCatalogResponse({
    data: [{
      id: 'glm-5',
      pricing: { unit: 'micro_idr_per_1m_tokens', input: 2_000_000, output: 3_000_000 },
      context_length: 200000,
      output_limit: 128000,
      reasoning_efforts: ['medium'],
    }],
  }, 'https://127.0.0.1.invalid');
  saveCatalogCache(cache);
  assert.equal(loadCatalogCache().models[0].output_limit, 128000);
  assert.equal(catalogIsFresh(cache, Date.parse(cache.fetched_at) + 100), true);
  const result = await loadCatalogForLaunch({
    key: 'kn-test12345',
    requireKenari: true,
    now: Date.parse(cache.fetched_at) + 100_000_000,
    base: 'https://127.0.0.1.invalid',
    timeoutMs: 10,
  });
  assert.equal(result.cache.models[0].id, 'glm-5');
  assert.match(result.warning, /using cached catalog/);
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
    key: 'kn-test12345', requireKenari: true, base, maxAgeMs: 0,
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.cache.models[0].id, 'gpt-5');
  assert.equal(auth, 'Bearer kn-test12345');
});
