import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-contract-'));
  process.env.KENARI_HOME = path.join(home, 'kh');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
});

const KEY = 'kn-contracttest1234';

function sseGateway(seen) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body });
        res.setHeader('content-type', 'text/event-stream');
        if (req.url === '/v1/messages') {
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"t1","function":{"name":"ls","arguments":"{}"}}]}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      });
    });
    s.unref();
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
}

test('claude config drives a correct /v1/messages request', async () => {
  const seen = [];
  process.env.KENARI_BASE_URL = await sseGateway(seen);
  const claude = (await import('../src/adapters/claude.js')).default;
  claude.apply({ opus: 'glm-5-2', sonnet: 'kimi-k2-7-code', haiku: 'deepseek-v4-flash' }, KEY);
  // driver: reconstruct the request the way Claude Code does from settings.json env
  const env = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).env;
  const res = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.ANTHROPIC_AUTH_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.ANTHROPIC_DEFAULT_SONNET_MODEL, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /message_stop/);
  assert.equal(seen[0].url, '/v1/messages');
  assert.equal(seen[0].auth, 'Bearer ' + KEY);
  assert.match(seen[0].body, /"model":"kimi-k2-7-code"/);
});

test('codex config drives a correct chat/completions request with tool call stream', async () => {
  const seen = [];
  process.env.KENARI_BASE_URL = await sseGateway(seen);
  const codex = (await import('../src/adapters/codex.js')).default;
  codex.apply({ model: 'glm-5-2' }, KEY);
  const toml = await import('../src/toml.js');
  const content = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  const table = toml.getTableText(content, 'model_providers.kenari');
  const baseUrl = table.match(/base_url = "([^"]+)"/)[1];
  const authHeader = table.match(/"Authorization" = "([^"]+)"/)[1];
  const model = toml.getTopLevel(content, 'model');
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }], tools: [] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /tool_calls/);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer ' + KEY);
  assert.match(seen[0].body, /"model":"glm-5-2"/);
});
