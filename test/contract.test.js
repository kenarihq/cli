import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRouter } from '../src/router.js';

const servers = [];
process.env.KENARI_ALLOW_HTTP = '1';

after(() => {
  for (const server of servers) server.close();
});

function upstream(seen, label) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          label,
          url: req.url,
          authorization: req.headers.authorization,
          apiKey: req.headers['x-api-key'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: {"provider":"${label}","part":1}\n\n`);
        res.write(`data: {"provider":"${label}","part":2}\n\n`);
        res.end();
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function request(router, model, headers = {}, body = {}) {
  return fetch(`${router.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, stream: true, max_tokens: 128, ...body }),
  });
}

test('one router session isolates native and Kenari authentication', async () => {
  const seen = [];
  const nativeBase = await upstream(seen, 'native');
  const kenariBase = await upstream(seen, 'kenari');
  const router = await startRouter({
    nativeBase,
    kenariBase,
    credential: 'kn-contracttest1234',
    catalog: {
      models: [{
        id: 'glm-5-2',
        context_limit: 200000,
        output_limit: 32000,
        compatibility: {},
      }],
    },
  });
  try {
    const nativeResponse = await request(router, 'claude-sonnet-4-5', {
      authorization: 'Bearer native-session-token',
      'x-api-key': 'native-api-key',
    });
    assert.equal(nativeResponse.status, 200);
    assert.match(await nativeResponse.text(), /"provider":"native"/);

    const kenariResponse = await request(router, 'kenari/glm-5-2', {
      authorization: 'Bearer native-session-token',
      'x-api-key': 'native-api-key',
    });
    assert.equal(kenariResponse.status, 200);
    assert.match(await kenariResponse.text(), /"provider":"kenari"/);
  } finally {
    await router.close();
  }

  assert.equal(seen[0].label, 'native');
  assert.equal(seen[0].body.model, 'claude-sonnet-4-5');
  assert.equal(seen[0].authorization, 'Bearer native-session-token');
  assert.equal(seen[0].apiKey, 'native-api-key');

  assert.equal(seen[1].label, 'kenari');
  assert.equal(seen[1].body.model, 'glm-5-2');
  assert.equal(seen[1].authorization, 'Bearer kn-contracttest1234');
  assert.equal(seen[1].apiKey, undefined);
});

test('unknown Kenari model fails closed without upstream request', async () => {
  const seen = [];
  const nativeBase = await upstream(seen, 'native');
  const kenariBase = await upstream(seen, 'kenari');
  const router = await startRouter({
    nativeBase,
    kenariBase,
    credential: 'kn-contracttest1234',
    catalog: { models: [] },
  });
  try {
    const response = await request(router, 'kenari/missing');
    assert.equal(response.status, 400);
    assert.match(await response.text(), /unknown or unavailable/);
    assert.equal(seen.length, 0);
  } finally {
    await router.close();
  }
});

test('logged-out Kenari route fails while native route continues', async () => {
  const seen = [];
  const nativeBase = await upstream(seen, 'native');
  const kenariBase = await upstream(seen, 'kenari');
  const router = await startRouter({
    nativeBase,
    kenariBase,
    credential: null,
    catalog: { models: [{ id: 'glm-5-2' }] },
  });
  try {
    const denied = await request(router, 'kenari/glm-5-2');
    assert.equal(denied.status, 401);
    assert.match(await denied.text(), /kenari login/);

    const native = await request(router, 'gpt-5.4', {
      authorization: 'Bearer native-session-token',
    });
    assert.equal(native.status, 200);
    assert.match(await native.text(), /"provider":"native"/);
  } finally {
    await router.close();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'native');
});
