import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-grok-detect-'));
  process.env.GROK_HOME = path.join(home, 'grok');
});

test('Grok adapter only detects installation and never edits config', async () => {
  const adapter = (await import('../src/adapters/grok.js')).default;
  assert.equal(adapter.detect().installed, false);
  fs.mkdirSync(process.env.GROK_HOME, { recursive: true });
  const config = path.join(process.env.GROK_HOME, 'config.toml');
  fs.writeFileSync(config, 'models.default = "grok-build"\n');
  assert.equal(adapter.detect().installed, true);
  assert.equal(adapter.detect().configPath, config);
  assert.deepEqual(Object.keys(adapter).sort(), ['detect', 'id', 'name']);
  assert.equal(adapter.id, 'grok');
  assert.equal(adapter.name, 'Grok Build');
  assert.equal(fs.readFileSync(config, 'utf8'), 'models.default = "grok-build"\n');
});
