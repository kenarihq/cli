import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-claude-detect-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
});

test('Claude adapter only detects installation and never edits settings', async () => {
  const adapter = (await import('../src/adapters/claude.js')).default;
  assert.equal(adapter.detect().installed, false);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, '{"theme":"dark"}\n');
  assert.equal(adapter.detect().installed, true);
  assert.equal(adapter.detect().configPath, settings);
  assert.deepEqual(Object.keys(adapter).sort(), ['detect', 'id', 'name']);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"theme":"dark"}\n');
});
