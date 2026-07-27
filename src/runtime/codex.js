import { spawnSync } from 'node:child_process';
import { KenariError } from '../store.js';

function tomlString(value) {
  return JSON.stringify(value);
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

export function codexKenariModels(cache, nativeModels = []) {
  const fallbackTemplate = nativeModels[0];
  if ((cache?.models || []).length && !fallbackTemplate) {
    throw new KenariError('a native Codex model is required to build the merged catalog');
  }
  const basePriority = Math.max(0, ...nativeModels.map((model) => model.priority || 0));
  return (cache?.models || []).map((model, index) => {
    const template = nativeModels.find((native) => native.slug === model.id) || fallbackTemplate;
    const efforts = model.reasoning_efforts?.length
      ? model.reasoning_efforts
      : (template.supported_reasoning_levels || []).map((level) => level.effort);
    return {
      ...template,
      slug: `kenari/${model.id}`,
      display_name: `Kenari ${model.id}`,
      description: `Kenari route for ${model.id}`,
      default_reasoning_level: efforts[0] || template.default_reasoning_level,
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
  });
}

export function buildCodexLaunch(options) {
  const inputArgs = options.args || [];
  for (let index = 0; index < inputArgs.length; index += 1) {
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
    if (['model_provider', 'openai_base_url', 'model_catalog_json'].includes(key)
      || key.startsWith('model_providers.')) {
      throw new KenariError(`unsafe Codex routing override: ${key}`);
    }
    if (inline === null) index += 1;
  }
  const overrides = [
    'model_provider="openai"',
    `openai_base_url=${tomlString(options.routerUrl)}`,
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
