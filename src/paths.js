// SPDX-License-Identifier: GPL-3.0-or-later
import os from 'node:os';
import path from 'node:path';

export function kenariHome() {
  return process.env.KENARI_HOME || path.join(os.homedir(), '.kenari');
}
export function credentialsPath() { return path.join(kenariHome(), 'credentials.json'); }
export function configPath() { return path.join(kenariHome(), 'config.json'); }
export function modelCachePath() { return path.join(kenariHome(), 'model-cache.json'); }
export function statePath() { return path.join(kenariHome(), 'state.json'); }
export function lockDir() { return path.join(kenariHome(), 'lock'); }
export function backupsDir() { return path.join(kenariHome(), 'backups'); }
export function runtimeDir() { return path.join(kenariHome(), 'run'); }
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
export function claudeSettingsPath() { return path.join(claudeConfigDir(), 'settings.json'); }
export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
export function codexConfigPath() { return path.join(codexHome(), 'config.toml'); }
export function gatewayBase() {
  const raw = process.env.KENARI_BASE_URL || 'https://kenari.id';
  return raw.replace(/\/+$/, '');
}
