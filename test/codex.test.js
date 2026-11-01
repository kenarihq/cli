import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildCodexLaunch,
  codexKenariModels,
  codexSocketLeftovers,
  codexSubcommand,
  codexSupportsDaemon,
} from '../src/runtime/codex.js';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-codex-detect-'));
  process.env.CODEX_HOME = path.join(home, 'codex');
});

test('Codex adapter only detects installation and never edits config', async () => {
  const adapter = (await import('../src/adapters/codex.js')).default;
  assert.equal(adapter.detect().installed, false);
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const config = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(config, 'approval_policy = "never"\n');
  assert.equal(adapter.detect().installed, true);
  assert.equal(adapter.detect().configPath, config);
  assert.deepEqual(Object.keys(adapter).sort(), ['detect', 'id', 'name']);
  assert.equal(fs.readFileSync(config, 'utf8'), 'approval_policy = "never"\n');
});

test('Codex catalog uses gateway reasoning options, including explicit empty options', () => {
  const native = [{
    slug: 'native',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
  }];
  const models = codexKenariModels({
    models: [
      { id: 'gemini-3-6-flash', reasoning_options: ['minimal', 'low', 'medium', 'high'] },
      { id: 'gemini-2-5-flash', reasoning_options: null },
      { id: 'gpt-image-2', reasoning_options: [] },
    ],
  }, native);

  assert.deepEqual(models[0].supported_reasoning_levels, [
    { effort: 'minimal', description: 'minimal reasoning' },
    { effort: 'low', description: 'low reasoning' },
    { effort: 'medium', description: 'medium reasoning' },
    { effort: 'high', description: 'high reasoning' },
  ]);
  assert.equal(models[0].default_reasoning_level, 'minimal');
  assert.deepEqual(models[1].supported_reasoning_levels, [
    { effort: 'low', description: 'low reasoning' },
    { effort: 'medium', description: 'medium reasoning' },
  ]);
  assert.equal(models[1].default_reasoning_level, 'low');
  assert.deepEqual(models[2].supported_reasoning_levels, []);
  assert.equal(models[2].default_reasoning_level, undefined);
});

function launch(args, codexDaemon, privateDir = () => { throw new Error('no private dir expected'); }) {
  return buildCodexLaunch({
    toolConfig: { roles: {} },
    routerUrl: 'http://127.0.0.1:2',
    catalogPath: '/tmp/catalog.json',
    args,
    env: {},
    codexDaemon,
    privateDir,
  });
}

const ROUTING = [
  'model_provider="kenari_router"',
  'model_providers.kenari_router.base_url="http://127.0.0.1:2"',
  'model_catalog_json="/tmp/catalog.json"',
];

test('plain Codex sessions run embedded when the installed Codex has the daemon', () => {
  for (const args of [[], ['resume', '--last'], ['-m', 'kenari/x', 'fork', 'id'], ['--', 'agents']]) {
    const built = launch(args, true);
    assert.deepEqual(built.args.slice(-args.length - 1), ['--no-daemon', ...args], args.join(' '));
    for (const value of ROUTING) assert.ok(built.args.indexOf(value) < built.args.indexOf('--no-daemon'));
    assert.equal(built.sidecar, undefined);
  }
  // Subcommands that are not a TUI session, and a user who chose a server or the
  // embedded mode already, keep their arguments as given.
  for (const args of [['exec', 'hi'], ['--remote', 'ws://127.0.0.1:9', 'agents'], ['agents', '--no-daemon']]) {
    const built = launch(args, true);
    assert.equal(built.args.filter((arg) => arg === '--no-daemon').length, args.includes('--no-daemon') ? 1 : 0);
    assert.equal(built.sidecar, undefined, args.join(' '));
    assert.deepEqual(built.args.slice(-args.length), args);
  }
});

test('codex agents gets a private app server carrying the provider on a Codex with the daemon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-agents-unit-'));
  try {
    const built = launch(['-c', 'model_reasoning_effort="high"', 'agents', '--enable', 'x'], true, () => dir);
    const listen = `unix://${path.join(dir, 'app-server.sock')}`;
    const remote = built.args.indexOf('--remote');
    assert.equal(built.args[remote + 1], listen);
    assert.ok(remote < built.args.indexOf('agents'));
    assert.equal(built.sidecar.socketPath, path.join(dir, 'app-server.sock'));
    const server = built.sidecar.args;
    for (const value of ROUTING) assert.ok(server.includes(value), value);
    assert.ok(server.includes('features.enable_request_compression=false'));
    assert.deepEqual(server.slice(-3), ['app-server', '--listen', listen]);
    // The user's own settings reach the server too, not only the TUI.
    assert.ok(server.includes('model_reasoning_effort="high"'));
    assert.deepEqual(server.slice(server.indexOf('--enable'), server.indexOf('--enable') + 2), ['--enable', 'x']);
    assert.equal(server.includes('agents'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex without the daemon launches exactly as before', () => {
  const overrides = launch([], false).args;
  assert.ok(overrides.includes('model_provider="kenari_router"'));
  assert.equal(overrides.includes('--no-daemon'), false);
  for (const args of [['agents'], ['resume', '--last']]) {
    const built = launch(args, false);
    assert.deepEqual(built.args, [...overrides, ...args]);
    assert.equal(built.sidecar, undefined);
  }
});

test('routing overrides are refused for codex agents too', () => {
  for (const args of [
    ['agents', '-c', 'model_provider="openai"'],
    ['agents', '--config=model_providers.kenari_router.base_url="https://x"'],
    ['agents', '--enable', 'enable_request_compression'],
  ]) {
    assert.throws(() => launch(args, true, () => '/tmp/unused'), /unsafe Codex routing override/, args.join(' '));
  }
});

test('codexSubcommand skips root flag values', () => {
  assert.equal(codexSubcommand(['-c', 'a=b', '--enable', 'x', 'agents']), 'agents');
  assert.equal(codexSubcommand(['-m', 'agents']), null);
  assert.equal(codexSubcommand(['--model=gpt', 'resume']), 'resume');
  assert.equal(codexSubcommand(['--', 'agents']), null);
});

test('daemon support is read from codex --help and a failed probe means no daemon', () => {
  const reply = (result) => () => result;
  assert.equal(codexSupportsDaemon('codex', {}, reply({ status: 0, stdout: '      --no-daemon\n          Run without' })), true);
  assert.equal(codexSupportsDaemon('codex', {}, reply({ status: 0, stdout: '      --no-alt-screen\n' })), false);
  assert.equal(codexSupportsDaemon('codex', {}, reply({ status: 1, stdout: '--no-daemon' })), false);
  assert.equal(codexSupportsDaemon('codex', {}, reply({ error: new Error('ENOENT') })), false);
});

test('codexSocketLeftovers names the socket Codex binds for the requested path', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-agents-unit-'));
  try {
    const socketPath = path.join(dir, 'app-server.sock');
    const hash = createHash('sha256')
      .update(path.join(fs.realpathSync(dir), 'app-server.sock'))
      .digest('hex');
    const physical = path.join(fs.realpathSync('/tmp'), `codex-daemon-${process.geteuid()}`, hash);
    assert.deepEqual(codexSocketLeftovers(socketPath), [physical, `${physical}.lock`]);
    assert.deepEqual(codexSocketLeftovers(socketPath, 'win32'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
