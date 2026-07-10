import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home, cxdir, cfg;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-codex-'));
  cxdir = path.join(home, 'codex');
  cfg = path.join(cxdir, 'config.toml');
  process.env.KENARI_HOME = path.join(home, 'kh');
  process.env.CODEX_HOME = cxdir;
  delete process.env.KENARI_BASE_URL;
});

const KEY = 'kn-f4kef4kef4kef4kef4kef4kef4ke1234';
const USER_CFG = `# hand-tuned
model = "gpt-5-5"
approval_policy = "never"

[mcp_servers.db]
command = "npx"
`;

test('apply writes provider table + top-level keys, preserves user content', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  fs.mkdirSync(cxdir, { recursive: true });
  fs.writeFileSync(cfg, USER_CFG);
  codex.apply({ model: 'glm-5-2' }, KEY);
  const out = fs.readFileSync(cfg, 'utf8');
  assert.match(out, /^model = "glm-5-2"$/m);
  assert.match(out, /^model_provider = "kenari"$/m);
  assert.ok(out.includes('[model_providers.kenari]'));
  assert.ok(out.includes('base_url = "https://kenari.id/v1"'));
  assert.ok(out.includes('wire_api = "chat"'));
  assert.ok(out.includes(`http_headers = { "Authorization" = "Bearer ${KEY}" }`));
  assert.ok(out.includes('# hand-tuned'));
  assert.ok(out.includes('approval_policy = "never"'));
  assert.ok(out.includes('[mcp_servers.db]'));
});

test('status: default before, kenari after, mapping echoed', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  assert.equal(codex.status().provider, 'default');
  codex.apply({ model: 'glm-5-2' }, KEY);
  const st = codex.status();
  assert.equal(st.provider, 'kenari');
  assert.deepEqual(st.mapping, { model: 'glm-5-2' });
});

test('restore returns exact prior file content', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  fs.mkdirSync(cxdir, { recursive: true });
  fs.writeFileSync(cfg, USER_CFG);
  codex.apply({ model: 'glm-5-2' }, KEY);
  const r = codex.restore();
  assert.equal(r.restored, true);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.readFileSync(cfg, 'utf8'), USER_CFG);
});

test('apply on missing file creates it; restore removes it', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  codex.apply({ model: 'glm-5-2' }, KEY);
  assert.ok(fs.existsSync(cfg));
  codex.restore();
  assert.equal(fs.existsSync(cfg), false);
});

test('repeated apply keeps first baseline', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  fs.mkdirSync(cxdir, { recursive: true });
  fs.writeFileSync(cfg, USER_CFG);
  codex.apply({ model: 'glm-5-2' }, KEY);
  codex.apply({ model: 'kimi-k2-7-code' }, KEY);
  codex.restore();
  assert.equal(fs.readFileSync(cfg, 'utf8'), USER_CFG);
});

test('hand-edited provider table conflicts, rest restores', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  fs.mkdirSync(cxdir, { recursive: true });
  fs.writeFileSync(cfg, USER_CFG);
  codex.apply({ model: 'glm-5-2' }, KEY);
  let cur = fs.readFileSync(cfg, 'utf8');
  cur = cur.replace('name = "Kenari"', 'name = "Mine"');
  fs.writeFileSync(cfg, cur);
  const r = codex.restore();
  assert.equal(r.conflicts.length, 1);
  const out = fs.readFileSync(cfg, 'utf8');
  assert.match(out, /^model = "gpt-5-5"$/m);       // top-level restored
  assert.ok(out.includes('name = "Mine"'));         // table left alone
});

test('hand-edited key conflicts, second restore finishes after user resolves', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  fs.mkdirSync(cxdir, { recursive: true });
  fs.writeFileSync(cfg, USER_CFG);
  codex.apply({ model: 'glm-5-2' }, KEY);
  // user hand-edits an owned top-level key away from what we applied
  let cur = fs.readFileSync(cfg, 'utf8');
  cur = cur.replace('model_provider = "kenari"', 'model_provider = "mine"');
  fs.writeFileSync(cfg, cur);
  const r = codex.restore();
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0], /model_provider/);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('model_provider = "mine"')); // left alone
  // user resolves by hand: model_provider had no baseline, so removing it matches before=null
  cur = fs.readFileSync(cfg, 'utf8');
  cur = cur.replace('model_provider = "mine"\n', '');
  fs.writeFileSync(cfg, cur);
  const r2 = codex.restore();
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.restored, true);
});

test('hand-edited table conflicts, second restore finishes after user removes it', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  fs.mkdirSync(cxdir, { recursive: true });
  fs.writeFileSync(cfg, USER_CFG);
  codex.apply({ model: 'glm-5-2' }, KEY);
  let cur = fs.readFileSync(cfg, 'utf8');
  cur = cur.replace('name = "Kenari"', 'name = "Mine"');
  fs.writeFileSync(cfg, cur);
  const r = codex.restore();
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0], /model_providers\.kenari/);
  // user resolves by hand: the table had no baseline, so removing it matches before=null
  const codexMod = await import('../src/adapters/codex.js');
  const toml = await import('../src/toml.js');
  cur = toml.deleteTable(fs.readFileSync(cfg, 'utf8'), 'model_providers.kenari');
  fs.writeFileSync(cfg, cur);
  const r2 = codexMod.default.restore();
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.restored, true);
});

test('apply refuses a single-quoted (literal) top-level key, leaves file untouched', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  const { KenariError } = await import('../src/store.js');
  fs.mkdirSync(cxdir, { recursive: true });
  const literal = "model = 'gpt-5-5'\napproval_policy = \"never\"\n";
  fs.writeFileSync(cfg, literal);
  assert.throws(() => codex.apply({ model: 'glm-5-2' }, KEY), KenariError);
  assert.equal(fs.readFileSync(cfg, 'utf8'), literal);
});

test('restore without state reports not switched', async () => {
  const codex = (await import('../src/adapters/codex.js')).default;
  const r = codex.restore();
  assert.equal(r.restored, false);
  assert.deepEqual(r.conflicts, []);
});
