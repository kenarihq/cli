import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-codex-detect-'));
  process.env.CODEX_HOME = path.join(home, 'codex');
});

test('Codex adapter only detects installation and never edits config', async () => {
  const adapter = (await import('../src/adapters/codex.js')).default;
  assert.equal(adapter.detect().installed, false);
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const config = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(config, 'approval_policy = "never"\n');
  assert.equal(adapter.detect().installed, true);
  assert.equal(adapter.detect().configPath, config);
  assert.deepEqual(Object.keys(adapter).sort(), ['detect', 'id', 'name']);
  assert.equal(fs.readFileSync(config, 'utf8'), 'approval_policy = "never"\n');
});
