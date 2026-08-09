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

async function capture(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => output.push(args.join(' '));
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function run(...argv) {
  const { main } = await import('../src/cli.js');
  return capture(() => main(argv));
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
  reasoning_options: ['high', 'xhigh'],
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

test('configure target picker defaults to both and maps every choice', async () => {
  const { chooseConfigureTools } = await import('../src/cli.js');
  const expected = [
    ['claude'],
    ['codex'],
    ['claude', 'codex'],
  ];
  for (let selection = 0; selection < expected.length; selection += 1) {
    const chosen = await chooseConfigureTools(['claude', 'codex'], async (
      title,
      items,
      defaultIndex,
    ) => {
      assert.equal(title, 'Configure which tool?');
      assert.deepEqual(items, ['Claude Code', 'Codex CLI', 'Both']);
      assert.equal(defaultIndex, 2);
      return selection;
    });
    assert.deepEqual(chosen, expected[selection]);
  }
});

test('configure target picker skips the prompt for one detected tool', async () => {
  const { chooseConfigureTools } = await import('../src/cli.js');
  let prompted = false;
  const chosen = await chooseConfigureTools(['codex'], async () => {
    prompted = true;
    return 0;
  });
  assert.deepEqual(chosen, ['codex']);
  assert.equal(prompted, false);
});

test('non-interactive configure requires an explicit tool', async () => {
  assert.equal(await run('configure', '--yes'), 1);
  assert.match(logs(), /--yes requires an explicit tool/);
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

test('models JSON uses reasoning options and limits', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog(CATALOG);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('models', '--json'), 0);
  assert.match(logs(), /"id": "kenari\/glm-5-2"/);
  assert.match(logs(), /"output_limit": 32000/);
  assert.match(logs(), /"reasoning_options": \[\n\s+"high",\n\s+"xhigh"\n\s+\]/);
  assert.doesNotMatch(logs(), /reasoning_efforts/);
});

test('models table renders unknown, unsupported, and advertised effort states', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'unknown', pricing: {}, reasoning_options: undefined },
    { id: 'unsupported', pricing: {}, reasoning_options: [] },
    { id: 'listed', pricing: {}, reasoning_options: ['high', 'xhigh'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('models'), 0);
  // Anchored to the row, so a stray match elsewhere in the table cannot pass these.
  assert.match(logs(), /^kenari\/unknown\s.*\s\?$/m);
  assert.match(logs(), /^kenari\/unsupported\s.*\sunsupported$/m);
  assert.match(logs(), /^kenari\/listed\s.*\shigh, xhigh$/m);
  // "none" is a level, not the empty set. A model advertising it must render it, and
  // a model with no levels must not borrow the word.
  assert.doesNotMatch(logs(), /^kenari\/unsupported\s.*\snone$/m);
});

test('models table renders none as the level it is, not as the empty set', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'full', pricing: {}, reasoning_options: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'minimalist', pricing: {}, reasoning_options: ['minimal', 'low', 'medium', 'high'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run('models'), 0);
  assert.match(logs(), /^kenari\/full\s.*\snone, low, medium, high, xhigh, max$/m);
  // minimal is a real level on 5 production models and is outside the set the rest of
  // this codebase assumes. It must survive to the display verbatim.
  assert.match(logs(), /^kenari\/minimalist\s.*\sminimal, low, medium, high$/m);
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

// The whole point of --api-key is a headless machine, so every cell of the
// flag matrix is asserted, not just the happy path: a removed flag that still
// silently ran the loopback flow would hang a VPS for five minutes.
test('login flag matrix: every removed flag is rejected and stores nothing', async () => {
  const { getKey } = await import('../src/store.js');
  const cases = [
    { argv: ['login', '--stdin'], match: /--stdin was removed/ },
    { argv: ['login', '--paste'], match: /--paste was removed/ },
    { argv: ['login', '--no-browser'], match: /--no-browser was removed/ },
    { argv: ['login', 'extra'], match: /usage: kenari login \[--api-key\]/ },
    { argv: ['login', '--api-key', 'kn-testkey123'], match: /shell (\s|\S)*history/ },
  ];
  for (const { argv, match } of cases) {
    output = [];
    assert.equal(await run(...argv), 1, `${argv.join(' ')} should exit 1`);
    assert.match(logs(), match, `${argv.join(' ')} message`);
    assert.equal(getKey(), null, `${argv.join(' ')} must not store a key`);
  }
  // The removal notice has to point at the replacement, or a VPS user is stuck.
  output = [];
  await run('login', '--paste');
  assert.match(logs(), /kenari login --api-key/);
});

test('loginApiKey: stores a valid key, rejects a malformed or empty one', async () => {
  const { loginApiKey } = await import('../src/cli.js');
  const { getKey } = await import('../src/store.js');
  const key = 'kn-f4kef4kef4kef4kef4kef4kef4ke1234';

  await assert.rejects(() => loginApiKey(async () => ''), /no API key entered/);
  assert.equal(getKey(), null);
  await assert.rejects(() => loginApiKey(async () => 'sk-not-a-kenari-key'), /kenari API key/);
  assert.equal(getKey(), null);

  assert.equal(await capture(() => loginApiKey(async () => key)), 0);
  assert.equal(getKey(), key);
  assert.doesNotMatch(logs(), new RegExp(key), 'the stored key must never be echoed in full');
  assert.match(logs(), /ok: stored kn-f4k\.\.\./);
});

// A masked prompt is only worth anything if it masks. Asserting the rendered
// row directly, because the failure mode is silent: writing the line instead
// of the mask puts a live credential into scrollback and still "works".
test('the key prompt renders one mask character per key character, never the key', async () => {
  const { renderMasked } = await import('../src/prompt.js');
  const key = 'kn-f4kef4kef4kef4kef4kef4kef4ke1234';
  const prompt = 'Paste your kenari API key: ';
  const writes = [];
  const fake = { isTTY: true, columns: 80, write: (s) => writes.push(s) };

  renderMasked(fake, prompt, key);
  const rendered = writes.join('');
  assert.ok(rendered.includes(prompt + '*'.repeat(key.length)), 'masked row');
  assert.doesNotMatch(rendered, /kn-/, 'the key must never reach the terminal');

  // Backspace has to shrink the row, otherwise the mask count lies.
  writes.length = 0;
  renderMasked(fake, prompt, key.slice(0, 4));
  assert.ok(writes.join('').includes(prompt + '****'), 'shrinks with the line');
});

// Ctrl-D at the key prompt used to leave the prompt's promise pending, so the
// process fell off the end with exit 0 and no credential. `kenari login
// --api-key && kenari configure` would then run configure against no login.
test('askSecret resolves empty on EOF so an abandoned prompt fails loudly', async () => {
  const { PassThrough } = await import('node:stream');
  const { askSecret: askHidden } = await import('../src/prompt.js');
  const { loginApiKey } = await import('../src/cli.js');
  const { getKey } = await import('../src/store.js');

  const fake = new PassThrough();
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    const answered = capture(() => askHidden('key: '));
    fake.end();
    assert.equal(await answered, '');
  } finally {
    Object.defineProperty(process, 'stdin', realStdin);
  }

  // An empty read must surface as a non-zero exit, not a silent success.
  await assert.rejects(() => loginApiKey(async () => ''), /no API key entered/);
  assert.equal(getKey(), null);
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
