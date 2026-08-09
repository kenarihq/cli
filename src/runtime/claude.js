// SPDX-License-Identifier: GPL-3.0-or-later
import { KenariError } from '../store.js';

export const CLAUDE_ROLE_ENV = Object.freeze({
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  subagents: 'CLAUDE_CODE_SUBAGENT_MODEL',
});

const CONFLICT_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

export function findClaudeEnvConflicts(env = process.env) {
  return CONFLICT_ENV.filter((name) => typeof env[name] === 'string' && env[name] !== '');
}

export function buildClaudeLaunch(options) {
  const inputEnv = options.env || process.env;
  const args = options.args || [];
  const usesKenari = Object.values(options.toolConfig?.roles || {})
    .some((role) => role.mode === 'fixed');
  if (usesKenari && args.some((arg) => arg === '--fallback-model' || arg.startsWith('--fallback-model='))) {
    throw new KenariError('Claude fallback models are disabled for mixed Kenari routing');
  }
  const conflicts = findClaudeEnvConflicts(inputEnv);
  if (conflicts.length && !options.allowAmbiguousEnv) {
    throw new KenariError(`Claude routing environment is ambiguous: ${conflicts.join(', ')}`);
  }
  const env = { ...inputEnv, ANTHROPIC_BASE_URL: options.routerUrl };
  if (options.routerCapabilityToken) {
    const existing = inputEnv.ANTHROPIC_CUSTOM_HEADERS?.trim();
    env.ANTHROPIC_CUSTOM_HEADERS = [
      existing,
      `X-Kenari-Capability: ${options.routerCapabilityToken}`,
    ].filter(Boolean).join('\n');
  }
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  const roles = options.toolConfig?.roles || {};
  for (const [role, variable] of Object.entries(CLAUDE_ROLE_ENV)) {
    const setting = roles[role];
    if (setting?.mode === 'fixed') env[variable] = setting.model;
    else if (setting?.mode === 'native' && !(variable in inputEnv)) delete env[variable];
  }
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  return { args: [...args], env };
}
