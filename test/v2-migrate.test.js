import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectOrphanedV1Signatures, migrateV1 } from '../src/migrate.js';
import { readJson, writeJson } from '../src/store.js';
import { configPath, statePath } from '../src/paths.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-migrate-'));
  const old = {
    KENARI_HOME: process.env.KENARI_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.KENARI_HOME = path.join(root, 'kenari');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('clean v1 migration restores owned values, removes credentials, converts roles, and backs up', (t) => {
  setup(t);
  const claudeFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const codexFile = path.join(process.env.CODEX_HOME, 'config.toml');
  const table = '[model_providers.kenari]\nbase_url = "https://kenari.id/v1"\nenv_key = "kn-secret"';
  writeJson(claudeFile, {
    keep: true,
    env: {
      KEEP: 'yes',
      ANTHROPIC_BASE_URL: 'https://kenari.id',
      ANTHROPIC_AUTH_TOKEN: 'kn-secret',
      ANTHROPIC_MODEL: 'sonnet-k',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-k',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-k',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-k',
    },
  });
  fs.writeFileSync(codexFile, `model = "gpt-k"\nmodel_provider = "kenari"\n\n${table}\n`, { mode: 0o640 });
  writeJson(statePath(), {
    version: 1,
    tools: {
      claude: {
        fileCreated: false, containerCreated: false,
        keys: {
          ANTHROPIC_BASE_URL: { before: null, applied: 'https://kenari.id' },
          ANTHROPIC_AUTH_TOKEN: { before: null, applied: 'kn-secret' },
          ANTHROPIC_MODEL: { before: null, applied: 'sonnet-k' },
          ANTHROPIC_DEFAULT_OPUS_MODEL: { before: 'native-opus', applied: 'opus-k' },
          ANTHROPIC_DEFAULT_SONNET_MODEL: { before: null, applied: 'sonnet-k' },
          ANTHROPIC_DEFAULT_HAIKU_MODEL: { before: null, applied: 'haiku-k' },
        },
      },
      codex: {
        fileCreated: false,
        keys: {
          model: { before: 'native-model', applied: 'gpt-k' },
          model_provider: { before: null, applied: 'kenari' },
          'table:model_providers.kenari': { before: null, applied: table },
        },
      },
    },
  });

  const result = migrateV1({ now: Date.UTC(2026, 0, 2, 3, 4, 5) });
  assert.deepEqual(result.migrated, ['claude', 'codex']);
  assert.deepEqual(result.conflicts, []);
  const claude = readJson(claudeFile);
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'native-opus');
  assert.equal(claude.env.KEEP, 'yes');
  const codex = fs.readFileSync(codexFile, 'utf8');
  assert.match(codex, /model = "native-model"/);
  assert.doesNotMatch(codex, /kn-secret|model_provider|model_providers\.kenari/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(codexFile).mode & 0o777, 0o640);
  }
  const config = readJson(configPath());
  assert.deepEqual(config.tools.claude.roles.main, { mode: 'fixed', model: 'kenari/sonnet-k' });
  assert.deepEqual(config.tools.codex.roles.main, { mode: 'fixed', model: 'kenari/gpt-k' });
  assert.equal(result.backups.length, 2);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.backups[1].path).mode & 0o777, 0o640);
  }
  assert.equal(readJson(statePath()).version, 2);
});

test('ambiguous hand edit aborts that tool, preserves file, and records exact key without value', (t) => {
  setup(t);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  writeJson(file, { env: { ANTHROPIC_AUTH_TOKEN: 'user-edited' } });
  writeJson(statePath(), {
    version: 1,
    tools: {
      claude: {
        fileCreated: false, containerCreated: false,
        keys: { ANTHROPIC_AUTH_TOKEN: { before: null, applied: 'kn-secret' } },
      },
    },
  });
  const before = fs.readFileSync(file, 'utf8');
  const result = migrateV1({ now: 0 });
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.conflicts, [{ tool: 'claude', key: 'ANTHROPIC_AUTH_TOKEN' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(JSON.stringify(readJson(statePath())).includes('user-edited'), false);
  assert.equal(JSON.stringify(readJson(statePath())).includes('kn-secret'), false);
});

test('migration conflict remains retryable after manual credential removal', (t) => {
  setup(t);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  writeJson(file, { env: { ANTHROPIC_AUTH_TOKEN: 'user-edited' } });
  writeJson(statePath(), {
    version: 1,
    tools: {
      claude: {
        fileCreated: false,
        containerCreated: false,
        keys: { ANTHROPIC_AUTH_TOKEN: { before: null, applied: 'kn-secret' } },
      },
    },
  });
  assert.equal(migrateV1().conflicts.length, 1);
  writeJson(file, { env: {} });
  const result = migrateV1();
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.migrated, ['claude']);
  assert.equal(readJson(statePath()).version, 2);
});

test('non-object Claude env and unsupported Codex scalar stay byte-for-byte unchanged', (t) => {
  setup(t);
  const claudeFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const codexFile = path.join(process.env.CODEX_HOME, 'config.toml');
  writeJson(claudeFile, { env: 'owned-by-user' });
  fs.writeFileSync(codexFile, "model_provider = 'mine'\n");
  writeJson(statePath(), {
    version: 1,
    tools: {
      claude: {
        fileCreated: false,
        containerCreated: false,
        keys: { ANTHROPIC_BASE_URL: { before: null, applied: 'https://kenari.id' } },
      },
      codex: {
        fileCreated: false,
        keys: { model_provider: { before: null, applied: 'kenari' } },
      },
    },
  });
  const claudeBefore = fs.readFileSync(claudeFile);
  const codexBefore = fs.readFileSync(codexFile);
  const result = migrateV1();
  assert.deepEqual(result.conflicts, [
    { tool: 'claude', key: 'env' },
    { tool: 'codex', key: 'model_provider' },
  ]);
  assert.deepEqual(fs.readFileSync(claudeFile), claudeBefore);
  assert.deepEqual(fs.readFileSync(codexFile), codexBefore);
});

test('orphaned version 1 signatures are reported without values', (t) => {
  setup(t);
  writeJson(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), {
    env: {
      ANTHROPIC_BASE_URL: 'https://kenari.id',
      ANTHROPIC_AUTH_TOKEN: 'kn-secret',
    },
  });
  fs.writeFileSync(
    path.join(process.env.CODEX_HOME, 'config.toml'),
    'model_provider = "kenari"\n\n[model_providers.kenari]\nbase_url = "https://kenari.id/v1"\n',
  );
  assert.deepEqual(detectOrphanedV1Signatures(), [
    { tool: 'claude', key: 'ANTHROPIC_BASE_URL' },
    { tool: 'claude', key: 'ANTHROPIC_AUTH_TOKEN' },
    { tool: 'codex', key: 'table:model_providers.kenari' },
    { tool: 'codex', key: 'model_provider' },
  ]);
});
