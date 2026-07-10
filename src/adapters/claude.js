import fs from 'node:fs';
import { claudeConfigDir, claudeSettingsPath, gatewayBase } from '../paths.js';
import { readJson, writeJson, getToolState, setToolState, clearToolState } from '../store.js';

const SLOT_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

function ownedValues(mapping, key) {
  return {
    ANTHROPIC_BASE_URL: gatewayBase(),
    ANTHROPIC_AUTH_TOKEN: key,
    [SLOT_ENV.opus]: mapping.opus,
    [SLOT_ENV.sonnet]: mapping.sonnet,
    [SLOT_ENV.haiku]: mapping.haiku,
  };
}

export default {
  id: 'claude',
  name: 'Claude Code',
  slots: [
    { id: 'opus', label: 'Opus slot (strongest)', defaultModel: 'glm-5-2' },
    { id: 'sonnet', label: 'Sonnet slot (daily driver)', defaultModel: 'kimi-k2-7-code' },
    { id: 'haiku', label: 'Haiku slot (fast/background)', defaultModel: 'deepseek-v4-flash' },
  ],

  detect() {
    return { installed: fs.existsSync(claudeConfigDir()), configPath: claudeSettingsPath() };
  },

  status() {
    const settings = readJson(claudeSettingsPath()) || {};
    const env = settings.env || {};
    const onKenari = env.ANTHROPIC_BASE_URL === gatewayBase()
      && typeof env.ANTHROPIC_AUTH_TOKEN === 'string'
      && env.ANTHROPIC_AUTH_TOKEN.startsWith('kn-');
    const notes = [];
    const state = getToolState('claude');
    if (state && !onKenari) notes.push('switch state exists but settings.json no longer points at kenari (hand-edited?)');
    if (!state && onKenari) notes.push('points at kenari but no switch state (configured outside this CLI)');
    return {
      provider: onKenari ? 'kenari' : 'default',
      mapping: onKenari ? {
        opus: env[SLOT_ENV.opus], sonnet: env[SLOT_ENV.sonnet], haiku: env[SLOT_ENV.haiku],
      } : null,
      notes,
    };
  },

  apply(mapping, key) {
    const file = claudeSettingsPath();
    const existing = readJson(file);
    const settings = existing || {};
    const fileCreated = existing === null;
    const containerCreated = !('env' in settings);
    const env = settings.env || {};
    const values = ownedValues(mapping, key);
    const prior = getToolState('claude');
    const keys = {};
    for (const [k, v] of Object.entries(values)) {
      const before = prior?.keys?.[k] !== undefined
        ? prior.keys[k].before
        : (k in env ? env[k] : null);
      keys[k] = { before, applied: v };
    }
    setToolState('claude', {
      fileCreated: prior?.fileCreated ?? fileCreated,
      containerCreated: prior?.containerCreated ?? containerCreated,
      keys,
    });
    settings.env = { ...env, ...values };
    writeJson(file, settings);
  },

  restore() {
    const state = getToolState('claude');
    if (!state) return { restored: false, conflicts: [] };
    const file = claudeSettingsPath();
    const settings = readJson(file) || {};
    const env = settings.env || {};
    const conflicts = [];
    const remaining = {};
    for (const [k, rec] of Object.entries(state.keys)) {
      const cur = k in env ? env[k] : null;
      if (cur === rec.applied) {
        if (rec.before === null) delete env[k];
        else env[k] = rec.before;
      } else if (cur === rec.before) {
        // Already back at its baseline (user resolved a prior conflict by hand):
        // nothing to revert, and not a conflict, so a repeat restore can finish.
      } else {
        conflicts.push(`${k}: changed by hand, left as-is`);
        remaining[k] = rec;
      }
    }
    settings.env = env;
    if (state.containerCreated && Object.keys(env).length === 0) delete settings.env;
    if (state.fileCreated && Object.keys(settings).length === 0) {
      try { fs.rmSync(file); } catch {}
    } else {
      writeJson(file, settings);
    }
    if (conflicts.length === 0) clearToolState('claude');
    else setToolState('claude', { ...state, keys: remaining });
    return { restored: true, conflicts };
  },
};
