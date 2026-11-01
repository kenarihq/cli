import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KENARI = fileURLToPath(new URL('../bin/kenari.js', import.meta.url));
const servers = [];
after(() => { for (const server of servers) server.close(); });

// Stands in for Codex across the whole launch: the help probe, login status, the model
// catalog, `app-server --listen unix://PATH` and the TUI. Each call that matters is
// appended to STUB_LOG as one JSON line.
const STUB = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
if (args[0] === '--help') {
  console.log('Usage: codex [OPTIONS] [PROMPT]');
  if (process.env.STUB_CODEX_DAEMON === '1') console.log('      --no-daemon  Run without the shared background server');
  process.exit(0);
}
if (args[0] === 'login') { console.log('Logged in using an API key'); process.exit(0); }
if (args[0] === 'debug') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-5', supported_reasoning_levels: [] }] }));
  process.exit(0);
}
const listen = args.indexOf('--listen');
if (args.includes('app-server') && listen >= 0) {
  const socketPath = args[listen + 1].slice('unix://'.length);
  log({ role: 'app-server', args });
  if (process.env.STUB_SERVER_FAIL === '1') {
    console.error('failed to bind the control socket');
    process.exit(1);
  }
  process.on('SIGTERM', () => {
    log({ role: 'app-server', event: 'sigterm' });
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
  // Ready only after a short delay, so the TUI must have been held until now.
  setTimeout(() => fs.writeFileSync(socketPath, ''), 150);
  setInterval(() => {}, 1000);
} else {
  const remote = args.indexOf('--remote');
  const socketPath = remote >= 0 ? args[remote + 1].slice('unix://'.length) : null;
  log({ role: 'tui', args, socketReady: socketPath ? fs.existsSync(socketPath) : null });
  if (process.env.STUB_TUI_WAIT === '1') {
    process.on('SIGTERM', () => { log({ role: 'tui', event: 'sigterm' }); process.exit(0); });
    setInterval(() => {}, 1000);
  } else {
    process.exit(Number(process.env.STUB_TUI_EXIT || 0));
  }
}
`;

function writeStubCodex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'codex-stub.cjs');
  fs.writeFileSync(script, STUB);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
}

async function stubCatalog() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/models') { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'glm-5-2', pricing: {}, reasoning_options: ['high'] }] }));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, { daemon }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-agents-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  writeStubCodex(bin);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    KENARI_HOME: path.join(home, 'kenari'),
    CODEX_HOME: path.join(home, 'codex-home'),
    KENARI_BASE_URL: await stubCatalog(),
    KENARI_ALLOW_HTTP: '1',
    STUB_LOG: path.join(home, 'stub.log'),
    STUB_CODEX_DAEMON: daemon ? '1' : '0',
  };
  fs.mkdirSync(env.KENARI_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.KENARI_HOME, 'credentials.json'), JSON.stringify({ api_key: 'kn-testkey123' }));
  // Asynchronous, because the catalog it asks for is served from this process.
  const configured = launch(env, [
    'configure', 'codex',
    '--main', 'kenari/glm-5-2', '--review', 'inherit', '--subagents', 'inherit', '--yes',
  ], []);
  assert.equal(await configured.exited, 0, configured.stderr());
  return env;
}

function readLog(env) {
  if (!fs.existsSync(env.STUB_LOG)) return [];
  return fs.readFileSync(env.STUB_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function launch(env, args, command = ['codex']) {
  const child = spawn(process.execPath, [KENARI, ...command, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, stderr: () => stderr };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function refuses(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

async function assertPrivateServerRun(env) {
  const entries = readLog(env);
  const server = entries.find((entry) => entry.role === 'app-server' && entry.args);
  const tui = entries.find((entry) => entry.role === 'tui' && entry.args);
  assert.ok(server, 'agents must start a private app server');
  assert.ok(tui, 'the TUI must run');
  const listen = server.args[server.args.indexOf('--listen') + 1];
  assert.match(listen, /^unix:\/\/.+app-server\.sock$/);
  // The server is the process that creates threads, so it carries the provider.
  assert.ok(server.args.includes('model_provider="kenari_router"'));
  const baseUrl = server.args.find((arg) => arg.startsWith('model_providers.kenari_router.base_url='));
  assert.ok(baseUrl, 'the private server gets the router address');
  assert.ok(server.args.some((arg) => arg.startsWith('model_catalog_json=')));
  assert.equal(tui.args[tui.args.indexOf('--remote') + 1], listen);
  assert.ok(tui.args.indexOf('--remote') < tui.args.indexOf('agents'));
  assert.equal(tui.socketReady, true, 'the TUI starts only once the server listens');
  // Stopped and cleaned up with the session.
  assert.ok(entries.some((entry) => entry.role === 'app-server' && entry.event === 'sigterm'));
  assert.equal(alive(server.pid), false, 'the app server must not outlive the session');
  const socketPath = listen.slice('unix://'.length);
  assert.equal(fs.existsSync(path.dirname(socketPath)), false, 'the private directory is removed');
  assert.equal(await refuses(JSON.parse(baseUrl.split('=').slice(1).join('='))), true, 'the router is closed');
}

test('kenari codex agents runs on a private app server that stops when the TUI exits', async (t) => {
  const env = await setup(t, { daemon: true });
  // A non-zero exit is the crash case: cleanup must not depend on a clean exit.
  const run = launch({ ...env, STUB_TUI_EXIT: '3' }, ['agents']);
  assert.equal(await run.exited, 3, run.stderr());
  assert.match(run.stderr(), /private Codex app server/);
  await assertPrivateServerRun(env);
});

test('SIGTERM to kenari codex agents stops the TUI, the app server and the router', { skip: process.platform === 'win32' }, async (t) => {
  const env = await setup(t, { daemon: true });
  const run = launch({ ...env, STUB_TUI_WAIT: '1' }, ['agents']);
  const deadline = Date.now() + 15000;
  while (!readLog(env).some((entry) => entry.role === 'tui') && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  run.child.kill('SIGTERM');
  assert.equal(await run.exited, 0, run.stderr());
  assert.ok(readLog(env).some((entry) => entry.role === 'tui' && entry.event === 'sigterm'));
  await assertPrivateServerRun(env);
});

test('plain kenari codex runs embedded on a Codex with the daemon, and nothing changes without it', async (t) => {
  const env = await setup(t, { daemon: true });
  const plain = launch(env, []);
  assert.equal(await plain.exited, 0, plain.stderr());
  let entries = readLog(env);
  assert.equal(entries.some((entry) => entry.role === 'app-server'), false);
  assert.ok(entries.find((entry) => entry.role === 'tui').args.includes('--no-daemon'));

  const old = await setup(t, { daemon: false });
  for (const args of [[], ['agents']]) {
    fs.rmSync(old.STUB_LOG, { force: true });
    const run = launch(old, args);
    assert.equal(await run.exited, 0, run.stderr());
    entries = readLog(old);
    assert.equal(entries.some((entry) => entry.role === 'app-server'), false, args.join(' '));
    const tui = entries.find((entry) => entry.role === 'tui');
    assert.equal(tui.args.includes('--no-daemon'), false);
    assert.equal(tui.args.includes('--remote'), false);
  }
});

test('an app server that fails to start ends the run before the TUI and leaves nothing behind', async (t) => {
  const env = await setup(t, { daemon: true });
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('kenari-run-')));
  const run = launch({ ...env, STUB_SERVER_FAIL: '1' }, ['agents']);
  assert.equal(await run.exited, 1);
  assert.match(run.stderr(), /the Codex app server did not start: failed to bind the control socket/);
  assert.equal(readLog(env).some((entry) => entry.role === 'tui'), false);
  const left = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('kenari-run-') && !before.has(name));
  assert.deepEqual(left, []);
});
