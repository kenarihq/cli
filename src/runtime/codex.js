import { spawnSync } from 'node:child_process';
import { KenariError } from '../store.js';

export const CODEX_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_API_BASE_URL = 'https://api.openai.com/v1';
const CODEX_ROUTER_PROVIDER = 'kenari_router';

function tomlString(value) {
  return JSON.stringify(value);
}

export function resolveCodexNativeBase(binary, env = process.env, run = spawnSync) {
  if (env.KENARI_CODEX_NATIVE_BASE_URL) return env.KENARI_CODEX_NATIVE_BASE_URL;
  const result = run(binary, ['login', 'status'], {
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
    const result = spawnSync(binary, args, {
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
  const args = [];
  for (const value of overrides) args.push('-c', value);
  args.push(...inputArgs);
  const env = { ...(options.env || process.env) };
  return { args, env };
}
