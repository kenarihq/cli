import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const servers = [];
function stub(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
}
after(() => servers.forEach((s) => s.close()));

test('fetchModels: happy path maps pricing and context', async () => {
  const base = await stub((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer kn-testkey123');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'glm-5-2', pricing: { input: 13600000000, output: 43200000000, cache_read: 3400000000, cache_write: 17000000000, free: false, currency: 'IDR', unit: 'micro_idr_per_1m_tokens' }, context_length: 1048576 },
      { id: 'gpt-image-2' },
    ]}));
  });
  process.env.KENARI_BASE_URL = base;
  const { fetchModels } = await import('../src/gateway.js');
  const models = await fetchModels('kn-testkey123');
  assert.deepEqual(models[0], { id: 'glm-5-2', in: 13600000000, out: 43200000000, context: 1048576 });
  assert.deepEqual(models[1], { id: 'gpt-image-2', in: null, out: null, context: null });
});

test('fetchModels: unknown pricing unit maps in/out to null (no garbage rupiah)', async () => {
  const base = await stub((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'weird-model', pricing: { input: 5000000000, unit: 'usd_per_token' }, context_length: 1000 },
    ]}));
  });
  process.env.KENARI_BASE_URL = base;
  const { fetchModels } = await import('../src/gateway.js');
  const models = await fetchModels('kn-testkey123');
  assert.deepEqual(models[0], { id: 'weird-model', in: null, out: null, context: 1000 });
});

test('fetchModels: 401 raises AuthError, 500 raises KenariError, refused raises KenariError', async () => {
  const { fetchModels, AuthError } = await import('../src/gateway.js');
  const { KenariError } = await import('../src/store.js');
  const unauth = await stub((req, res) => { res.statusCode = 401; res.end('{}'); });
  process.env.KENARI_BASE_URL = unauth;
  await assert.rejects(fetchModels('kn-bad'), AuthError);
  const boom = await stub((req, res) => { res.statusCode = 500; res.end('{}'); });
  process.env.KENARI_BASE_URL = boom;
  await assert.rejects(fetchModels('kn-x'), KenariError);
  process.env.KENARI_BASE_URL = 'http://127.0.0.1:1';
  await assert.rejects(fetchModels('kn-x'), KenariError);
});

test('formatRp', async () => {
  const { formatRp } = await import('../src/gateway.js');
  assert.equal(formatRp(13600000000), 'Rp13.600');
  assert.equal(formatRp(null), '-');
});
