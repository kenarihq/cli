import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { sanitizeForkExecArgv, startRouter } from '../src/router.js';

const originalAllowHttp = process.env.KENARI_ALLOW_HTTP;
test.before(() => { process.env.KENARI_ALLOW_HTTP = '1'; });
test.after(() => {
  if (originalAllowHttp === undefined) delete process.env.KENARI_ALLOW_HTTP;
  else process.env.KENARI_ALLOW_HTTP = originalAllowHttp;
});

async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
  });
}

function collectRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('router isolates native and Kenari model, auth, headers, and token rewrites', async (t) => {
  const seen = [];
  const nativeBase = await upstream(t, async (req, res) => {
    const raw = await collectRaw(req);
    seen.push({ route: 'native', headers: req.headers, raw, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-route': 'native' });
    res.write('data: one\n\n');
    res.end('data: two\n\n');
  });
  const kenariBase = await upstream(t, async (req, res) => {
    seen.push({ route: 'kenari', headers: req.headers, body: await collect(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const router = await startRouter({
    nativeBase,
    kenariBase,
    credential: 'kn-secret123',
    catalog: { models: [{ id: 'gpt-5', output_limit: 128000 }] },
    compatibility: { 'gpt-5': { from: 32000, to: 128000 } },
  });
  t.after(() => router.close());

  const nativeBody = '{ "model": "gpt-5", "max_tokens": 32000 }\n';
  const native = await fetch(router.url + '/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer native-secret', 'content-type': 'application/json' },
    body: nativeBody,
  });
  assert.equal(native.status, 200);
  assert.equal(native.headers.get('x-route'), 'native');
  assert.equal(await native.text(), 'data: one\n\ndata: two\n\n');

  const kenari = await fetch(router.url + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer native-secret',
      'x-api-key': 'native-api-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'kenari/gpt-5', max_tokens: 32000 }),
  });
  assert.equal(kenari.status, 200);
  assert.deepEqual(await kenari.json(), { ok: true });

  assert.equal(seen[0].body.model, 'gpt-5');
  assert.equal(seen[0].raw.toString(), nativeBody);
  assert.equal(seen[0].body.max_tokens, 32000);
  assert.equal(seen[0].headers.authorization, 'Bearer native-secret');
  assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(seen[1].body.model, 'gpt-5');
  assert.equal(seen[1].body.max_tokens, 128000);
  assert.equal(seen[1].headers.authorization, 'Bearer kn-secret123');
  assert.equal(seen[1].headers['x-api-key'], undefined);
  assert.ok(router.childPid > 0);
});

test('router fails closed for unknown or logged-out Kenari model', async (t) => {
  let requests = 0;
  const base = await upstream(t, (_req, res) => { requests += 1; res.end(); });
  const router = await startRouter({
    nativeBase: base, kenariBase: base, credential: null,
    catalog: { models: [{ id: 'known' }] },
  });
  t.after(() => router.close());
  const unknown = await fetch(router.url, {
    method: 'POST', body: JSON.stringify({ model: 'kenari/missing' }),
  });
  assert.equal(unknown.status, 400);
  const loggedOut = await fetch(router.url, {
    method: 'POST', body: JSON.stringify({ model: 'kenari/known' }),
  });
  assert.equal(loggedOut.status, 401);
  assert.equal(requests, 0);
});

test('router capability rejects callers before reading credentials or forwarding', async (t) => {
  let requests = 0;
  const base = await upstream(t, (_req, res) => { requests += 1; res.end(); });
  const router = await startRouter({
    nativeBase: base, kenariBase: base, credential: 'kn-secret',
    capabilityToken: 'capability', catalog: { models: [] },
  });
  t.after(() => router.close());
  const response = await fetch(router.url, {
    method: 'POST', body: JSON.stringify({ model: 'native' }),
  });
  assert.equal(response.status, 403);
  assert.equal(requests, 0);
});

test('router child exits when wrapper parent IPC closes', async () => {
  const script = `
    import { startRouter } from './src/router.js';
    const router = await startRouter({
      nativeBase: 'http://127.0.0.1:9',
      kenariBase: 'http://127.0.0.1:9',
      catalog: { models: [] }
    });
    process.stdout.write(String(router.childPid) + '\\n', () => process.exit(0));
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, KENARI_ALLOW_HTTP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  const errors = [];
  parent.stdout.on('data', (chunk) => chunks.push(chunk));
  parent.stderr.on('data', (chunk) => errors.push(chunk));
  let parentCode;
  await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.once('exit', (code) => { parentCode = code; resolve(); });
  });
  const pid = Number(Buffer.concat(chunks).toString().trim());
  assert.equal(parentCode, 0, Buffer.concat(errors).toString());
  assert.ok(pid > 0, Buffer.concat(errors).toString());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('router child strips eval-only parent arguments', () => {
  assert.deepEqual(
    sanitizeForkExecArgv([
      '--trace-warnings',
      '--input-type=module',
      '-e',
      'import "./parent.js"',
      '--no-warnings',
    ]),
    ['--trace-warnings', '--no-warnings'],
  );
});
