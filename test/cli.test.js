import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let home;
let output;
const servers = [];
const logs = () => output.join('\n');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-cli-v2-'));
  process.env.KENARI_HOME = path.join(home, 'kenari');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-home');
  process.env.CODEX_HOME = path.join(home, 'codex-home');
  delete process.env.KENARI_BASE_URL;
  delete process.env.KENARI_ALLOW_HTTP;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  output = [];
});

after(() => {
  for (const server of servers) server.close();
});

async function run(...argv) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => output.push(args.join(' '));
  try {
    const { main } = await import('../src/cli.js');
    return await main(argv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function stubCatalog(models) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url !== '/v1/models') {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers.authorization !== 'Bearer kn-testkey123') {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: models }));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

const CATALOG = [{
  id: 'glm-5-2',
  pricing: {
    input: 13600000000,
    output: 40800000000,
    currency: 'IDR',
    unit: 'micro_idr_per_1m_tokens',
  },
  context_length: 200000,
  output_limit: 32000,
  reasoning_efforts: ['low', 'high'],
}];

test('help exposes v2 surface and removed commands stay unknown', async () => {
  assert.equal(await run('help'), 0);
  assert.match(logs(), /kenari configure/);
  assert.match(logs(), /kenari claude/);
  assert.doesNotMatch(logs(), /kenari use/);
  output = [];
  assert.equal(await run('use', 'claude'), 1);
  assert.match(logs(), /unknown command: use/);
  output = [];
  assert.equal(await run('key', 'show'), 1);
  assert.match(logs(), /unknown command: key/);
});

test('native-only automation needs no login or catalog', async () => {
  assert.equal(await run(
    'configure', 'claude',
    '--main', 'native',
    '--opus', 'native',
    '--sonnet', 'native',
    '--haiku', 'native',
    '--fable', 'native',
    '--subagents', 'native',
    '--yes',
  ), 0);
  const config = JSON.parse(fs.readFileSync(path.join(process.env.KENARI_HOME, 'config.json'), 'utf8'));
  assert.equal(config.version, 2);
  assert.equal(config.tools.claude.roles.main.mode, 'native');
  assert.equal(fs.existsSync(path.join(process.env.KENARI_HOME, 'credentials.json')), false);
});

test('non-interactive automation rejects partial roles', async () => {
  assert.equal(await run('configure', 'codex', '--main', 'native', '--yes'), 1);
  assert.match(logs(), /missing --review, --subagents/);
});

test('fixed route validates catalog and writes namespaced config', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog(CATALOG);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run(
    'configure', 'codex',
    '--main', 'picker',
    '--review', 'inherit',
    '--subagents', 'kenari/glm-5-2',
    '--yes',
  ), 0);
  const config = JSON.parse(fs.readFileSync(path.join(process.env.KENARI_HOME, 'config.json'), 'utf8'));
  assert.deepEqual(config.tools.codex.roles.subagents, {
    mode: 'fixed',
    model: 'kenari/glm-5-2',
  });
  const cache = JSON.parse(fs.readFileSync(path.join(process.env.KENARI_HOME, 'model-cache.json'), 'utf8'));
  assert.equal(cache.models[0].id, 'glm-5-2');
});

test('unknown fixed model fails closed', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog(CATALOG);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run(
    'configure', 'codex',
    '--main', 'kenari/missing',
    '--review', 'inherit',
    '--subagents', 'inherit',
    '--yes',
  ), 1);
  assert.match(logs(), /kenari\/missing/);
  assert.equal(fs.existsSync(path.join(process.env.KENARI_HOME, 'config.json')), false);
});

test('status JSON is offline and never prints credential', async () => {
  const { setKey } = await import('../src/store.js');
  const key = 'kn-f4kef4kef4kef4kef4kef4kef4ke1234';
  setKey(key);
  assert.equal(await run('status', '--json'), 0);
  assert.match(logs(), /"credential": "stored"/);
  assert.doesNotMatch(logs(), new RegExp(key));
});

test('models JSON uses kenari prefix and includes limits', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog(CATALOG);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('models', '--json'), 0);
  assert.match(logs(), /"id": "kenari\/glm-5-2"/);
  assert.match(logs(), /"output_limit": 32000/);
});

test('reset leaves login but removes unused shared cache', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog(CATALOG);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey, getKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  await run(
    'configure', 'codex',
    '--main', 'picker',
    '--review', 'inherit',
    '--subagents', 'inherit',
    '--yes',
  );
  output = [];
  assert.equal(await run('reset', 'codex'), 0);
  assert.equal(getKey(), 'kn-testkey123');
  assert.equal(fs.existsSync(path.join(process.env.KENARI_HOME, 'model-cache.json')), false);
});

test('logout deletes only the Kenari credential', async () => {
  const { setKey, getKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  await run(
    'configure', 'claude',
    '--main', 'native',
    '--opus', 'native',
    '--sonnet', 'native',
    '--haiku', 'native',
    '--fable', 'native',
    '--subagents', 'native',
    '--yes',
  );
  assert.equal(await run('logout'), 0);
  assert.equal(getKey(), null);
  assert.equal(fs.existsSync(path.join(process.env.KENARI_HOME, 'config.json')), true);
});

test('wrapper requires configuration outside a TTY', async () => {
  assert.equal(await run('claude', '--version'), 1);
  assert.match(logs(), /run: kenari configure claude/);
});

test('native wrapper preserves original child exit code', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    await run(
      'configure', 'claude',
      '--main', 'native',
      '--opus', 'native',
      '--sonnet', 'native',
      '--haiku', 'native',
      '--fable', 'native',
      '--subagents', 'native',
      '--yes',
    );
    output = [];
    assert.equal(await run('claude', '--version'), 7);
  } finally {
    process.env.PATH = oldPath;
  }
});
