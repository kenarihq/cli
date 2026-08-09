import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexKenariModels } from '../src/runtime/codex.js';

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

test('Codex catalog uses gateway reasoning options, including explicit empty options', () => {
  const native = [{
    slug: 'native',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
  }];
  const models = codexKenariModels({
    models: [
      { id: 'gemini-3-6-flash', reasoning_options: ['minimal', 'low', 'medium', 'high'] },
      { id: 'gemini-2-5-flash', reasoning_options: null },
      { id: 'gpt-image-2', reasoning_options: [] },
    ],
  }, native);

  assert.deepEqual(models[0].supported_reasoning_levels, [
    { effort: 'minimal', description: 'minimal reasoning' },
    { effort: 'low', description: 'low reasoning' },
    { effort: 'medium', description: 'medium reasoning' },
    { effort: 'high', description: 'high reasoning' },
  ]);
  assert.equal(models[0].default_reasoning_level, 'minimal');
  assert.deepEqual(models[1].supported_reasoning_levels, [
    { effort: 'low', description: 'low reasoning' },
    { effort: 'medium', description: 'medium reasoning' },
  ]);
  assert.equal(models[1].default_reasoning_level, 'low');
  assert.deepEqual(models[2].supported_reasoning_levels, []);
  assert.equal(models[2].default_reasoning_level, undefined);
});
