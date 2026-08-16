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

const OVERRIDDEN_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

// The manual Claude Code setup in /docs/tools has people export these three, and the
// launch below replaces every one of them: the base url points at the local router,
// and both credentials are dropped so Claude Code authenticates through it instead.
// A value already in the environment therefore changes nothing about the run. It is
// reported so the person knows which of their exports this session ignored, and it is
// never fatal: refusing to launch made the documented manual path and the CLI path
// mutually exclusive, with no flag, no migration and no remedy in the error.
export function findClaudeEnvConflicts(env = process.env) {
  return OVERRIDDEN_ENV.filter((name) => typeof env[name] === 'string' && env[name] !== '');
}

// True when no slot can produce a request for api.anthropic.com, which is what makes
// it safe to hand Claude Code a stand-in credential.
export function claudeRoutesEverySlot(roles = {}) {
  return Object.keys(CLAUDE_ROLE_ENV).every((role) => roles[role]?.mode === 'fixed');
}

export function buildClaudeLaunch(options) {
  const inputEnv = options.env || process.env;
  const args = options.args || [];
  const usesKenari = Object.values(options.toolConfig?.roles || {})
    .some((role) => role.mode === 'fixed');
  if (usesKenari && args.some((arg) => arg === '--fallback-model' || arg.startsWith('--fallback-model='))) {
    throw new KenariError('Claude fallback models are disabled for mixed Kenari routing');
  }
  const env = { ...inputEnv, ANTHROPIC_BASE_URL: options.routerUrl };
  if (options.routerCapabilityToken) {
    const existing = inputEnv.ANTHROPIC_CUSTOM_HEADERS?.trim();
    env.ANTHROPIC_CUSTOM_HEADERS = [
      existing,
      `X-Kenari-Capability: ${options.routerCapabilityToken}`,
    ].filter(Boolean).join('\n');
  }
  const roles = options.toolConfig?.roles || {};
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  // Claude Code refuses to send anything without a credential of its own, and dropping
  // both of these left "Not logged in, please run /login" for anyone who has no Anthropic
  // subscription, even with all six slots on Kenari. A native slot is why they go: the
  // router forwards the client's credential verbatim to api.anthropic.com, where a
  // Kenari key would 401. With every slot fixed there is no native slot to forward to,
  // so a stand-in gets Claude Code past its own check. The router replaces it with the
  // real Kenari credential on the way out, and it is deliberately not the Kenari key:
  // should anything still reach Anthropic, it costs a 401 and not the key.
  if (claudeRoutesEverySlot(roles) && options.standInCredential) {
    env.ANTHROPIC_AUTH_TOKEN = options.standInCredential;
  }
  for (const [role, variable] of Object.entries(CLAUDE_ROLE_ENV)) {
    const setting = roles[role];
    if (setting?.mode === 'fixed') env[variable] = setting.model;
    else if (setting?.mode === 'native' && !(variable in inputEnv)) delete env[variable];
  }
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  return { args: [...args], env };
}
