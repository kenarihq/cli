// SPDX-License-Identifier: GPL-3.0-or-later
import { configPath } from './paths.js';
import { KenariError, readJson, writePrivateJson } from './store.js';

export const ROLE_DEFINITIONS = Object.freeze({
  claude: Object.freeze({
    main: ['native', 'fixed'],
    opus: ['native', 'fixed'],
    sonnet: ['native', 'fixed'],
    haiku: ['native', 'fixed'],
    fable: ['native', 'fixed'],
    subagents: ['native', 'fixed'],
  }),
  codex: Object.freeze({
    main: ['native', 'fixed', 'picker'],
    review: ['native', 'fixed', 'inherit'],
    subagents: ['native', 'fixed', 'inherit'],
  }),
});

function fail(message) {
  throw new KenariError(`invalid config.json: ${message}`);
}

function validateRole(tool, role, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${tool}.${role} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !['mode', 'model'].includes(key))) {
    fail(`${tool}.${role} contains an unknown field`);
  }
  if (!ROLE_DEFINITIONS[tool][role].includes(value.mode)) {
    fail(`${tool}.${role} has unsupported mode "${value.mode}"`);
  }
  if (value.mode === 'fixed') {
    if (typeof value.model !== 'string' || !/^kenari\/[^/\s]+$/.test(value.model)) {
      fail(`${tool}.${role} fixed model must use kenari/<model-id>`);
    }
  } else if ('model' in value) {
    fail(`${tool}.${role} may specify model only in fixed mode`);
  }
  return value.mode === 'fixed'
    ? { mode: 'fixed', model: value.model }
    : { mode: value.mode };
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('root must be an object');
  if (value.version !== 2) fail(`unsupported schema version "${value.version}"`);
  if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) {
    fail('tools must be an object');
  }
  const unknownRoot = Object.keys(value).filter((key) => !['version', 'tools'].includes(key));
  if (unknownRoot.length) fail(`unknown top-level field "${unknownRoot[0]}"`);
  const unknownTools = Object.keys(value.tools).filter((tool) => !(tool in ROLE_DEFINITIONS));
  if (unknownTools.length) fail(`unknown tool "${unknownTools[0]}"`);

  const tools = {};
  for (const [tool, definition] of Object.entries(ROLE_DEFINITIONS)) {
    if (!(tool in value.tools)) continue;
    const entry = value.tools[tool];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => key !== 'roles')) {
      fail(`${tool} must contain only roles`);
    }
    if (!entry.roles || typeof entry.roles !== 'object' || Array.isArray(entry.roles)) {
      fail(`${tool}.roles must be an object`);
    }
    const unknownRoles = Object.keys(entry.roles).filter((role) => !(role in definition));
    if (unknownRoles.length) fail(`unknown role "${tool}.${unknownRoles[0]}"`);
    const missing = Object.keys(definition).filter((role) => !(role in entry.roles));
    if (missing.length) fail(`missing role "${tool}.${missing[0]}"`);
    tools[tool] = { roles: {} };
    for (const role of Object.keys(definition)) {
      tools[tool].roles[role] = validateRole(tool, role, entry.roles[role]);
    }
  }
  return { version: 2, tools };
}

export function loadConfig() {
  const value = readJson(configPath());
  return value === null ? null : validateConfig(value);
}

export function saveConfig(value) {
  const validated = validateConfig(value);
  writePrivateJson(configPath(), validated);
  return validated;
}

export function getToolConfig(config, tool) {
  if (!(tool in ROLE_DEFINITIONS)) throw new KenariError(`unsupported tool "${tool}"`);
  return config?.tools?.[tool] || null;
}

export function hasKenariRoutes(config, tool) {
  const tools = tool ? [tool] : Object.keys(config?.tools || {});
  return tools.some((id) => Object.values(config.tools[id]?.roles || {})
    .some((role) => role.mode === 'fixed' || role.mode === 'picker'));
}
