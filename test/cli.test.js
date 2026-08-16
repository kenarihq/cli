import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let home;
let output;
let stdout;
let stderr;
const servers = [];
const logs = () => output.join('\n');
const stdoutLogs = () => stdout.join('\n');
const stderrLogs = () => stderr.join('\n');

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
  stdout = [];
  stderr = [];
});

after(() => {
  for (const server of servers) server.close();
});

async function capture(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  // process.stdout.write is stubbed too, not just console.log. Stubbing only console
  // left the stdout purity assertion unable to see the realistic regression, which is
  // an ADDITION rather than a move: a debug print or a library writing straight to the
  // stream. Injecting one there left the suite green while breaking
  // `claude -p --output-format json` for real.
  const originalWrite = process.stdout.write;
  console.log = (...args) => {
    const line = args.join(' ');
    output.push(line);
    stdout.push(line);
  };
  console.error = (...args) => {
    const line = args.join(' ');
    output.push(line);
    stderr.push(line);
  };
  process.stdout.write = (chunk, ...rest) => {
    // Strings only. The node:test runner shares this process and writes its own
    // protocol frames here as Buffers; capturing those made every assertion see
    // runner noise. A text write is what a stray debug print or a chatty library
    // produces, which is the regression this is here to catch.
    if (typeof chunk === 'string') stdout.push(chunk.replace(/\n$/, ''));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
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

// A stand-in for the real claude or codex binary that the host platform can actually
// execute. On Windows that has to be a .cmd, because CreateProcess cannot run a
// shebang script, which is the same reason `kenari claude` used to die there with
// ENOENT. Writing only the POSIX form is why every launch test skipped on Windows and
// why a total failure to launch shipped past a green matrix.
function writeFakeTool(dir, name, { exitCode = 0, prints = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const body = ['@echo off', ...prints.map((line) => `echo ${line}`), `exit /b ${exitCode}`];
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `${body.join('\r\n')}\r\n`);
    return;
  }
  const body = ['#!/bin/sh', ...prints.map((line) => `echo '${line}'`), `exit ${exitCode}`];
  fs.writeFileSync(path.join(dir, name), `${body.join('\n')}\n`, { mode: 0o755 });
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

test('the narrowing warning is per model, not per slot, and names the right tool', async (t) => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'narrow', pricing: {}, reasoning_options: ['high', 'xhigh'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const bin = path.join(home, 'bin-many');
  writeFakeTool(bin, 'claude');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    // The real shape: a user routing every slot at one model, not the one-slot mockup.
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'kenari/narrow', '--opus', 'kenari/narrow', '--sonnet', 'kenari/narrow',
      '--haiku', 'kenari/narrow', '--fable', 'kenari/narrow', '--subagents', 'kenari/narrow',
      '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    assert.equal(await run('claude', '--version'), 0);
    const lines = stderr.filter((line) => line.includes('warning: Claude Code offers'));
    assert.equal(lines.length, 1, 'one warning for the model, not one per slot');
    // Every slot still gets its own capability line: that part is per slot by design.
    assert.equal(stderr.filter((line) => line.includes('effort high, xhigh')).length, 6);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('the narrowing warning names Codex when Codex is what is launching', async (t) => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'narrow', pricing: {}, reasoning_options: ['high', 'xhigh'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const bin = path.join(home, 'bin-codex');
  fs.mkdirSync(bin, { recursive: true });
  // The banner prints just before spawn, so the fixture has to survive the whole codex
  // launch path: login status for the native base, then debug models for the catalog.
  // Written for whichever interpreter the platform can run, same reason as
  // writeFakeTool, which this is too specific to use.
  const models = '{"models":[{"slug":"gpt-5","supported_reasoning_levels":[]}]}';
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), [
      '@echo off',
      'if "%~1"=="login" (',
      '  echo Logged in using an API key',
      '  exit /b 0',
      ')',
      'if "%~1"=="debug" (',
      `  echo ${models}`,
      '  exit /b 0',
      ')',
      'exit /b 0',
    ].join('\r\n') + '\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'codex'), [
      '#!/bin/sh',
      'if [ "$1" = "login" ]; then echo "Logged in using an API key"; exit 0; fi',
      `if [ "$1" = "debug" ]; then echo '${models}'; exit 0; fi`,
      'exit 0',
    ].join('\n'), { mode: 0o755 });
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    assert.equal(await run(
      'configure', 'codex',
      '--main', 'kenari/narrow', '--review', 'inherit', '--subagents', 'inherit', '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    assert.equal(await run('codex', '--version'), 0);
    // runTool serves both tools. Telling a Codex user what Claude Code offers is
    // describing a control they are not looking at.
    assert.doesNotMatch(stderrLogs(), /Claude Code offers/);
    assert.match(stderrLogs(), /effort high, xhigh/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('status renders effort record and distinguishes unreported from none', async () => {
  const { saveState } = await import('../src/store.js');
  const base = { version: 2, migration: {}, tools: {} };
  saveState({ ...base, effort: { 'gpt-5-6-luna': {
    model: 'gpt-5-6-luna', requested: null, gated: null, status: 200, at: Date.now() - 240000,
  } } });
  assert.equal(await run('status'), 0);
  assert.match(logs(), /effort\s+kenari\/gpt-5-6-luna requested=unset gated=unreported 200 4m ago/);
  output = [];
  assert.equal(await run('status', '--json'), 0);
  const json = JSON.parse(logs());
  assert.deepEqual(json.effort['gpt-5-6-luna'], {
    model: 'gpt-5-6-luna', requested: null, gated: null, status: 200, pinned: false,
    at: json.effort['gpt-5-6-luna'].at,
  });

  output = [];
  saveState({ ...base, effort: { 'gpt-5-6-luna': {
    model: 'gpt-5-6-luna', requested: 'max', gated: 'none', status: 200, at: Date.now(),
  } } });
  assert.equal(await run('status'), 0);
  assert.match(logs(), /effort\s+kenari\/gpt-5-6-luna requested=max gated=none 200 0s ago/);

  // A client that picked the none level must not read the same as one that picked
  // nothing at all. This is the pair the previous wording collapsed.
  output = [];
  saveState({ ...base, effort: { 'gpt-5-6-luna': {
    model: 'gpt-5-6-luna', requested: 'none', gated: 'none', status: 200, at: Date.now(),
  } } });
  assert.equal(await run('status'), 0);
  assert.match(logs(), /requested=none gated=none/);
  assert.doesNotMatch(logs(), /requested=unset/);
});

test('status omits effort when no record exists', async () => {
  const { saveState } = await import('../src/store.js');
  saveState({ version: 2, migration: {}, tools: {} });
  assert.equal(await run('status'), 0);
  assert.doesNotMatch(logs(), /^effort\s/m);
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

test('fixed slots print advertised effort capabilities and narrowing warning on stderr', async (t) => {
  const cases = [
    { id: 'unknown', reasoning_options: undefined, line: 'effort unknown (gateway reports no capability)', warning: false },
    { id: 'unsupported', reasoning_options: [], line: 'effort unsupported', warning: false },
    { id: 'narrow', reasoning_options: ['high', 'xhigh'], line: 'effort high, xhigh', warning: true },
    { id: 'full', reasoning_options: ['low', 'medium', 'high', 'xhigh', 'max'], line: 'effort low, medium, high, xhigh, max', warning: false },
    { id: 'minimal', reasoning_options: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], line: 'effort minimal, low, medium, high, xhigh, max', warning: false },
  ];
  for (const item of cases) {
    output = [];
    stdout = [];
    stderr = [];
    process.env.KENARI_BASE_URL = await stubCatalog([{ id: item.id, pricing: {}, reasoning_options: item.reasoning_options }]);
    process.env.KENARI_ALLOW_HTTP = '1';
    const { setKey } = await import('../src/store.js');
    setKey('kn-testkey123');
    const bin = path.join(home, `bin-${item.id}`);
    writeFakeTool(bin, 'claude');
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    try {
      assert.equal(await run(
        'configure', 'claude',
        '--main', 'native', '--opus', 'native', '--sonnet', `kenari/${item.id}`,
        '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
      ), 0);
      output = [];
      stdout = [];
      stderr = [];
      assert.equal(await run('claude', '--version'), 0);
      assert.ok(
        stderrLogs().includes(`kenari: sonnet -> kenari/${item.id}  ${item.line}`),
        `${item.id}: got ${JSON.stringify(stderrLogs())}`,
      );
      assert.equal(stdoutLogs(), '', 'capability output must not corrupt stdout');
      assert.equal(stderrLogs().includes('kenari: warning:'), item.warning, `${item.id} warning state`);
      if (item.warning) {
        assert.match(stderrLogs(), /high, xhigh, so the gateway adjusts the rest/);
      }
    } finally {
      process.env.PATH = oldPath;
    }
  }
});

test('native-only wrapper prints no capability output', async (t) => {
  const bin = path.join(home, 'native-only-bin');
  writeFakeTool(bin, 'claude');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'native', '--opus', 'native', '--sonnet', 'native',
      '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
    ), 0);
    output = [];
    stdout = [];
    stderr = [];
    assert.equal(await run('claude', '--version'), 0);
    assert.doesNotMatch(stderrLogs(), /effort|capability/);
    assert.equal(stdoutLogs(), '');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('native wrapper preserves original child exit code', async (t) => {
  const bin = path.join(home, 'bin');
  writeFakeTool(bin, 'claude', { exitCode: 7 });
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

test('two slots on different models each report their own capability, aligned', async (t) => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'aa', pricing: {}, reasoning_options: ['high', 'xhigh'] },
    { id: 'bbbbbbbbbbbb', pricing: {}, reasoning_options: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const bin = path.join(home, 'bin-two');
  writeFakeTool(bin, 'claude');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'native', '--opus', 'kenari/aa', '--sonnet', 'kenari/bbbbbbbbbbbb',
      '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    assert.equal(await run('claude', '--version'), 0);
    const rows = stderr.filter((line) => line.includes(' -> kenari/'));
    assert.equal(rows.length, 2);
    // Each slot reports ITS OWN model. Indexing the catalog instead of matching by id
    // gives both rows the first model's levels, which a single-slot test cannot see.
    const opus = rows.find((line) => line.includes('kenari/aa '));
    const sonnet = rows.find((line) => line.includes('kenari/bbbbbbbbbbbb'));
    assert.ok(opus.endsWith('effort high, xhigh'), opus);
    assert.ok(sonnet.endsWith('effort low, medium, high, xhigh, max'), sonnet);
    // The model column is padded to the widest id, so "effort" starts at one column.
    assert.equal(opus.indexOf('effort'), sonnet.indexOf('effort'));
    // Only the narrow model warns. The other advertises all five.
    const warnings = stderr.filter((line) => line.includes('warning: Claude Code offers'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /aa advertises only/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('a launch that dies on a bad environment prints no capability advice first', async (t) => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'narrow', pricing: {}, reasoning_options: ['high', 'xhigh'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const bin = path.join(home, 'bin-ambig');
  writeFakeTool(bin, 'claude');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'native', '--opus', 'native', '--sonnet', 'kenari/narrow',
      '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    // buildClaudeLaunch refuses this, so the launch never happens. Printing capability
    // advice first made a real run read as though the advice caused the error.
    assert.equal(await run('claude', '--fallback-model', 'sonnet'), 1);
    assert.match(logs(), /fallback models are disabled/);
    assert.doesNotMatch(stderrLogs(), /effort high, xhigh/);
    assert.doesNotMatch(stderrLogs(), /warning: Claude Code offers/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// The manual setup in /docs/tools exports these, and the CLI used to refuse to launch
// on them, which left anyone who had followed the docs unable to run the CLI at all.
test('the documented manual environment is reported and taken over, not fatal', async (t) => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'narrow', pricing: {}, reasoning_options: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const bin = path.join(home, 'bin-manual-env');
  writeFakeTool(bin, 'claude');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'native', '--opus', 'native', '--sonnet', 'kenari/narrow',
      '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    process.env.ANTHROPIC_BASE_URL = 'https://kenari.id';
    process.env.ANTHROPIC_AUTH_TOKEN = 'kn-manual';
    assert.equal(await run('claude', '--version'), 0);
    assert.match(stderrLogs(), /ignoring ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN/);
    assert.match(stderrLogs(), /this session routes through kenari/);
    assert.doesNotMatch(logs(), /ambiguous/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test('configure pins effort per slot and refuses it on a native slot', async () => {
  process.env.KENARI_BASE_URL = await stubCatalog(CATALOG);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  assert.equal(await run(
    'configure', 'claude',
    '--main', 'native', '--opus', 'native', '--sonnet', 'kenari/glm-5-2', '--sonnet-effort', 'xhigh',
    '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
  ), 0);
  const config = JSON.parse(fs.readFileSync(path.join(process.env.KENARI_HOME, 'config.json'), 'utf8'));
  assert.deepEqual(config.tools.claude.roles.sonnet, {
    mode: 'fixed', model: 'kenari/glm-5-2', effort: 'xhigh',
  });
  // A native slot never reaches the gateway, so pinning one is a mistake worth naming.
  output = [];
  assert.equal(await run(
    'configure', 'claude',
    '--main', 'native', '--opus', 'native', '--sonnet', 'native', '--sonnet-effort', 'max',
    '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
  ), 1);
  assert.match(logs(), /--sonnet-effort needs --sonnet set to a kenari/);
});

test('the launch banner shows a pinned slot and warns only when the model cannot honor it', async (t) => {
  process.env.KENARI_BASE_URL = await stubCatalog([
    { id: 'narrow', pricing: {}, reasoning_options: ['high', 'xhigh'] },
  ]);
  process.env.KENARI_ALLOW_HTTP = '1';
  const { setKey } = await import('../src/store.js');
  setKey('kn-testkey123');
  const bin = path.join(home, 'bin-pin');
  writeFakeTool(bin, 'claude');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    // xhigh is advertised, so the pin is honored and there is nothing to warn about.
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'native', '--opus', 'native', '--sonnet', 'kenari/narrow', '--sonnet-effort', 'xhigh',
      '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    assert.equal(await run('claude', '--version'), 0);
    assert.match(stderrLogs(), /sonnet -> kenari\/narrow\s+effort xhigh \(pinned; model offers high, xhigh\)/);
    // The five-level session mismatch is moot once a slot is pinned.
    assert.doesNotMatch(stderrLogs(), /Claude Code offers low through max/);

    // max is not advertised, so the gateway will adjust it and the user should know.
    assert.equal(await run(
      'configure', 'claude',
      '--main', 'native', '--opus', 'native', '--sonnet', 'kenari/narrow', '--sonnet-effort', 'max',
      '--haiku', 'native', '--fable', 'native', '--subagents', 'native', '--yes',
    ), 0);
    output = []; stdout = []; stderr = [];
    assert.equal(await run('claude', '--version'), 0);
    assert.match(stderrLogs(), /narrow does not advertise max, only high, xhigh/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('status marks a pinned level so it never silently disagrees with the session', async () => {
  const { saveState } = await import('../src/store.js');
  saveState({ version: 2, migration: {}, tools: {}, effort: { 'glm-5-2': {
    model: 'glm-5-2', requested: 'max', gated: 'xhigh', status: 200, pinned: true, at: Date.now(),
  } } });
  assert.equal(await run('status'), 0);
  assert.match(logs(), /effort\s+kenari\/glm-5-2 requested=max \(pinned\) gated=xhigh 200/);
});
