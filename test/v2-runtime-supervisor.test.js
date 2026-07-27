import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildClaudeLaunch, findClaudeEnvConflicts } from '../src/runtime/claude.js';
import { buildCodexLaunch, codexKenariModels } from '../src/runtime/codex.js';
import { resolveBinary, runWrappedTool } from '../src/supervisor.js';

const originalAllowHttp = process.env.KENARI_ALLOW_HTTP;
test.before(() => { process.env.KENARI_ALLOW_HTTP = '1'; });
test.after(() => {
  if (originalAllowHttp === undefined) delete process.env.KENARI_ALLOW_HTTP;
  else process.env.KENARI_ALLOW_HTTP = originalAllowHttp;
});

const claudeRoles = {
  main: { mode: 'native' },
  opus: { mode: 'fixed', model: 'kenari/gpt-5' },
  sonnet: { mode: 'native' },
  haiku: { mode: 'native' },
  fable: { mode: 'native' },
  subagents: { mode: 'fixed', model: 'kenari/glm-5' },
};

const claudeEnvByRole = {
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  subagents: 'CLAUDE_CODE_SUBAGENT_MODEL',
};

for (const [role, variable] of Object.entries(claudeEnvByRole)) {
  test(`Claude ${role} role maps independently`, () => {
    const roles = Object.fromEntries(
      Object.keys(claudeEnvByRole).map((id) => [id, { mode: 'native' }]),
    );
    roles[role] = { mode: 'fixed', model: `kenari/${role}-model` };
    const built = buildClaudeLaunch({
      toolConfig: { roles },
      routerUrl: 'http://127.0.0.1:1',
      env: {},
    });
    assert.equal(built.env[variable], `kenari/${role}-model`);
    for (const [otherRole, otherVariable] of Object.entries(claudeEnvByRole)) {
      if (otherRole !== role) assert.equal(built.env[otherVariable], undefined);
    }
  });
}

for (const [role, key] of [
  ['main', 'model="kenari/main-model"'],
  ['review', 'review_model="kenari/review-model"'],
  ['subagents', 'agents.default_subagent_model="kenari/subagents-model"'],
]) {
  test(`Codex ${role} role maps independently`, () => {
    const roles = {
      main: { mode: 'native' },
      review: { mode: 'inherit' },
      subagents: { mode: 'inherit' },
    };
    roles[role] = { mode: 'fixed', model: `kenari/${role}-model` };
    const built = buildCodexLaunch({
      toolConfig: { roles },
      routerUrl: 'http://127.0.0.1:2',
      env: {},
    });
    assert.ok(built.args.includes(key));
  });
}

test('Claude launch layers only fixed roles and removes credential environment', () => {
  const original = {
    PATH: '/bin',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'user-sonnet',
    ANTHROPIC_API_KEY: 'secret',
  };
  assert.deepEqual(findClaudeEnvConflicts(original), ['ANTHROPIC_API_KEY']);
  assert.throws(() => buildClaudeLaunch({
    toolConfig: { roles: claudeRoles }, routerUrl: 'http://127.0.0.1:1', env: original,
  }), /ambiguous/);
  const built = buildClaudeLaunch({
    toolConfig: { roles: claudeRoles },
    routerUrl: 'http://127.0.0.1:1',
    routerCapabilityToken: 'capability',
    env: original,
    allowAmbiguousEnv: true,
    args: ['-p', 'hello'],
  });
  assert.deepEqual(built.args, ['-p', 'hello']);
  assert.equal(built.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  assert.equal(built.env.ANTHROPIC_CUSTOM_HEADERS, 'X-Kenari-Capability: capability');
  assert.equal(built.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(built.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kenari/gpt-5');
  assert.equal(built.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'user-sonnet');
  assert.equal(built.env.CLAUDE_CODE_SUBAGENT_MODEL, 'kenari/glm-5');
  assert.throws(() => buildClaudeLaunch({
    toolConfig: { roles: claudeRoles },
    routerUrl: 'http://127.0.0.1:1',
    env: {},
    args: ['--fallback-model', 'sonnet'],
  }), /fallback models are disabled/);
});

test('Codex launch injects temporary controls before original args', () => {
  const built = buildCodexLaunch({
    toolConfig: {
      roles: {
        main: { mode: 'picker' },
        review: { mode: 'fixed', model: 'kenari/reviewer' },
        subagents: { mode: 'inherit' },
      },
    },
    routerUrl: 'http://127.0.0.1:2',
    catalogPath: '/tmp/catalog.json',
    args: ['exec', '-c', 'review_model="native-review"', 'hello'],
    env: { OPENAI_API_KEY: 'secret', KEEP: 'yes' },
  });
  assert.deepEqual(built.args.slice(-4), ['exec', '-c', 'review_model="native-review"', 'hello']);
  assert.ok(built.args.indexOf('review_model="kenari/reviewer"') < built.args.indexOf('exec'));
  assert.ok(built.args.includes('openai_base_url="http://127.0.0.1:2"'));
  assert.equal(built.env.OPENAI_API_KEY, 'secret');
  assert.equal(built.env.KEEP, 'yes');
  const native = [{
    slug: 'gpt-native',
    supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
    context_window: 100000,
    max_context_window: 100000,
  }];
  const kenari = codexKenariModels({ models: [{ id: 'gpt-5', context_limit: 200000 }] }, native)[0];
  assert.equal(kenari.slug, 'kenari/gpt-5');
  assert.equal(kenari.context_window, 200000);
  assert.throws(() => buildCodexLaunch({
    toolConfig: { roles: {} },
    routerUrl: 'http://127.0.0.1:2',
    args: ['-c', 'openai_base_url="https://bypass.example"'],
  }), /unsafe Codex routing override/);
});

test('resolveBinary skips excluded wrapper and supervisor returns child exit code', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'tool');
  fs.symlinkSync(process.execPath, first);
  assert.throws(() => resolveBinary('tool', { env: { PATH: dir }, exclude: [first] }), /not found/);
  assert.equal(resolveBinary('tool', { env: { PATH: dir } }), fs.realpathSync(first));

  const upstream = http.createServer((_req, res) => res.end());
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const code = await runWrappedTool({
    binary: process.execPath,
    args: ['-e', 'process.exit(7)'],
    env: process.env,
    routerOptions: { nativeBase: base, kenariBase: base, catalog: { models: [] } },
    runtimeBuilder: ({ args, env }) => ({ args, env }),
  });
  assert.equal(code, 7);
});
