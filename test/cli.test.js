import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let home, out;
const logs = () => out.join('\n');
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-cli-'));
  process.env.KENARI_HOME = path.join(home, 'kh');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
  delete process.env.KENARI_BASE_URL;
  out = [];
});

async function run(...argv) {
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    const { main } = await import('../src/cli.js');
    return await main(argv);
  } finally { console.log = orig; console.error = origErr; }
}

function stubGateway(models) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer kn-testkey123' && req.headers.authorization !== 'Bearer kn-newkey456789') {
        res.statusCode = 401; res.end('{}'); return;
      }
      res.end(JSON.stringify({ data: models }));
    });
    s.unref();
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
}

const CATALOG = [
  { id: 'glm-5-2', pricing: { input: 13600000000, output: 43200000000, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' }, context_length: 1048576 },
  { id: 'kimi-k2-7-code', pricing: { input: 10400000000, output: 53600000000, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' }, context_length: 262144 },
  { id: 'deepseek-v4-flash', pricing: { input: 1700000000, output: 3400000000, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' }, context_length: 1048576 },
];

test('status: not found / default lifecycle', async () => {
  assert.equal(await run('status'), 0);
  assert.match(logs(), /claude\s+not found/);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  out = [];
  await run('status');
  assert.match(logs(), /claude\s+default/);
});

test('use claude with flags, then status, then use claude default', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const code = await run('use', 'claude', '--opus', 'glm-5-2', '--sonnet', 'kimi-k2-7-code', '--haiku', 'deepseek-v4-flash');
  assert.equal(code, 0);
  out = [];
  await run('status');
  assert.match(logs(), /claude\s+kenari/);
  assert.match(logs(), /opus=glm-5-2/);
  out = [];
  assert.equal(await run('use', 'claude', 'default'), 0);
  await run('status');
  assert.match(logs(), /claude\s+default/);
});

test('use claude non-TTY without flags applies validated defaults', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('use', 'claude'), 0);
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.equal(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5-2');
});

test('use claude with a model id missing from catalog fails', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('use', 'claude', '--opus', 'not-a-model'), 1);
  assert.match(logs(), /not-a-model/);
});

test('use claude with a valueless flag fails naming the slot', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('use', 'claude', '--opus'), 1);
  assert.match(logs(), /opus/);
});

test('bad key: use fails with auth message', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-wrongkey1234');
  assert.equal(await run('use', 'claude'), 1);
  assert.match(logs(), /rejected the API key/);
});

test('no key non-TTY: use fails with instruction', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  assert.equal(await run('use', 'claude'), 1);
  assert.match(logs(), /kenari key set/);
});

test('use unknown tool / not-installed tool fail cleanly', async () => {
  assert.equal(await run('use', 'gemini'), 1);
  assert.match(logs(), /claude|codex/);
  out = [];
  assert.equal(await run('use', 'codex'), 1);
  assert.match(logs(), /not found/);
});

test('use codex end to end with flags', async () => {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('use', 'codex', '--model', 'glm-5-2'), 0);
  const cfgTxt = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(cfgTxt, /model_provider = "kenari"/);
  assert.equal(await run('use', 'codex', 'default'), 0);
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, 'config.toml')), false);
});

test('key show masked, key delete', async () => {
  const { setKey, getKey } = await import('../src/store.js');
  setKey('kn-f4kef4kef4kef4kef4kef4kef4ke1234');
  assert.equal(await run('key', 'show'), 0);
  assert.match(logs(), /kn-036\.\.\./);
  assert.ok(!logs().includes(getKey()));
  out = [];
  assert.equal(await run('key', 'delete'), 0);
  assert.equal(getKey(), null);
});

test('key set --stdin re-applies to switched adapters', async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  await run('use', 'claude');
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const { Readable } = await import('node:stream');
  const fake = Readable.from(['kn-newkey456789\n']);
  fake.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try { assert.equal(await run('key', 'set', '--stdin'), 0); }
  finally { Object.defineProperty(process, 'stdin', origStdin); }
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'kn-newkey456789');
});

test('models prints table', async () => {
  process.env.KENARI_BASE_URL = await stubGateway(CATALOG);
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('models'), 0);
  assert.match(logs(), /glm-5-2/);
  assert.match(logs(), /Rp13\.600/);
});

test('help exits 0, unknown command exits 1', async () => {
  assert.equal(await run('--help'), 0);
  assert.match(logs(), /kenari use/);
  assert.equal(await run('frobnicate'), 1);
});
