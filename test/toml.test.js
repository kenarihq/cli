import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as toml from '../src/toml.js';

const SAMPLE = `# my codex config
model = "gpt-5-5"  # keep me fast
approval_policy = "never"

[profiles.work]
model = "o5"

[mcp_servers.db]
command = "npx"
`;

test('getTopLevel reads only the top region', () => {
  assert.equal(toml.getTopLevel(SAMPLE, 'model'), 'gpt-5-5');
  assert.equal(toml.getTopLevel(SAMPLE, 'approval_policy'), 'never');
  assert.equal(toml.getTopLevel(SAMPLE, 'command'), null);
});

test('setTopLevel replaces in place, preserves everything else', () => {
  const out = toml.setTopLevel(SAMPLE, 'model', 'glm-5-2');
  assert.match(out, /^model = "glm-5-2"$/m);
  assert.ok(out.includes('# my codex config'));
  assert.ok(out.includes('[profiles.work]'));
  assert.equal(toml.getTopLevel(out, 'approval_policy'), 'never');
});

test('setTopLevel inserts before first header when absent', () => {
  const out = toml.setTopLevel(SAMPLE, 'model_provider', 'kenari');
  const topRegion = out.split('[')[0];
  assert.match(topRegion, /model_provider = "kenari"/);
});

test('setTopLevel on empty content', () => {
  const out = toml.setTopLevel('', 'model', 'glm-5-2');
  assert.equal(out, 'model = "glm-5-2"\n');
});

test('deleteTopLevel removes only that line', () => {
  const out = toml.deleteTopLevel(SAMPLE, 'model');
  assert.equal(toml.getTopLevel(out, 'model'), null);
  assert.equal(toml.getTopLevel(out, 'approval_policy'), 'never');
});

test('table roundtrip: set, get, replace, delete', () => {
  const body = ['name = "Kenari"', 'base_url = "https://kenari.id/v1"'];
  let out = toml.setTable(SAMPLE, 'model_providers.kenari', body);
  assert.ok(out.includes('[model_providers.kenari]'));
  const text = toml.getTableText(out, 'model_providers.kenari');
  assert.ok(text.startsWith('[model_providers.kenari]'));
  assert.ok(text.includes('base_url = "https://kenari.id/v1"'));
  // replace
  out = toml.setTable(out, 'model_providers.kenari', ['name = "K2"']);
  assert.ok(!out.includes('base_url'));
  assert.ok(out.includes('[profiles.work]'));
  // delete
  out = toml.deleteTable(out, 'model_providers.kenari');
  assert.equal(toml.getTableText(out, 'model_providers.kenari'), null);
  assert.ok(out.includes('[mcp_servers.db]'));
});

test('table at EOF and mid-file both bounded correctly', () => {
  const midBody = toml.getTableText(SAMPLE, 'profiles.work');
  assert.equal(midBody, '[profiles.work]\nmodel = "o5"');
  const eofBody = toml.getTableText(SAMPLE, 'mcp_servers.db');
  assert.equal(eofBody, '[mcp_servers.db]\ncommand = "npx"');
});

test('CRLF preserved', () => {
  const crlf = SAMPLE.replaceAll('\n', '\r\n');
  const out = toml.setTopLevel(crlf, 'model', 'glm-5-2');
  assert.ok(out.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(out));
});

test('content outside owned regions always survives', () => {
  const withComment = SAMPLE + '\n# tail comment\n';
  const out = toml.setTable(withComment, 'model_providers.kenari', ['name = "Kenari"']);
  assert.ok(out.includes('# tail comment'));
});

// A mixed-EOL file: top region uses CRLF, one table uses LF, the other CRLF.
// Dominant eol here is CRLF (6 CRLF vs 3 LF line endings).
const MIXED = [
  '# my codex config\r\n',
  'model = "gpt-5-5"\r\n',
  'approval_policy = "never"\r\n',
  '\r\n',
  '[profiles.work]\n',
  'model = "o5"\n',
  'extra = "keep"\n',
  '\r\n',
  '[mcp_servers.db]\r\n',
  'command = "npx"\r\n',
].join('');

test('mixed-EOL setTopLevel keeps every table, line, and key', () => {
  const out = toml.setTopLevel(MIXED, 'model', 'glm-5-2');
  // the edit landed
  assert.equal(toml.getTopLevel(out, 'model'), 'glm-5-2');
  // nothing merged or destroyed: both headers and every key still present
  assert.ok(out.includes('[profiles.work]'));
  assert.ok(out.includes('[mcp_servers.db]'));
  assert.ok(out.includes('extra = "keep"'));
  assert.ok(out.includes('command = "npx"'));
  assert.equal(toml.getTopLevel(out, 'approval_policy'), 'never');
  assert.equal(toml.getTableText(out, 'profiles.work'), '[profiles.work]\nmodel = "o5"\nextra = "keep"');
  // output uses the dominant eol (CRLF) uniformly: no lone LF survives
  assert.ok(out.includes('\r\n'));
  assert.ok(!/(?<!\r)\n/.test(out));
});

test('mixed-EOL setTable replace does not duplicate the table', () => {
  const out = toml.setTable(MIXED, 'profiles.work', ['model = "o5"']);
  const headers = out.match(/\[profiles\.work\]/g) || [];
  assert.equal(headers.length, 1);
  // the LF-terminated old body was found and replaced, not appended after
  assert.ok(!out.includes('extra = "keep"'));
  assert.ok(out.includes('[mcp_servers.db]'));
});
