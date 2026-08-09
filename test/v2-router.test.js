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

test('router strips Claude 1m markers from Kenari models before lookup and forwarding', async (t) => {
  const seen = [];
  const base = await upstream(t, async (req, res) => {
    seen.push(await collect(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const router = await startRouter({
    nativeBase: base,
    kenariBase: base,
    credential: 'kn-secret',
    catalog: { models: [{ id: 'minimax-m3' }] },
  });
  t.after(() => router.close());

  for (const marker of ['[1m]', '[1M]']) {
    const response = await fetch(router.url + '/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: `kenari/minimax-m3${marker}` }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }

  const native = await fetch(router.url + '/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-opus-5[1m]' }),
  });
  assert.equal(native.status, 200);
  assert.deepEqual(await native.json(), { ok: true });

  const malformed = await fetch(router.url + '/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'kenari/minimax-m3[1m]-extra' }),
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(
    seen.map((body) => body.model),
    ['minimax-m3', 'minimax-m3', 'claude-opus-5[1m]'],
  );
});

test('router terminates the client response when an upstream stream aborts', async (t) => {
  const base = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n');
    setImmediate(() => res.socket.destroy());
  });
  const router = await startRouter({
    nativeBase: base,
    kenariBase: base,
    catalog: { models: [] },
  });
  t.after(() => router.close());

  const response = await fetch(router.url + '/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-opus-5' }),
  });
  assert.equal(response.status, 200);

  let timeout;
  const outcome = await Promise.race([
    response.text().then(
      () => ({ completed: true }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), 1_000);
    }),
  ]);
  clearTimeout(timeout);

  assert.equal(outcome.timedOut, undefined, 'aborted stream must not remain open');
  assert.ok(outcome.error, 'aborted stream must reject the downstream reader');
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

// The gateway stamps x-kenari-gated-effort with the level that survived its capability
// gate. These go through startRouter, not startRouterServer, so the fork IPC is on the
// path: a callback that never crosses the boundary would pass a direct-call test and do
// nothing in a real session.
async function effortRouter(t, { gatedHeader, status = 200 } = {}) {
  const records = [];
  const seen = [];
  const nativeBase = await upstream(t, async (req, res) => {
    seen.push({ route: 'native', raw: await collectRaw(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const kenariBase = await upstream(t, async (req, res) => {
    seen.push({ route: 'kenari', raw: await collectRaw(req) });
    const headers = { 'content-type': 'application/json' };
    if (gatedHeader) headers['x-kenari-gated-effort'] = gatedHeader;
    res.writeHead(status, headers);
    res.end('{"ok":true}');
  });
  const router = await startRouter({
    nativeBase,
    kenariBase,
    credential: 'kn-secret123',
    catalog: { models: [{ id: 'glm-5-2' }, { id: 'gpt-5-6-luna' }] },
    onEffort: (record) => records.push(record),
  });
  t.after(() => router.close());
  return { router, records, seen };
}

function post(router, body) {
  return fetch(router.url + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A record only means something if both halves survive the fork, so settle rather than
// racing the IPC.
async function settle() {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 25));
}

test('router records the level asked for beside the level the gateway applied', async (t) => {
  // glm-5-2 advertises high and xhigh only, so a request for max comes back clamped.
  const { router, records } = await effortRouter(t, { gatedHeader: 'xhigh' });
  await post(router, {
    model: 'kenari/glm-5-2',
    max_tokens: 16,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
  });
  await settle();
  assert.equal(records.length, 1);
  assert.equal(records[0].model, 'glm-5-2');
  assert.equal(records[0].requested, 'max');
  assert.equal(records[0].gated, 'xhigh');
  assert.equal(records[0].status, 200);
  assert.ok(Number.isFinite(records[0].at));
});

test('router distinguishes an absent header from an absent request level', async (t) => {
  const { router, records } = await effortRouter(t);
  await post(router, {
    model: 'kenari/glm-5-2',
    max_tokens: 16,
    output_config: { effort: 'max' },
  });
  await settle();
  // No header is not the same as a header reading none: the first means the gateway
  // applied nothing, the second means it applied the none level.
  assert.equal(records[0].requested, 'max');
  assert.equal(records[0].gated, null);

  await post(router, { model: 'kenari/gpt-5-6-luna', max_tokens: 16 });
  await settle();
  assert.equal(records[1].requested, null);
  assert.equal(records[1].gated, null);
});

test('router records a non-200 rather than dropping it', async (t) => {
  const { router, records } = await effortRouter(t, { status: 503 });
  await post(router, {
    model: 'kenari/glm-5-2', max_tokens: 16, output_config: { effort: 'low' },
  });
  await settle();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 503);
  assert.equal(records[0].requested, 'low');
});

test('router reports an effort change, not every request', async (t) => {
  const { router, records } = await effortRouter(t, { gatedHeader: 'xhigh' });
  const body = {
    model: 'kenari/glm-5-2', max_tokens: 16, output_config: { effort: 'max' },
  };
  for (let i = 0; i < 3; i += 1) await post(router, body);
  await settle();
  assert.equal(records.length, 1, 'three identical requests are one record');

  await post(router, { ...body, output_config: { effort: 'low' } });
  await settle();
  assert.equal(records.length, 2, 'a changed level opens a new record');
  assert.equal(records[1].requested, 'low');
});

test('router records nothing for a native route', async (t) => {
  const { router, records } = await effortRouter(t, { gatedHeader: 'max' });
  await post(router, { model: 'gpt-5-6-luna', max_tokens: 16, output_config: { effort: 'max' } });
  await settle();
  assert.equal(records.length, 0);
});

test('recording the effort does not disturb what is forwarded', async (t) => {
  const { router, seen } = await effortRouter(t, { gatedHeader: 'xhigh' });
  const nativeBody = '{ "model": "gpt-5-6-luna", "output_config": { "effort": "max" } }\n';
  await fetch(router.url + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: nativeBody,
  });
  // Native is byte for byte, whitespace and all.
  assert.equal(seen[0].raw.toString(), nativeBody);

  const original = {
    model: 'kenari/glm-5-2',
    max_tokens: 16,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
  };
  await post(router, original);
  await settle();
  // Kenari differs only in the model id. The level rides through untouched: the CLI
  // never clamps, strips, or injects, or the recorded pair would be a lie.
  assert.deepEqual(JSON.parse(seen[1].raw.toString()), { ...original, model: 'glm-5-2' });
});
