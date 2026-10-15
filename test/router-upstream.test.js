import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { describeUpstreamError, shouldRetryUpstream, startRouter } from '../src/router.js';

const originalAllowHttp = process.env.KENARI_ALLOW_HTTP;
test.before(() => { process.env.KENARI_ALLOW_HTTP = '1'; });
test.after(() => {
  if (originalAllowHttp === undefined) delete process.env.KENARI_ALLOW_HTTP;
  else process.env.KENARI_ALLOW_HTTP = originalAllowHttp;
});

// Before Node 19 the global agent opens a new connection for every request. There is no
// pooled socket for a server to close, so the stale socket cases have nothing to exercise.
const needsPool = http.globalAgent.keepAlive === true
  ? false
  : 'http.globalAgent does not keep connections alive before Node 19';

const SECRETS = ['kn-secret123', 'Bearer', 'authorization', 'prompt-text-do-not-echo'];

function collectRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// A port that was open a moment ago and now refuses connections.
async function closedBase() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// Records every request that reaches the server: the marker the test put in the body, and
// whether its connection had already carried a request. That is what tells a re-send on a
// new connection from a replay on the same one. `behave` decides what happens to it.
async function trackedUpstream(t, behave) {
  const arrivals = [];
  const carried = new WeakSet();
  const base = await listen(t, async (req, res) => {
    const raw = await collectRaw(req);
    const { marker } = JSON.parse(raw.toString('utf8'));
    const arrival = {
      marker, reusedConnection: carried.has(req.socket), outcome: 'served', raw, headers: req.headers,
    };
    carried.add(req.socket);
    arrivals.push(arrival);
    behave({ req, res, arrival });
  });
  return { base, arrivals };
}

function serve(res, marker) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, marker }));
}

// Closes the connection without a word, the way a server does to a socket it gave up on.
function drop(req, arrival) {
  arrival.outcome = 'dropped';
  req.socket.destroy();
}

function summary(arrivals) {
  return arrivals.map(({ marker, reusedConnection, outcome }) => [marker, reusedConnection, outcome]);
}

async function routerTo(t, base, extra = {}) {
  const router = await startRouter({
    nativeBase: base,
    kenariBase: base,
    credential: 'kn-secret123',
    catalog: { models: [{ id: 'glm-5-2' }] },
    ...extra,
  });
  t.after(() => router.close());
  return router;
}

function ask(router, marker, { model = 'kenari/glm-5-2', signal } = {}) {
  return fetch(router.url + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-header': 'kept' },
    body: JSON.stringify({ model, marker, prompt: 'prompt-text-do-not-echo' }),
    signal,
  });
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A wrongly re-sent call lands within milliseconds, so this is long enough to see one.
const quiet = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// Failure naming

test('router 502 names the cause and the host when the upstream refuses the connection', async (t) => {
  const lines = [];
  const router = await routerTo(t, await closedBase(), { debug: (line) => lines.push(line) });

  const response = await ask(router, 'refused');
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const { error } = await response.json();
  assert.match(error.message, /^Kenari upstream error/);
  assert.match(error.message, /ECONNREFUSED/);
  assert.equal(
    error.message,
    'Kenari upstream error (ECONNREFUSED connecting to 127.0.0.1). '
      + 'Check your internet connection, VPN or proxy, then try again.',
  );
  assert.ok(!error.message.includes(';'));
  for (const secret of SECRETS) {
    assert.ok(!error.message.toLowerCase().includes(secret.toLowerCase()), `leaked ${secret}`);
  }

  // The debug hook crosses the fork IPC, so wait for the line instead of racing it.
  await until(() => lines.some((line) => line.startsWith('upstream-error')));
  const line = lines.find((entry) => entry.startsWith('upstream-error'));
  assert.equal(line, 'upstream-error route=kenari host=127.0.0.1 cause=ECONNREFUSED retried=false');
  for (const secret of SECRETS) {
    assert.ok(!line.toLowerCase().includes(secret.toLowerCase()), `leaked ${secret} into the log`);
  }
});

test('router 502 on a native route carries the same detail under its own name', async (t) => {
  const router = await routerTo(t, await closedBase());
  const response = await ask(router, 'refused', { model: 'claude-opus-5' });
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.equal(
    error.message,
    'native upstream error (ECONNREFUSED connecting to 127.0.0.1). '
      + 'Check your internet connection, VPN or proxy, then try again.',
  );
});

test('describeUpstreamError gives the cause, the host and what to try, for Kenari and for native', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 104.18.0.1:443'), { code: 'ECONNREFUSED' });
  assert.equal(
    describeUpstreamError(refused, { kenari: true, hostname: 'kenari.id' }),
    'Kenari upstream error (ECONNREFUSED connecting to kenari.id). '
      + 'Check your internet connection, VPN or proxy, then try again.',
  );
  assert.equal(
    describeUpstreamError(refused, { kenari: false, hostname: 'api.anthropic.com' }),
    'native upstream error (ECONNREFUSED connecting to api.anthropic.com). '
      + 'Check your internet connection, VPN or proxy, then try again.',
  );
});

test('describeUpstreamError falls back to a trimmed one line message, never a semicolon', () => {
  const long = new Error(`first line\n  second; line ${'x'.repeat(300)}`);
  const text = describeUpstreamError(long, { kenari: true, hostname: 'kenari.id' });
  assert.ok(!text.includes(';'));
  assert.ok(!text.includes('\n'));
  const cause = text.slice('Kenari upstream error ('.length, text.indexOf(' connecting to'));
  assert.ok(cause.startsWith('first line second, line xxx'), cause);
  assert.ok(cause.endsWith('...'), cause);
  assert.ok(cause.length <= 123, `${cause.length} chars`);

  const short = describeUpstreamError(new Error('socket closed'), { kenari: true, hostname: 'kenari.id' });
  assert.match(short, /^Kenari upstream error \(socket closed connecting to kenari\.id\)\. /);
  // An error with nothing to say still names the host.
  assert.match(describeUpstreamError({}, { kenari: true, hostname: 'kenari.id' }), /\(unknown error connecting to kenari\.id\)/);
  assert.match(describeUpstreamError(undefined, { kenari: false, hostname: 'x.test' }), /^native upstream error \(unknown error /);
});

// The one retry

test('shouldRetryUpstream: only a pooled socket reset before any response, first try, client present', () => {
  const retrying = {
    reusedSocket: true, code: 'ECONNRESET', received: false, retried: false, clientGone: false,
  };
  assert.equal(shouldRetryUpstream(retrying), true);
  let cells = 0;
  for (const reusedSocket of [true, false, undefined]) {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', undefined]) {
      for (const received of [true, false]) {
        for (const retried of [true, false]) {
          for (const clientGone of [true, false]) {
            const cell = { reusedSocket, code, received, retried, clientGone };
            cells += 1;
            assert.equal(shouldRetryUpstream(cell), isDeepStrictEqual(cell, retrying), JSON.stringify(cell));
          }
        }
      }
    }
  }
  assert.equal(cells, 96);
});

test('router sends a request once more on a new connection when a pooled socket was closed on it', { skip: needsPool }, async (t) => {
  // The server closes without a reply the second time a connection is used. That is what
  // Cloudflare does to a keep-alive connection the router still believes is open.
  const { base, arrivals } = await trackedUpstream(t, ({ req, res, arrival }) => {
    if (arrival.reusedConnection) drop(req, arrival);
    else serve(res, arrival.marker);
  });
  const lines = [];
  const router = await routerTo(t, base, { debug: (line) => lines.push(line) });

  const first = await ask(router, 'first');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, marker: 'first' });
  const second = await ask(router, 'second');
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, marker: 'second' });

  // The second request reached the server twice: dropped on the pooled connection, served
  // on a new one. Its successful attempt happened exactly once.
  assert.deepEqual(summary(arrivals), [
    ['first', false, 'served'],
    ['second', true, 'dropped'],
    ['second', false, 'served'],
  ]);
  // Same bytes and same headers, credential included, on the second attempt as on the first.
  const [, dropped, resent] = arrivals;
  assert.equal(JSON.parse(resent.raw.toString('utf8')).model, 'glm-5-2');
  assert.ok(dropped.raw.equals(resent.raw), 'the payload must be the same bytes');
  assert.deepEqual(resent.headers, dropped.headers);
  assert.equal(resent.headers.authorization, 'Bearer kn-secret123');
  assert.equal(resent.headers['x-client-header'], 'kept');
  assert.equal(resent.headers['content-length'], String(resent.raw.length));

  await until(() => lines.some((line) => line.startsWith('upstream-retry')));
  assert.equal(
    lines.find((line) => line.startsWith('upstream-retry')),
    'upstream-retry route=kenari host=127.0.0.1 cause=ECONNRESET',
  );
  assert.ok(!lines.some((line) => line.startsWith('upstream-error')));
});

test('router reports a reset on a fresh connection and does not send the call again', async (t) => {
  const { base, arrivals } = await trackedUpstream(t, ({ req, arrival }) => drop(req, arrival));
  const router = await routerTo(t, base);

  const response = await ask(router, 'only');
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.match(error.message, /^Kenari upstream error/);
  assert.match(error.message, /ECONNRESET/);
  await quiet();
  assert.deepEqual(summary(arrivals), [['only', false, 'dropped']]);
});

test('router gives up when the one retry is reset too, so a call is never sent three times', { skip: needsPool }, async (t) => {
  // Two requests at once leave two pooled connections. Both are then closed by the server,
  // so the retry of the third request lands on a pooled socket that fails the same way.
  const held = [];
  const { base, arrivals } = await trackedUpstream(t, ({ req, res, arrival }) => {
    if (arrival.reusedConnection) {
      drop(req, arrival);
      return;
    }
    held.push({ res, marker: arrival.marker });
    if (held.length === 2) for (const { res: waiting, marker } of held) serve(waiting, marker);
  });
  const router = await routerTo(t, base);

  const pair = await Promise.all([ask(router, 'a'), ask(router, 'b')]);
  for (const response of pair) {
    assert.equal(response.status, 200);
    await response.json();
  }
  const third = await ask(router, 'third');
  assert.equal(third.status, 502);
  const { error } = await third.json();
  assert.match(error.message, /^Kenari upstream error/);
  assert.match(error.message, /ECONNRESET/);
  await quiet();
  assert.deepEqual(summary(arrivals).slice(2), [
    ['third', true, 'dropped'],
    ['third', true, 'dropped'],
  ]);
  assert.equal(arrivals.length, 4);
});

test('router does not send a call again once the upstream began to answer it', { skip: needsPool }, async (t) => {
  // Headers and a first chunk reach the router, then the connection is reset. The same
  // error code as a stale socket, but the upstream has started work, so it is not repeated.
  const { base, arrivals } = await trackedUpstream(t, ({ req, res, arrival }) => {
    if (arrival.marker === 'first') {
      serve(res, arrival.marker);
      return;
    }
    arrival.outcome = 'reset after the first chunk';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: partial\n\n', () => {
      setTimeout(() => (req.socket.resetAndDestroy || req.socket.destroy).call(req.socket), 50);
    });
  });
  const router = await routerTo(t, base);

  const first = await ask(router, 'first');
  assert.equal(first.status, 200);
  await first.json();
  const second = await ask(router, 'second');
  assert.equal(second.status, 200);
  await assert.rejects(second.text(), 'the stream must end in an error, not look complete');
  await quiet();
  assert.deepEqual(summary(arrivals), [
    ['first', false, 'served'],
    ['second', true, 'reset after the first chunk'],
  ]);
});

test('router does not send a call again when a pooled socket fails with anything but a reset', { skip: needsPool }, async (t) => {
  // Not a stale socket, a server that answers with something that is not HTTP. The call
  // reached it, so it is reported with its own cause and not repeated.
  const { base, arrivals } = await trackedUpstream(t, ({ req, res, arrival }) => {
    if (arrival.marker === 'first') {
      serve(res, arrival.marker);
      return;
    }
    arrival.outcome = 'answered with garbage';
    req.socket.end('this is not http\r\n\r\n');
  });
  const router = await routerTo(t, base);

  const first = await ask(router, 'first');
  await first.json();
  const second = await ask(router, 'second');
  assert.equal(second.status, 502);
  const { error } = await second.json();
  assert.match(error.message, /^Kenari upstream error \(HPE_[A-Z_]+ connecting to 127\.0\.0\.1\)\. /);
  await quiet();
  assert.deepEqual(summary(arrivals), [
    ['first', false, 'served'],
    ['second', true, 'answered with garbage'],
  ]);
});

test('router does not send a call again for a client that has already gone', { skip: needsPool }, async (t) => {
  // The pooled socket dies only after the client walked away. A second call would be
  // billed and nobody would read it.
  let held = null;
  const { base, arrivals } = await trackedUpstream(t, ({ req, res, arrival }) => {
    if (arrival.marker === 'first') {
      serve(res, arrival.marker);
      return;
    }
    arrival.outcome = 'held';
    held = { req, arrival };
  });
  const router = await routerTo(t, base);

  const first = await ask(router, 'first');
  await first.json();
  const controller = new AbortController();
  const pending = ask(router, 'second', { signal: controller.signal }).catch((error) => error);
  await until(() => held !== null);
  controller.abort();
  assert.equal((await pending).name, 'AbortError');
  await quiet();
  held.arrival.outcome = 'dropped';
  held.req.socket.destroy();
  await quiet();
  assert.deepEqual(summary(arrivals), [
    ['first', false, 'served'],
    ['second', true, 'dropped'],
  ]);
});
