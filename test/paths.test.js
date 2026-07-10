import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as paths from '../src/paths.js';

test('env overrides win', () => {
  process.env.KENARI_HOME = path.join(os.tmpdir(), 'kh');
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'cc');
  process.env.CODEX_HOME = path.join(os.tmpdir(), 'cx');
  process.env.KENARI_BASE_URL = 'http://127.0.0.1:9999///';
  assert.equal(paths.kenariHome(), path.join(os.tmpdir(), 'kh'));
  assert.equal(paths.claudeSettingsPath(), path.join(os.tmpdir(), 'cc', 'settings.json'));
  assert.equal(paths.codexConfigPath(), path.join(os.tmpdir(), 'cx', 'config.toml'));
  assert.equal(paths.gatewayBase(), 'http://127.0.0.1:9999');
});

test('defaults under homedir', () => {
  delete process.env.KENARI_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.KENARI_BASE_URL;
  assert.equal(paths.kenariHome(), path.join(os.homedir(), '.kenari'));
  assert.equal(paths.claudeConfigDir(), path.join(os.homedir(), '.claude'));
  assert.equal(paths.codexHome(), path.join(os.homedir(), '.codex'));
  assert.equal(paths.gatewayBase(), 'https://kenari.id');
  assert.equal(paths.credentialsPath(), path.join(os.homedir(), '.kenari', 'credentials.json'));
  assert.equal(paths.statePath(), path.join(os.homedir(), '.kenari', 'state.json'));
  assert.equal(paths.lockDir(), path.join(os.homedir(), '.kenari', 'lock'));
});
