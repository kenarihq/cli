import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildClaudeLaunch, findClaudeEnvConflicts } from '../src/runtime/claude.js';
import {
  CODEX_API_BASE_URL,
  CODEX_CHATGPT_BASE_URL,
  buildCodexLaunch,
  codexKenariModels,
  resolveCodexNativeBase,
} from '../src/runtime/codex.js';
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
  assert.ok(built.args.includes('model_provider="kenari_router"'));
  assert.ok(built.args.includes(
    'model_providers.kenari_router.base_url="http://127.0.0.1:2"',
  ));
  assert.ok(built.args.includes('model_providers.kenari_router.requires_openai_auth=true'));
  assert.ok(built.args.includes('model_providers.kenari_router.supports_websockets=false'));
  assert.ok(built.args.includes('features.enable_request_compression=false'));
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
  for (const args of [
    ['-c', 'features.enable_request_compression=true'],
    ['--config=features.enable_request_compression=true'],
    ['--enable', 'enable_request_compression'],
    ['--enable=enable_request_compression'],
  ]) {
    assert.throws(() => buildCodexLaunch({
      toolConfig: { roles: {} },
      routerUrl: 'http://127.0.0.1:2',
      args,
    }), /unsafe Codex routing override/, args.join(' '));
  }
});

test('codexKenariModels removes OpenAI-private mode fields and matches dotted native slugs', () => {
  const native = [{
    slug: 'gpt-5.6-sol',
    tool_mode: 'code_mode',
    use_responses_lite: true,
    multi_agent_version: 'v2',
    supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
    context_window: 100000,
    max_context_window: 100000,
    priority: 10,
  }, {
    slug: 'gpt-5.5',
    supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
    context_window: 100000,
    max_context_window: 100000,
    priority: 5,
  }];
  const kenari = codexKenariModels({
    models: [
      { id: 'gpt-5-6-sol', context_limit: 200000, reasoning_options: ['medium', 'high'] },
      { id: 'glm-5-2', context_limit: 128000, reasoning_options: null },
    ],
  }, native);
  const sol = kenari.find((m) => m.slug === 'kenari/gpt-5-6-sol');
  assert.ok(sol, 'gpt-5-6-sol entry exists');
  assert.equal(sol.context_window, 200000);
  assert.equal(sol.priority, 11);
  assert.equal('tool_mode' in sol, false);
  assert.equal('multi_agent_version' in sol, false);
  assert.equal(sol.use_responses_lite, false);
  assert.deepEqual(sol.supported_reasoning_levels, [
    { effort: 'medium', description: 'medium reasoning' },
    { effort: 'high', description: 'high reasoning' },
  ]);
  assert.equal(sol.max_context_window, 200000);

  const glm = kenari.find((m) => m.slug === 'kenari/glm-5-2');
  assert.ok(glm, 'glm-5-2 entry exists');
  assert.equal(glm.context_window, 128000);
  assert.equal('tool_mode' in glm, false);
  assert.equal('multi_agent_version' in glm, false);
  assert.equal(glm.use_responses_lite, false);
});

test('Codex native upstream follows the active login method', () => {
  const cases = [
    {
      name: 'ChatGPT stdout',
      result: { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' },
      expected: CODEX_CHATGPT_BASE_URL,
    },
    {
      name: 'ChatGPT after warning',
      result: {
        status: 0,
        stdout: 'Logged in using ChatGPT\n',
        stderr: 'WARNING: could not create PATH aliases\n',
      },
      expected: CODEX_CHATGPT_BASE_URL,
    },
    {
      name: 'API key',
      result: { status: 0, stdout: 'Logged in using an API key\n', stderr: '' },
      expected: CODEX_API_BASE_URL,
    },
  ];
  for (const entry of cases) {
    const calls = [];
    const base = resolveCodexNativeBase('/bin/codex', {}, (...args) => {
      calls.push(args);
      return entry.result;
    });
    assert.equal(base, entry.expected, entry.name);
    assert.deepEqual(calls[0].slice(0, 2), ['/bin/codex', ['login', 'status']], entry.name);
  }
});

test('Codex native upstream override and API key fallback are deterministic', () => {
  let calls = 0;
  const override = resolveCodexNativeBase('/bin/codex', {
    KENARI_CODEX_NATIVE_BASE_URL: 'https://proxy.example/v1',
  }, () => {
    calls += 1;
    return {};
  });
  assert.equal(override, 'https://proxy.example/v1');
  assert.equal(calls, 0);

  const fallback = resolveCodexNativeBase('/bin/codex', {
    OPENAI_API_KEY: 'sk-test',
  }, () => ({ status: 1, stdout: '', stderr: 'Not logged in' }));
  assert.equal(fallback, CODEX_API_BASE_URL);
});

test('Codex native upstream fails closed when login method is unknown', () => {
  assert.throws(() => resolveCodexNativeBase(
    '/bin/codex',
    {},
    () => ({ status: 1, stdout: '', stderr: 'Not logged in' }),
  ), /cannot determine Codex login method/);
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
