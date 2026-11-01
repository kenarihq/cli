// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KenariError } from '../store.js';
import { spawnTarget } from '../supervisor.js';

export const CODEX_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_API_BASE_URL = 'https://api.openai.com/v1';
const CODEX_ROUTER_PROVIDER = 'kenari_router';

function tomlString(value) {
  return JSON.stringify(value);
}

export function resolveCodexNativeBase(binary, env = process.env, run = spawnSync) {
  if (env.KENARI_CODEX_NATIVE_BASE_URL) return env.KENARI_CODEX_NATIVE_BASE_URL;
  // Through the same interpreter hop as the launch itself. An npm install on Windows
  // resolves to codex.cmd, which cannot be executed directly, so probing it without
  // this returned a failure and `kenari codex` gave up before it started.
  const probe = spawnTarget(binary, ['login', 'status'], env);
  const result = run(probe.file, probe.args, {
    encoding: 'utf8',
    env,
    timeout: 5000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/logged in using chatgpt/i.test(output)) return CODEX_CHATGPT_BASE_URL;
  if (/logged in using (?:an )?api key/i.test(output)) return CODEX_API_BASE_URL;
  if (env.OPENAI_API_KEY?.trim()) return CODEX_API_BASE_URL;
  throw new KenariError('cannot determine Codex login method. Run: codex login');
}

export function loadCodexNativeModels(binary, env = process.env) {
  for (const args of [['debug', 'models'], ['debug', 'models', '--bundled']]) {
    const probe = spawnTarget(binary, args, env);
    const result = spawnSync(probe.file, probe.args, {
      encoding: 'utf8',
      env,
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed.models) && parsed.models.length) return parsed.models;
    } catch {}
  }
  throw new KenariError('cannot read the Codex native model catalog');
}

function normalizeModelId(id) {
  return String(id || '').replace(/\./g, '-');
}

export function codexKenariModels(cache, nativeModels = []) {
  const fallbackTemplate = nativeModels[0];
  if ((cache?.models || []).length && !fallbackTemplate) {
    throw new KenariError('a native Codex model is required to build the merged catalog');
  }
  const basePriority = Math.max(0, ...nativeModels.map((model) => model.priority || 0));
  return (cache?.models || []).map((model, index) => {
    const normalizedId = normalizeModelId(model.id);
    const template = nativeModels.find((native) => normalizeModelId(native.slug) === normalizedId)
      || fallbackTemplate;
    const efforts = model.reasoning_options == null
      ? (template.supported_reasoning_levels || []).map((level) => level.effort)
      : model.reasoning_options;
    const entry = {
      ...template,
      slug: `kenari/${model.id}`,
      display_name: `Kenari ${model.id}`,
      description: `Kenari route for ${model.id}`,
      default_reasoning_level: efforts[0] || (efforts.length ? template.default_reasoning_level : undefined),
      supported_reasoning_levels: efforts.map((effort) => ({
        effort,
        description: `${effort} reasoning`,
      })),
      visibility: 'list',
      supported_in_api: true,
      priority: basePriority + index + 1,
      context_window: model.context_limit || template.context_window,
      max_context_window: model.context_limit || template.max_context_window,
      upgrade: null,
    };
    // Kenari-routed models must use classic top-level function tools. The gpt-5.6
    // templates carry OpenAI-private harness modes: in code_mode Codex sends an empty
    // tools array and hides the real definitions in an "additional_tools" input item
    // that only OpenAI's own backend expands, so the model ends up with no tools.
    delete entry.tool_mode;
    delete entry.multi_agent_version;
    entry.use_responses_lite = false;
    return entry;
  });
}

export function buildCodexLaunch(options) {
  const inputArgs = options.args || [];
  for (let index = 0; index < inputArgs.length; index += 1) {
    if (inputArgs[index] === '--enable') {
      if (inputArgs[index + 1] === 'enable_request_compression') {
        throw new KenariError('unsafe Codex routing override: enable_request_compression');
      }
      index += 1;
      continue;
    }
    if (inputArgs[index] === '--enable=enable_request_compression') {
      throw new KenariError('unsafe Codex routing override: enable_request_compression');
    }
    if (inputArgs[index] === '--oss' || inputArgs[index] === '--local-provider'
      || inputArgs[index].startsWith('--local-provider=')) {
      throw new KenariError(`unsafe Codex routing override: ${inputArgs[index]}`);
    }
    const inline = inputArgs[index].startsWith('--config=')
      ? inputArgs[index].slice('--config='.length)
      : null;
    if (inline === null && !['-c', '--config'].includes(inputArgs[index])) continue;
    const value = inline ?? inputArgs[index + 1] ?? '';
    const key = value.split('=', 1)[0].trim();
    if ([
      'model_provider',
      'openai_base_url',
      'model_catalog_json',
      'features.enable_request_compression',
    ].includes(key)
      || key.startsWith('model_providers.')) {
      throw new KenariError(`unsafe Codex routing override: ${key}`);
    }
    if (inline === null) index += 1;
  }
  const overrides = [
    `model_provider="${CODEX_ROUTER_PROVIDER}"`,
    `model_providers.${CODEX_ROUTER_PROVIDER}.name="OpenAI"`,
    `model_providers.${CODEX_ROUTER_PROVIDER}.base_url=${tomlString(options.routerUrl)}`,
    `model_providers.${CODEX_ROUTER_PROVIDER}.wire_api="responses"`,
    `model_providers.${CODEX_ROUTER_PROVIDER}.requires_openai_auth=true`,
    `model_providers.${CODEX_ROUTER_PROVIDER}.supports_websockets=false`,
    `model_providers.${CODEX_ROUTER_PROVIDER}.supports_standalone_web_search=true`,
    'features.enable_request_compression=false',
  ];
  if (options.catalogPath) {
    overrides.push(`model_catalog_json=${tomlString(options.catalogPath)}`);
  }
  const roles = options.toolConfig?.roles || {};
  if (roles.main?.mode === 'fixed') overrides.push(`model=${tomlString(roles.main.model)}`);
  if (roles.review?.mode === 'fixed') overrides.push(`review_model=${tomlString(roles.review.model)}`);
  if (roles.subagents?.mode === 'fixed') {
    overrides.push(`agents.default_subagent_model=${tomlString(roles.subagents.model)}`);
  }
  const overrideArgs = [];
  for (const value of overrides) overrideArgs.push('-c', value);
  const env = { ...(options.env || process.env) };
  const mode = options.codexDaemon ? codexDaemonMode(inputArgs) : 'unchanged';
  if (mode === 'no-daemon') {
    return { args: [...overrideArgs, '--no-daemon', ...inputArgs], env };
  }
  if (mode === 'private-app-server') {
    const socketPath = path.join(options.privateDir(), 'app-server.sock');
    const listen = `unix://${socketPath}`;
    return {
      args: [...overrideArgs, '--remote', listen, ...inputArgs],
      env,
      sidecar: {
        args: [...overrideArgs, ...userConfigArgs(inputArgs), 'app-server', '--listen', listen],
        socketPath,
        leftovers: codexSocketLeftovers(socketPath),
      },
    };
  }
  return { args: [...overrideArgs, ...inputArgs], env };
}

// Codex 0.156 added a shared app-server daemon. Its `codex --help` lists the root
// --no-daemon flag, and older releases have neither, so the flag in the help text is the
// gate. A probe that fails reads as an old Codex and keeps the launch as it was.
export function codexSupportsDaemon(binary, env = process.env, run = spawnSync) {
  const probe = spawnTarget(binary, ['--help'], env);
  const result = run(probe.file, probe.args, {
    encoding: 'utf8',
    env,
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  return /(?:^|\s)--no-daemon\b/.test(result.stdout || '');
}

// Root flags that take a value, so the token after them is not the subcommand.
const CODEX_VALUE_FLAGS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox',
  '-a', '--ask-for-approval', '-C', '--cd', '--add-dir',
]);

export function codexSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return null;
    if (arg.startsWith('-')) {
      if (CODEX_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return null;
}

// The shared daemon is started from the user's saved config and never sees this run's
// -c overrides, so a thread it creates cannot find kenari_router. A TUI session runs
// on the embedded server (--no-daemon). `codex agents` refuses --no-daemon through
// 0.166, so it gets an app server of its own, started with the same overrides. A user
// who picked a server (--remote) or embedded mode (--no-daemon) keeps that choice.
export function codexDaemonMode(args) {
  if (args.some((arg) => arg === '--no-daemon' || arg === '--remote' || arg.startsWith('--remote='))) {
    return 'unchanged';
  }
  const subcommand = codexSubcommand(args);
  if (subcommand === null || subcommand === 'resume' || subcommand === 'fork') return 'no-daemon';
  if (subcommand === 'agents') return 'private-app-server';
  return 'unchanged';
}

// The user's own -c and feature toggles, so the private server runs with the settings
// the TUI was given. The routing keys among them were refused above.
function userConfigArgs(args) {
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      if (index + 1 < args.length) forwarded.push(arg, args[index + 1]);
      index += 1;
    } else if (/^--(?:config|enable|disable)=/.test(arg)) {
      forwarded.push(arg);
    }
  }
  return forwarded;
}

// On Unix Codex binds the real socket in /tmp/codex-daemon-<uid>, named by the SHA-256
// of the requested path, and leaves a symlink at that path. It removes both on a clean
// exit. These are the files a killed server would leave behind.
export function codexSocketLeftovers(socketPath, platform = process.platform) {
  if (platform === 'win32' || typeof process.geteuid !== 'function') return [];
  try {
    const requested = path.join(fs.realpathSync(path.dirname(socketPath)), path.basename(socketPath));
    const hash = createHash('sha256').update(requested).digest('hex');
    const physical = path.join(fs.realpathSync('/tmp'), `codex-daemon-${process.geteuid()}`, hash);
    return [physical, `${physical}.lock`];
  } catch {
    return [];
  }
}
