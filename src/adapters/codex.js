import fs from 'node:fs';
import { codexHome, codexConfigPath, gatewayBase } from '../paths.js';
import { writeFileAtomic, getToolState, setToolState, clearToolState } from '../store.js';
import * as toml from '../toml.js';

const TABLE = 'model_providers.kenari';
const TABLE_KEY = `table:${TABLE}`;

function readConfig() {
  try { return fs.readFileSync(codexConfigPath(), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function tableBody(key) {
  return [
    'name = "Kenari"',
    `base_url = "${gatewayBase()}/v1"`,
    'wire_api = "chat"',
    `http_headers = { "Authorization" = "Bearer ${key}" }`,
  ];
}

export default {
  id: 'codex',
  name: 'Codex',
  slots: [{ id: 'model', label: 'Model', defaultModel: 'glm-5-2' }],

  detect() {
    return { installed: fs.existsSync(codexHome()), configPath: codexConfigPath() };
  },

  status() {
    const content = readConfig() || '';
    const onKenari = toml.getTopLevel(content, 'model_provider') === 'kenari'
      && toml.getTableText(content, TABLE) !== null;
    const notes = [];
    const state = getToolState('codex');
    if (state && !onKenari) notes.push('switch state exists but config.toml no longer points at kenari (hand-edited?)');
    if (!state && onKenari) notes.push('points at kenari but no switch state (configured outside this CLI)');
    notes.push('shell overrides (codex --profile / -c) are not visible here');
    return {
      provider: onKenari ? 'kenari' : 'default',
      mapping: onKenari ? { model: toml.getTopLevel(content, 'model') } : null,
      notes,
    };
  },

  apply(mapping, key) {
    const existing = readConfig();
    let content = existing ?? '';
    const fileCreated = existing === null;
    const prior = getToolState('codex');
    const currentVals = {
      model: toml.getTopLevel(content, 'model'),
      model_provider: toml.getTopLevel(content, 'model_provider'),
      [TABLE_KEY]: toml.getTableText(content, TABLE),
    };
    const newTable = [`[${TABLE}]`, ...tableBody(key)].join('\n');
    const applied = { model: mapping.model, model_provider: 'kenari', [TABLE_KEY]: newTable };
    const keys = {};
    for (const k of Object.keys(applied)) {
      const before = prior?.keys?.[k] !== undefined ? prior.keys[k].before : currentVals[k];
      keys[k] = { before, applied: applied[k] };
    }
    setToolState('codex', {
      fileCreated: prior?.fileCreated ?? fileCreated,
      containerCreated: false,
      keys,
    });
    content = toml.setTopLevel(content, 'model', mapping.model);
    content = toml.setTopLevel(content, 'model_provider', 'kenari');
    content = toml.setTable(content, TABLE, tableBody(key));
    writeFileAtomic(codexConfigPath(), content);
  },

  restore() {
    const state = getToolState('codex');
    if (!state) return { restored: false, conflicts: [] };
    let content = readConfig() ?? '';
    const conflicts = [];
    const remaining = {};

    for (const k of ['model', 'model_provider']) {
      const rec = state.keys[k];
      if (!rec) continue;
      const cur = toml.getTopLevel(content, k);
      if (cur === rec.applied) {
        content = rec.before === null
          ? toml.deleteTopLevel(content, k)
          : toml.setTopLevel(content, k, rec.before);
      } else if (cur === rec.before) {
        // Already back at its baseline (user resolved a prior conflict by hand):
        // nothing to revert, and not a conflict, so a repeat restore can finish.
      } else {
        conflicts.push(`${k}: changed by hand, left as-is`);
        remaining[k] = rec;
      }
    }
    const rec = state.keys[TABLE_KEY];
    if (rec) {
      const cur = toml.getTableText(content, TABLE);
      if (cur === rec.applied) {
        if (rec.before === null) content = toml.deleteTable(content, TABLE);
        else {
          const lines = rec.before.split('\n');
          content = toml.setTable(content, TABLE, lines.slice(1));
        }
      } else if (cur === rec.before) {
        // Table already back at baseline (user resolved a prior conflict by hand):
        // no revert, no conflict, so a repeat restore can finish.
      } else {
        conflicts.push(`[${TABLE}]: changed by hand, left as-is`);
        remaining[TABLE_KEY] = rec;
      }
    }

    if (state.fileCreated && content.trim() === '') {
      try { fs.rmSync(codexConfigPath()); } catch {}
    } else {
      writeFileAtomic(codexConfigPath(), content);
    }
    if (conflicts.length === 0) clearToolState('codex');
    else setToolState('codex', { ...state, keys: remaining });
    return { restored: true, conflicts };
  },
};
