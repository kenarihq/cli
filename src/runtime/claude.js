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

const CLAUDE_SLOT_LABEL_ENV = Object.freeze({
  opus: Object.freeze({
    name: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    description: 'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  }),
  sonnet: Object.freeze({
    name: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    description: 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  }),
  haiku: Object.freeze({
    name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    description: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  }),
  fable: Object.freeze({
    name: 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    description: 'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
  }),
});

export const CLAUDE_BARE_ALIASES = Object.freeze([
  'opus', 'sonnet', 'haiku', 'fable', 'best', 'opusplan',
]);
export const CLAUDE_SIDE_REQUEST_CLASSES = Object.freeze([
  'auxiliary', 'compaction', 'subagent', 'workflow',
]);

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

export function findClaudeSettingsConflicts(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
  const found = [];
  const env = settings.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const name of OVERRIDDEN_ENV) {
      if (typeof env[name] === 'string' && env[name] !== '') found.push(`settings.env.${name}`);
    }
  }
  if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim()) {
    found.push('settings.apiKeyHelper');
  }
  return found;
}

export function claudeUsesKenari(roles = {}) {
  return Object.values(roles).some((role) => role?.mode === 'fixed');
}

// True when no slot can produce a request for api.anthropic.com, which is what makes
// it safe to hand Claude Code a stand-in credential.
export function claudeRoutesEverySlot(roles = {}) {
  return Object.keys(CLAUDE_ROLE_ENV).every((role) => roles[role]?.mode === 'fixed');
}

export function claudeIsBareMode(args = [], env = {}) {
  if (args.some((arg) => arg === '--bare')) return true;
  const simple = env.CLAUDE_CODE_SIMPLE;
  return simple === '1' || String(simple).toLowerCase() === 'true';
}

export function stripClaudeOneMMarker(model) {
  return String(model || '').replace(/\[1m\]$/i, '');
}

export function detectClaudeFamily(model) {
  const stripped = stripClaudeOneMMarker(model).toLowerCase();
  if (!stripped) return null;
  if (stripped === 'best') return 'best';
  if (stripped === 'opusplan') return 'opusplan';
  if (stripped === 'opus' || stripped.includes('claude-opus')) return 'opus';
  if (stripped === 'sonnet' || stripped.includes('claude-sonnet')) return 'sonnet';
  if (stripped === 'haiku' || stripped.includes('claude-haiku')) return 'haiku';
  if (stripped === 'fable' || stripped.includes('claude-fable')) return 'fable';
  return null;
}

export function isClaudeBareAlias(model) {
  return CLAUDE_BARE_ALIASES.includes(stripClaudeOneMMarker(model).toLowerCase());
}

export function claudeRequestClass(headers = {}) {
  const raw = headers['x-claude-code-request-class'];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function isClaudeSideRequest(headers = {}) {
  return CLAUDE_SIDE_REQUEST_CLASSES.includes(claudeRequestClass(headers));
}

function slotForFamily(family, roles, headers) {
  if (family === 'best') return roles.fable?.mode === 'fixed' ? 'fable' : 'opus';
  if (family === 'opusplan') {
    const agent = String(headers['x-claude-code-agent-type'] || '').toLowerCase();
    const cls = claudeRequestClass(headers);
    if (!cls && !agent) return 'opus';
    if (agent === 'plan') return 'opus';
    return 'sonnet';
  }
  return family;
}

function fixedSlotModel(roles, slot) {
  const setting = roles?.[slot];
  return setting?.mode === 'fixed' ? setting.model : null;
}

// Hint-aware remap. Unprefixed main-turn IDs stay native. Bare aliases and hinted
// side requests follow the matching fixed slot. All-Kenari remaps every leftover
// id because a stand-in credential cannot reach Anthropic.
export function remapClaudeModel(model, headers = {}, roles = {}) {
  if (typeof model !== 'string' || !model || model.startsWith('kenari/')) return model;
  const family = detectClaudeFamily(model);
  const slot = family ? slotForFamily(family, roles, headers) : 'main';
  const mapped = fixedSlotModel(roles, slot)
    || (claudeRoutesEverySlot(roles) ? fixedSlotModel(roles, 'main') : null);
  if (claudeRoutesEverySlot(roles)) return mapped || model;
  if (mapped && isClaudeBareAlias(model)) return mapped;
  if (mapped && isClaudeSideRequest(headers)) return mapped;
  return model;
}

function applySlotLabels(env, inputEnv, roles) {
  for (const [role, variables] of Object.entries(CLAUDE_SLOT_LABEL_ENV)) {
    const setting = roles[role];
    if (setting?.mode === 'fixed') {
      const id = setting.model.slice('kenari/'.length);
      env[variables.name] = id;
      env[variables.description] = `Kenari ${id}`;
    } else {
      if (!(variables.name in inputEnv)) delete env[variables.name];
      if (!(variables.description in inputEnv)) delete env[variables.description];
    }
  }
}

export function buildClaudeLaunch(options) {
  const inputEnv = options.env || process.env;
  const args = options.args || [];
  const roles = options.toolConfig?.roles || {};
  const usesKenari = claudeUsesKenari(roles);
  if (usesKenari && args.some((arg) => arg === '--fallback-model' || arg.startsWith('--fallback-model='))) {
    throw new KenariError('Claude fallback models are disabled for mixed Kenari routing');
  }
  const env = { ...inputEnv, ANTHROPIC_BASE_URL: options.routerUrl };
  env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1';
  if (usesKenari) env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1';
  if (options.routerCapabilityToken) {
    const existing = inputEnv.ANTHROPIC_CUSTOM_HEADERS?.trim();
    env.ANTHROPIC_CUSTOM_HEADERS = [
      existing,
      `X-Kenari-Capability: ${options.routerCapabilityToken}`,
    ].filter(Boolean).join('\n');
  }
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
  // --bare / CLAUDE_CODE_SIMPLE reads only ANTHROPIC_API_KEY. Interactive all-Kenari
  // keeps AUTH_TOKEN so a leftover API key cannot take over the session.
  if (claudeRoutesEverySlot(roles) && options.standInCredential) {
    if (claudeIsBareMode(args, inputEnv)) {
      env.ANTHROPIC_API_KEY = options.standInCredential;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = options.standInCredential;
    }
    env.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS = '1';
  }
  for (const [role, variable] of Object.entries(CLAUDE_ROLE_ENV)) {
    const setting = roles[role];
    if (setting?.mode === 'fixed') env[variable] = setting.model;
    else if (setting?.mode === 'native' && !(variable in inputEnv)) delete env[variable];
  }
  if (roles.subagents?.mode === 'fixed') {
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = roles.subagents.model;
  } else {
    delete env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  }
  applySlotLabels(env, inputEnv, roles);
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  return { args: [...args], env };
}
