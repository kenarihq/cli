// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { backupsDir, claudeSettingsPath, codexConfigPath, statePath } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import {
  KenariError,
  readJson,
  removeFile,
  writeFileAtomic,
  writeJson,
  writePrivateJson,
} from './store.js';
import * as toml from './toml.js';

const CLAUDE_KEYS = {
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};
const CODEX_TABLE_KEY = 'table:model_providers.kenari';

function fixed(value) {
  return typeof value === 'string' && value
    ? { mode: 'fixed', model: value.startsWith('kenari/') ? value : `kenari/${value}` }
    : { mode: 'native' };
}

function same(a, b) {
  return a === b;
}

function timestamp(value) {
  return new Date(value).toISOString().replace(/[:.]/g, '-');
}

function backupFile(file, label, now) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) throw new KenariError(`${file} is a symlink; migration aborted`);
  const destination = path.join(backupsDir(), timestamp(now), label);
  writeFileAtomic(destination, fs.readFileSync(file));
  fs.chmodSync(destination, stat.mode & 0o777);
  return { path: destination, mode: stat.mode & 0o777 };
}

function inspectClaude(state, file) {
  const settings = readJson(file) || {};
  if ('env' in settings && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
    return { settings, env: null, conflicts: ['env'] };
  }
  const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const conflicts = [];
  for (const [key, record] of Object.entries(state.keys || {})) {
    const current = key in env ? env[key] : null;
    if (!same(current, record.applied) && !same(current, record.before)) conflicts.push(key);
  }
  return { settings, env, conflicts };
}

function migrateClaude(state, file) {
  const inspected = inspectClaude(state, file);
  if (inspected.conflicts.length) return { conflicts: inspected.conflicts };
  const settings = inspected.settings;
  const env = inspected.env;
  for (const [key, record] of Object.entries(state.keys || {})) {
    if (!same(key in env ? env[key] : null, record.applied)) continue;
    if (record.before === null || record.before === undefined) delete env[key];
    else env[key] = record.before;
  }
  if (state.containerCreated && Object.keys(env).length === 0) delete settings.env;
  else settings.env = env;
  if (state.fileCreated && Object.keys(settings).length === 0) removeFile(file);
  else writeJson(file, settings);

  const applied = Object.fromEntries(Object.entries(state.keys || {}).map(([key, rec]) => [key, rec.applied]));
  const roles = {};
  for (const [role, key] of Object.entries(CLAUDE_KEYS)) roles[role] = fixed(applied[key]);
  roles.fable = { mode: 'native' };
  roles.subagents = { mode: 'native' };
  return { conflicts: [], toolConfig: { roles } };
}

function currentCodex(content, key) {
  if (key === CODEX_TABLE_KEY) return toml.getTableText(content, 'model_providers.kenari');
  return toml.getTopLevel(content, key);
}

function migrateCodex(state, file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') content = ''; else throw error; }
  const conflicts = [];
  for (const [key, record] of Object.entries(state.keys || {})) {
    const current = currentCodex(content, key);
    if (key !== CODEX_TABLE_KEY && current === null && toml.hasTopLevel(content, key)) {
      conflicts.push(key);
      continue;
    }
    if (!same(current, record.applied) && !same(current, record.before)) conflicts.push(key);
  }
  if (conflicts.length) return { conflicts };
  for (const [key, record] of Object.entries(state.keys || {})) {
    if (!same(currentCodex(content, key), record.applied)) continue;
    if (key === CODEX_TABLE_KEY) {
      if (record.before === null) content = toml.deleteTable(content, 'model_providers.kenari');
      else {
        const lines = record.before.split('\n');
        content = toml.setTable(content, 'model_providers.kenari', lines.slice(1));
      }
    } else if (record.before === null) content = toml.deleteTopLevel(content, key);
    else content = toml.setTopLevel(content, key, record.before);
  }
  if (state.fileCreated && content.trim() === '') removeFile(file);
  else writeFileAtomic(file, content);
  return {
    conflicts: [],
    toolConfig: {
      roles: {
        main: fixed(state.keys?.model?.applied),
        review: { mode: 'inherit' },
        subagents: { mode: 'inherit' },
      },
    },
  };
}

export function detectV1State() {
  const state = readJson(statePath());
  if (!state) return null;
  if (state.version !== undefined && state.version !== 1) return null;
  return {
    version: 1,
    tools: state.tools && typeof state.tools === 'object' ? state.tools : {},
    migration_conflicts: Array.isArray(state.migration_conflicts) ? state.migration_conflicts : [],
  };
}

export function detectOrphanedV1Signatures() {
  if (detectV1State()) return [];
  const conflicts = [];
  const claude = readJson(claudeSettingsPath());
  const env = claude?.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
      if (key in env) conflicts.push({ tool: 'claude', key });
    }
  }
  let codex = '';
  try { codex = fs.readFileSync(codexConfigPath(), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (toml.getTableText(codex, 'model_providers.kenari') !== null) {
    conflicts.push({ tool: 'codex', key: CODEX_TABLE_KEY });
  }
  if (toml.getTopLevel(codex, 'model_provider') === 'kenari') {
    conflicts.push({ tool: 'codex', key: 'model_provider' });
  }
  return conflicts;
}

export function migrateV1(options = {}) {
  const legacy = detectV1State();
  if (!legacy) {
    return { config: options.config || loadConfig(), migrated: [], conflicts: [], backups: [] };
  }
  const now = options.now ?? Date.now();
  const files = {
    claude: options.claudePath || claudeSettingsPath(),
    codex: options.codexPath || codexConfigPath(),
  };
  const labels = { claude: 'claude-settings.json', codex: 'codex-config.toml' };
  const config = options.config || loadConfig() || { version: 2, tools: {} };
  const next = structuredClone(config);
  const migrated = [];
  const conflicts = [];
  const backups = [];
  const migrationTools = {};

  for (const tool of ['claude', 'codex']) {
    const toolState = legacy.tools[tool];
    if (!toolState) continue;
    const manual = legacy.migration_conflicts.filter(
      (item) => item.tool === tool && !(item.key in (toolState.keys || {})),
    );
    const unresolved = manual.filter((item) => {
      if (tool === 'claude') {
        const value = readJson(files.claude);
        if (item.key === 'env') return 'env' in (value || {});
        return item.key in (value?.env || {});
      }
      let content = '';
      try { content = fs.readFileSync(files.codex, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return item.key === CODEX_TABLE_KEY
        ? toml.getTableText(content, 'model_providers.kenari') !== null
        : toml.hasTopLevel(content, item.key);
    });
    if (unresolved.length) {
      conflicts.push(...unresolved);
      continue;
    }
    const backup = backupFile(files[tool], labels[tool], now);
    if (backup) backups.push(backup);
    const result = tool === 'claude'
      ? migrateClaude(toolState, files[tool])
      : migrateCodex(toolState, files[tool]);
    if (result.conflicts.length) {
      conflicts.push(...result.conflicts.map((key) => ({ tool, key })));
      migrationTools[tool] = { status: 'conflict', keys: result.conflicts };
      continue;
    }
    next.tools[tool] = result.toolConfig;
    migrated.push(tool);
    migrationTools[tool] = { status: 'migrated' };
  }
  if (conflicts.length) {
    const tools = structuredClone(legacy.tools);
    for (const conflict of conflicts) {
      const sensitive = (conflict.tool === 'claude' && conflict.key === 'ANTHROPIC_AUTH_TOKEN')
        || (conflict.tool === 'codex' && conflict.key === CODEX_TABLE_KEY);
      if (sensitive) delete tools[conflict.tool]?.keys?.[conflict.key];
    }
    writePrivateJson(statePath(), {
      version: 1,
      tools,
      migration_conflicts: conflicts,
    });
    return { config, migrated, conflicts, backups };
  }
  const saved = saveConfig(next);
  writePrivateJson(statePath(), {
    version: 2,
    migration: {
      completed_at: new Date(now).toISOString(),
      tools: migrationTools,
      backups,
    },
  });
  return { config: saved, migrated, conflicts, backups };
}
