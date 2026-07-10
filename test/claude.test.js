import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home, cdir;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-claude-'));
  cdir = path.join(home, 'claude');
  process.env.KENARI_HOME = path.join(home, 'kh');
  process.env.CLAUDE_CONFIG_DIR = cdir;
  delete process.env.KENARI_BASE_URL;
});

const MAPPING = { opus: 'glm-5-2', sonnet: 'kimi-k2-7-code', haiku: 'deepseek-v4-flash' };
const KEY = 'kn-f4kef4kef4kef4kef4kef4kef4ke1234';
const settings = () => JSON.parse(fs.readFileSync(path.join(cdir, 'settings.json'), 'utf8'));

test('detect: false when dir missing, true when present', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  assert.equal(claude.detect().installed, false);
  fs.mkdirSync(cdir, { recursive: true });
  assert.equal(claude.detect().installed, true);
});

test('apply on missing file creates minimal settings; restore deletes it', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  claude.apply(MAPPING, KEY);
  const s = settings();
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://kenari.id');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5-2');
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k2-7-code');
  assert.equal(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
  assert.equal(s.env.ANTHROPIC_MODEL, 'kimi-k2-7-code'); // main loop pinned to sonnet slot
  assert.equal(s.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
  assert.equal(claude.status().provider, 'kenari');
  const r = claude.restore();
  assert.equal(r.restored, true);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.existsSync(path.join(cdir, 'settings.json')), false);
});

test('user keys and prior env values survive the round trip', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({
    theme: 'dark',
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8', ANTHROPIC_MODEL: 'claude-sonnet-5', HTTP_PROXY: 'http://p:1' },
  }));
  claude.apply(MAPPING, KEY);
  assert.equal(settings().theme, 'dark');
  assert.equal(settings().env.HTTP_PROXY, 'http://p:1');
  assert.equal(settings().env.ANTHROPIC_MODEL, 'kimi-k2-7-code');
  claude.restore();
  const s = settings();
  assert.equal(s.theme, 'dark');
  assert.equal(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8');
  assert.equal(s.env.ANTHROPIC_MODEL, 'claude-sonnet-5'); // user's prior pin restored
  assert.equal(s.env.HTTP_PROXY, 'http://p:1');
  assert.equal(s.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('repeated apply keeps the FIRST baseline', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8' },
  }));
  claude.apply(MAPPING, KEY);
  claude.apply({ ...MAPPING, opus: 'deepseek-v4-pro' }, KEY);
  claude.restore();
  assert.equal(settings().env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8');
});

test('hand-edited owned key: restore leaves it and reports conflict; second restore finishes', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  claude.apply(MAPPING, KEY);
  const f = path.join(cdir, 'settings.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'my-custom';
  fs.writeFileSync(f, JSON.stringify(s));
  const r = claude.restore();
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0], /ANTHROPIC_DEFAULT_OPUS_MODEL/);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(after.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'my-custom'); // untouched
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, undefined);           // others restored
  // user resolves by hand, then restore again clears cleanly
  delete after.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  fs.writeFileSync(f, JSON.stringify(after));
  const r2 = claude.restore();
  assert.equal(r2.conflicts.length, 0);
});

test('restore without state reports not switched', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  const r = claude.restore();
  assert.equal(r.restored, false);
});

test('status reads reality: default before apply, kenari after, mapping echoed', async () => {
  const claude = (await import('../src/adapters/claude.js')).default;
  assert.equal(claude.status().provider, 'default');
  claude.apply(MAPPING, KEY);
  const st = claude.status();
  assert.equal(st.provider, 'kenari');
  assert.deepEqual(st.mapping, MAPPING);
});
