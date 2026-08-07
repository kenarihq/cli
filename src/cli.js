import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import registry from './adapters/registry.js';
import {
  KenariError,
  deleteKey,
  getKey,
  loadState,
  maskKey,
  removeFile,
  setKey,
  withLock,
} from './store.js';
import {
  ROLE_DEFINITIONS,
  getToolConfig,
  hasKenariRoutes,
  loadConfig,
  saveConfig,
} from './config.js';
import {
  loadCatalogCache,
  loadCatalogForLaunch,
  writeMergedCodexCatalog,
} from './catalog.js';
import { fetchCatalog, formatRp } from './gateway.js';
import { ask, askHidden, askYesNo, pickNumber } from './prompt.js';
import { gatewayBase, modelCachePath, runtimeDir } from './paths.js';
import { genPkce, genState, buildLoopbackUrl, startCallbackServer } from './oauth.js';
import { resolveBinary, runWrappedTool } from './supervisor.js';
import { buildClaudeLaunch } from './runtime/claude.js';
import {
  buildCodexLaunch,
  loadCodexNativeModels,
  resolveCodexNativeBase,
} from './runtime/codex.js';
import { startRouter } from './router.js';
import { detectOrphanedV1Signatures, detectV1State, migrateV1 } from './migrate.js';

const isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const TOOLS = Object.keys(ROLE_DEFINITIONS);

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      const hasValue = next !== undefined && !next.startsWith('--');
      flags[arg.slice(2)] = hasValue ? next : true;
      if (hasValue) i += 1;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

async function readStdinLine() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split('\n')[0].trim();
}

function findAdapter(id) {
  return registry.find((adapter) => adapter.id === id) || null;
}

function assertTool(tool) {
  if (!TOOLS.includes(tool)) {
    throw new KenariError(`unknown tool "${tool}". Known tools: ${TOOLS.join(', ')}`);
  }
}

function defaultRoles(tool) {
  const roles = {};
  for (const role of Object.keys(ROLE_DEFINITIONS[tool])) {
    roles[role] = { mode: tool === 'codex' && role !== 'main' ? 'inherit' : 'native' };
  }
  return roles;
}

function parseRoleValue(tool, role, value) {
  if (typeof value !== 'string' || value === '') {
    throw new KenariError(`--${role} needs native, inherit, picker, or kenari/<model-id>`);
  }
  if (value.startsWith('kenari/')) return { mode: 'fixed', model: value };
  if (!ROLE_DEFINITIONS[tool][role].includes(value)) {
    throw new KenariError(`unsupported ${tool}.${role} value "${value}"`);
  }
  return { mode: value };
}

function fixedIds(roles) {
  return Object.values(roles)
    .filter((role) => role.mode === 'fixed')
    .map((role) => role.model.slice('kenari/'.length));
}

function storedMigrationConflicts(tool) {
  const state = loadState();
  if (state.version === 1) {
    return (state.migration_conflicts || []).filter((item) => !tool || item.tool === tool);
  }
  return Object.entries(state.migration?.tools || {})
    .filter(([id, value]) => (!tool || id === tool) && value?.status === 'conflict')
    .flatMap(([id, value]) => (value.keys || []).map((key) => ({ tool: id, key })));
}

async function prepareMigration(tool) {
  if (detectV1State()) {
    const result = await withLock(() => migrateV1());
    const conflicts = result.conflicts.filter((item) => !tool || item.tool === tool);
    if (conflicts.length) {
      throw new KenariError(
        `migration conflict: ${conflicts.map((item) => `${item.tool}.${item.key}`).join(', ')}`,
      );
    }
    if (result.migrated.length) {
      console.error(`migrated version 1 routing: ${result.migrated.join(', ')}`);
    }
  }
  const orphaned = detectOrphanedV1Signatures().filter((item) => !tool || item.tool === tool);
  if (orphaned.length) {
    throw new KenariError(
      `unowned version 1 routing found: ${orphaned.map((item) => `${item.tool}.${item.key}`).join(', ')}`,
    );
  }
  const conflicts = storedMigrationConflicts(tool);
  if (conflicts.length) {
    throw new KenariError(
      `migration conflict: ${conflicts.map((item) => `${item.tool}.${item.key}`).join(', ')}`,
    );
  }
}

async function catalogForRoles(roles) {
  const needsCatalog = fixedIds(roles).length > 0
    || Object.values(roles).some((role) => role.mode === 'picker');
  if (!needsCatalog) return null;
  const key = getKey();
  if (!key) throw new KenariError('Kenari login required. Run: kenari login');
  const result = await loadCatalogForLaunch({ key, requireKenari: true });
  if (result.warning) console.log(`warning: ${result.warning}`);
  const ids = new Set(result.cache.models.map((model) => model.id));
  for (const id of fixedIds(roles)) {
    if (!ids.has(id)) {
      throw new KenariError(`model "kenari/${id}" is not in the Kenari catalog. Run: kenari models`);
    }
  }
  return result.cache;
}

async function pickFixedModel(tool, role, current) {
  const key = getKey();
  if (!key) throw new KenariError('Kenari login required. Run: kenari login');
  const { cache, warning } = await loadCatalogForLaunch({ key, requireKenari: true });
  if (warning) console.log(`warning: ${warning}`);
  if (!cache.models.length) throw new KenariError('the Kenari catalog returned no models');
  const items = cache.models.map((model) => (
    `kenari/${model.id}  ${formatRp(model.input_price)} in  `
    + `${formatRp(model.output_price)} out  ${model.context_limit ?? '-'} context`
  ));
  const currentId = current?.mode === 'fixed' ? current.model : '';
  let defaultIndex = cache.models.findIndex((model) => `kenari/${model.id}` === currentId);
  if (defaultIndex < 0) defaultIndex = 0;
  const selected = await pickNumber(`${tool}: ${role}`, items, defaultIndex);
  return { mode: 'fixed', model: `kenari/${cache.models[selected].id}` };
}

async function configureAdvanced(tool, current) {
  const roles = {};
  for (const [role, modes] of Object.entries(ROLE_DEFINITIONS[tool])) {
    const labels = modes.map((mode) => mode === 'fixed' ? 'fixed Kenari model' : mode);
    const previous = current?.[role]?.mode;
    let defaultIndex = modes.indexOf(previous);
    if (defaultIndex < 0) defaultIndex = 0;
    const index = await pickNumber(`${tool}: ${role}`, labels, defaultIndex);
    const mode = modes[index];
    roles[role] = mode === 'fixed'
      ? await pickFixedModel(tool, role, current?.[role])
      : { mode };
  }
  return roles;
}

async function configureClaude(current) {
  const roleIds = Object.keys(ROLE_DEFINITIONS.claude);
  const prior = roleIds.filter((role) => current?.[role]?.mode === 'fixed');
  const answer = await ask(
    `Claude roles to use Kenari (${roleIds.join(', ')})`
    + ` [Enter = ${prior.length ? prior.join(',') : 'none'}]: `,
  );
  const selected = answer === ''
    ? prior
    : answer.toLowerCase() === 'none'
      ? []
      : answer.split(',').map((value) => value.trim()).filter(Boolean);
  const unknown = selected.filter((role) => !roleIds.includes(role));
  if (unknown.length) throw new KenariError(`unknown Claude role "${unknown[0]}"`);
  const roles = defaultRoles('claude');
  for (const role of selected) roles[role] = await pickFixedModel('claude', role, current?.[role]);
  return roles;
}

async function configureCodex(current) {
  const roles = defaultRoles('codex');
  const modes = ['native', 'picker', 'fixed'];
  let defaultIndex = modes.indexOf(current?.main?.mode);
  if (defaultIndex < 0) defaultIndex = 1;
  const selected = modes[await pickNumber(
    'Codex: add Kenari models to the active model selection?',
    ['native only', 'native and Kenari picker', 'fixed Kenari model'],
    defaultIndex,
  )];
  roles.main = selected === 'fixed'
    ? await pickFixedModel('codex', 'main', current?.main)
    : { mode: selected };
  if (await askYesNo('Configure review and subagent roles independently?', false)) {
    return configureAdvanced('codex', { ...current, main: roles.main });
  }
  return roles;
}

function printRoutingSummary(tool, roles) {
  console.log(tool === 'claude' ? 'Claude Code' : 'Codex');
  for (const [role, value] of Object.entries(roles)) {
    const target = value.mode === 'fixed' ? value.model : value.mode;
    console.log(`  ${role.padEnd(12)} ${target}`);
  }
}

function detectedTools() {
  return registry.filter((adapter) => {
    try {
      resolveBinary(adapter.id, { exclude: [process.argv[1]] });
      return true;
    } catch {
      return adapter.detect().installed;
    }
  }).map((adapter) => adapter.id);
}

export async function chooseConfigureTools(installed, choose = pickNumber) {
  if (installed.length === 1) return [...installed];
  const options = registry.map((adapter) => ({
    label: adapter.name,
    tools: [adapter.id],
  }));
  options.push({ label: 'Both', tools: registry.map((adapter) => adapter.id) });
  const selected = await choose(
    'Configure which tool?',
    options.map((option) => option.label),
    options.length - 1,
  );
  return options[selected].tools;
}

async function cmdConfigure(argv) {
  const { flags, rest } = parseFlags(argv);
  const requested = rest[0];
  if (requested) assertTool(requested);
  let tools;
  if (requested) {
    tools = [requested];
  } else {
    if (flags.yes) {
      throw new KenariError('--yes requires an explicit tool: kenari configure claude|codex');
    }
    if (!isTTY()) {
      throw new KenariError('non-interactive configuration requires an explicit tool');
    }
    const installed = detectedTools();
    if (!installed.length) {
      console.log('warning: Claude Code and Codex were not detected');
    }
    tools = await chooseConfigureTools(installed);
  }

  for (const tool of tools) await prepareMigration(tool);
  let config = loadConfig() || { version: 2, tools: {} };
  const summaries = [];
  for (const tool of tools) {
    const current = getToolConfig(config, tool)?.roles || null;
    let roles;
    if (flags.yes) {
      const roleIds = Object.keys(ROLE_DEFINITIONS[tool]);
      const missing = roleIds.filter((role) => !(role in flags));
      if (missing.length) {
        throw new KenariError(`--yes requires every ${tool} role; missing --${missing.join(', --')}`);
      }
      roles = {};
      for (const role of roleIds) roles[role] = parseRoleValue(tool, role, flags[role]);
    } else {
      if (!isTTY()) throw new KenariError('non-interactive configuration requires --yes and every role');
      const advanced = await askYesNo(`Use advanced ${tool} role configuration?`, false);
      roles = advanced
        ? await configureAdvanced(tool, current)
        : tool === 'claude'
          ? await configureClaude(current)
          : await configureCodex(current);
    }
    await catalogForRoles(roles);
    config = {
      version: 2,
      tools: { ...config.tools, [tool]: { roles } },
    };
    summaries.push([tool, roles]);
  }
  for (const [tool, roles] of summaries) printRoutingSummary(tool, roles);
  await withLock(() => saveConfig(config));
  console.log('ok: routing configuration saved');
  return 0;
}

async function cmdReset(argv) {
  const { rest } = parseFlags(argv);
  const requested = rest[0];
  if (requested) assertTool(requested);
  if (requested) await prepareMigration(requested);
  else if (detectV1State()) await prepareMigration();
  const config = loadConfig();
  if (!config) {
    console.log('nothing to reset');
    return 0;
  }
  const tools = requested ? [requested] : Object.keys(config.tools);
  const next = { version: 2, tools: { ...config.tools } };
  for (const tool of tools) delete next.tools[tool];
  await withLock(() => saveConfig(next));
  if (!hasKenariRoutes(next)) removeFile(modelCachePath());
  console.log(`ok: reset ${tools.length ? tools.join(', ') : 'routing configuration'}`);
  return 0;
}

function cacheAge(cache) {
  if (!cache) return null;
  return Math.max(0, Date.now() - Date.parse(cache.fetched_at));
}

function offlineStatus() {
  const config = loadConfig();
  const cache = loadCatalogCache();
  const tools = {};
  for (const tool of TOOLS) {
    const configured = config?.tools?.[tool];
    tools[tool] = configured
      ? Object.fromEntries(Object.entries(configured.roles).map(([role, value]) => [
        role,
        value.mode === 'fixed' ? value.model : value.mode,
      ]))
      : null;
  }
  return {
    version: 2,
    credential: getKey() ? 'stored' : 'missing',
    cache: cache ? {
      age_ms: cacheAge(cache),
      fetched_at: cache.fetched_at,
      gateway: cache.gateway,
      models: cache.models.length,
    } : null,
    migration_conflicts: [...storedMigrationConflicts(), ...detectOrphanedV1Signatures()],
    tools,
  };
}

async function boundedReachable(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return { ok: response.status < 500, status: response.status };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function runStatusChecks(status) {
  const checks = {};
  let router;
  try {
    router = await startRouter({
      nativeBase: 'https://127.0.0.1:9',
      kenariBase: 'https://127.0.0.1:9',
      credential: null,
      catalog: null,
    });
    checks.router = { ok: true };
  } catch (error) {
    checks.router = { ok: false, error: error.message };
  } finally {
    await router?.close();
  }
  checks.native_anthropic = await boundedReachable('https://api.anthropic.com');
  checks.native_openai = await boundedReachable('https://api.openai.com');
  const key = getKey();
  if (!key) {
    checks.kenari = { ok: false, error: 'login required' };
    checks.catalog = { ok: false, error: 'login required' };
  } else {
    try {
      const body = await fetchCatalog(key);
      checks.kenari = { ok: true };
      checks.catalog = { ok: Array.isArray(body.data), models: body.data?.length ?? 0 };
    } catch (error) {
      checks.kenari = { ok: false, error: error.message };
      checks.catalog = { ok: false, error: error.message };
    }
  }
  return { ...status, checks };
}

async function cmdStatus(argv) {
  const { flags, rest } = parseFlags(argv);
  if (rest.length) throw new KenariError('usage: kenari status [--check] [--json]');
  let status = offlineStatus();
  if (flags.check) status = await runStatusChecks(status);
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    return Object.values(status.checks || {}).some((check) => !check.ok) ? 1 : 0;
  }
  console.log(`credential  ${status.credential}`);
  console.log(`catalog     ${status.cache ? `${status.cache.models} models, age ${Math.round(status.cache.age_ms / 1000)}s` : 'missing'}`);
  for (const conflict of status.migration_conflicts) {
    console.log(`conflict    ${conflict.tool}.${conflict.key}`);
  }
  for (const [tool, roles] of Object.entries(status.tools)) {
    console.log(`${tool.padEnd(11)}${roles ? 'configured' : 'not configured'}`);
    for (const [role, target] of Object.entries(roles || {})) {
      console.log(`  ${role.padEnd(12)} ${target}`);
    }
  }
  for (const [name, check] of Object.entries(status.checks || {})) {
    console.log(`check ${name.padEnd(17)} ${check.ok ? 'ok' : `failed: ${check.error || check.status}`}`);
  }
  return Object.values(status.checks || {}).some((check) => !check.ok) ? 1 : 0;
}

async function cmdModels(argv) {
  const { flags, rest } = parseFlags(argv);
  if (rest.length) throw new KenariError('usage: kenari models [--json]');
  let cache = null;
  const key = getKey();
  if (key) {
    const result = await loadCatalogForLaunch({
      key,
      requireKenari: true,
      maxAgeMs: 0,
    });
    cache = result.cache;
    if (result.warning) console.log(`warning: ${result.warning}`);
  } else {
    cache = (await loadCatalogForLaunch({ refresh: false, requireKenari: false })).cache;
  }
  if (!cache) throw new KenariError('no model catalog cached. Run: kenari login, then kenari configure');
  const output = {
    fetched_at: cache.fetched_at,
    age_ms: cacheAge(cache),
    models: cache.models.map((model) => ({
      id: `kenari/${model.id}`,
      input_price: model.input_price,
      output_price: model.output_price,
      context_limit: model.context_limit,
      output_limit: model.output_limit,
      reasoning_efforts: model.reasoning_efforts,
    })),
  };
  if (flags.json) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }
  console.log(`${'id'.padEnd(30)} ${'in /1M'.padStart(12)} ${'out /1M'.padStart(12)} ${'context'.padStart(10)} ${'output'.padStart(10)}`);
  for (const model of output.models) {
    console.log(
      `${model.id.padEnd(30)} ${formatRp(model.input_price).padStart(12)} `
      + `${formatRp(model.output_price).padStart(12)} `
      + `${String(model.context_limit ?? '-').padStart(10)} `
      + `${String(model.output_limit ?? '-').padStart(10)}`,
    );
  }
  console.log(`cache age: ${Math.round(output.age_ms / 1000)}s`);
  return 0;
}

function originalBinary(tool) {
  return resolveBinary(tool, { exclude: [process.argv[1]] });
}

function assertSelectedModels(toolConfig, cache) {
  const available = new Set((cache?.models || []).map((model) => model.id));
  for (const id of fixedIds(toolConfig.roles)) {
    if (!available.has(id)) {
      throw new KenariError(`selected model "kenari/${id}" is unavailable. Run: kenari configure`);
    }
  }
}

async function ensureConfigured(tool) {
  await prepareMigration(tool);
  let config = loadConfig();
  if (!getToolConfig(config, tool)) {
    if (!isTTY()) throw new KenariError(`missing ${tool} configuration, run: kenari configure ${tool}`);
    await cmdConfigure([tool]);
    config = loadConfig();
  }
  return { config, toolConfig: getToolConfig(config, tool) };
}

async function runTool(tool, args) {
  const { config, toolConfig } = await ensureConfigured(tool);
  const requireKenari = hasKenariRoutes(config, tool);
  const key = getKey();
  if (requireKenari && !key) throw new KenariError('Kenari login required. Run: kenari login');
  const { cache, warning } = await loadCatalogForLaunch({
    key,
    requireKenari,
  });
  if (warning) console.error(`warning: ${warning}`);
  if (requireKenari) assertSelectedModels(toolConfig, cache);

  const binary = originalBinary(tool);
  let catalogPath = null;
  if (tool === 'codex' && cache) {
    fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
    catalogPath = path.join(runtimeDir(), `models-${process.pid}-${randomBytes(6).toString('hex')}.json`);
    writeMergedCodexCatalog(loadCodexNativeModels(binary), cache, catalogPath);
  }
  const kenariBase = tool === 'codex' ? `${gatewayBase()}/v1` : gatewayBase();
  const nativeBase = tool === 'codex'
    ? resolveCodexNativeBase(binary, process.env)
    : (process.env.KENARI_CLAUDE_NATIVE_BASE_URL || 'https://api.anthropic.com');
  const runtimeBuilder = tool === 'codex' ? buildCodexLaunch : buildClaudeLaunch;
  try {
    return await runWrappedTool({
      binary,
      args,
      env: process.env,
      routerOptions: {
        nativeBase,
        kenariBase,
        credential: key,
        catalog: cache,
        capabilityToken: tool === 'claude' ? randomBytes(32).toString('base64url') : null,
      },
      runtimeBuilder,
      runtimeOptions: { toolConfig, catalogPath },
    });
  } finally {
    if (catalogPath) removeFile(catalogPath);
  }
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT = Symbol('login-timeout');
const LOGIN_INTERRUPT = Symbol('login-interrupt');

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function printLoginUrl(url) {
  console.log('Open this URL to approve:');
  console.log(url);
  openBrowser(url);
}

async function exchangeCode(base, code, verifier) {
  let response;
  try {
    response = await fetch(base + '/api/cli-auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    });
  } catch (error) {
    throw new KenariError(`cannot reach ${base}: ${error.cause?.code || error.message}`);
  }
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new KenariError(message || `login failed (HTTP ${response.status})`);
  }
  return response.json();
}

async function finishLogin(base, code, verifier) {
  try {
    const response = await exchangeCode(base, code, verifier);
    setKey(response.key);
    console.log(`ok: signed in as ${response.prefix || maskKey(response.key)}`);
    return 0;
  } catch (error) {
    if (!(error instanceof KenariError)) throw error;
    console.error(`error: ${error.message}`);
    console.error('Retry with: kenari login');
    return 1;
  }
}

async function loginLoopback(base, host) {
  const { verifier, challenge } = genPkce();
  const state = genState();
  const { server, port, codePromise } = await startCallbackServer(state);
  printLoginUrl(buildLoopbackUrl(base, { challenge, state, port, host }));
  let timer;
  let signalHandler;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(LOGIN_TIMEOUT), LOGIN_TIMEOUT_MS);
    });
    const interrupt = new Promise((resolve) => {
      signalHandler = () => resolve(LOGIN_INTERRUPT);
      process.once('SIGINT', signalHandler);
    });
    const result = await Promise.race([codePromise, timeout, interrupt]);
    if (result === LOGIN_TIMEOUT) {
      console.error('login timed out, run `kenari login` again');
      return 1;
    }
    if (result === LOGIN_INTERRUPT) {
      console.error('login cancelled');
      return 1;
    }
    return finishLogin(base, result, verifier);
  } finally {
    clearTimeout(timer);
    if (signalHandler) process.off('SIGINT', signalHandler);
    server.close();
  }
}

const LOGIN_USAGE = 'usage: kenari login [--api-key]';
const KEYS_URL = 'https://kenari.id/keys';

// Hidden prompt on a terminal, stdin when piped, so one flag covers both an
// SSH session and a container entrypoint. Gated on stdin alone: stdout may be
// redirected while the operator is still typing at a real terminal.
async function readApiKey() {
  if (process.stdin.isTTY) return askHidden(`Paste your kenari API key (kn-...): `);
  return readStdinLine();
}

export async function loginApiKey(read = readApiKey) {
  const key = await read();
  if (!key) throw new KenariError(`no API key entered. Create one at ${KEYS_URL}`);
  setKey(key);
  console.log(`ok: stored ${maskKey(key)}`);
  return 0;
}

const REMOVED_LOGIN_FLAGS = ['no-browser', 'paste', 'stdin'];

async function cmdLogin(argv) {
  const { flags, rest } = parseFlags(argv);
  if (rest.length) throw new KenariError(LOGIN_USAGE);
  const removed = REMOVED_LOGIN_FLAGS.find((flag) => flag in flags);
  if (removed) {
    throw new KenariError(
      `--${removed} was removed. On a machine with no browser, run \`kenari login --api-key\` ` +
      `and paste a key from ${KEYS_URL}.\n${LOGIN_USAGE}`);
  }
  if ('api-key' in flags) {
    // parseFlags would happily swallow `--api-key kn-...`; refuse it rather
    // than let the key land in shell history and in `ps` output.
    if (typeof flags['api-key'] === 'string') {
      throw new KenariError(
        '--api-key takes no value: a key passed on the command line is recorded in your shell ' +
        'history and visible in `ps`. Run `kenari login --api-key` and paste at the prompt, ' +
        'or pipe it: echo "$KENARI_KEY" | kenari login --api-key');
    }
    return loginApiKey();
  }
  const base = typeof flags.base === 'string' && flags.base ? flags.base : gatewayBase();
  return loginLoopback(base, os.hostname());
}

async function cmdLogout() {
  deleteKey();
  console.log('ok: logged out');
  return 0;
}

const USAGE = `kenari CLI

usage:
  kenari configure [claude|codex] [role flags] [--yes]
  kenari reset [claude|codex]
  kenari claude [args...]
  kenari codex [args...]
  kenari status [--check] [--json]
  kenari models [--json]
  kenari login [--api-key]
  kenari logout
  kenari help

model values: native, picker, inherit, or kenari/<model-id>
`;

export async function main(argv) {
  try {
    const [command, ...rest] = argv;
    if (!command) {
      console.log(USAGE);
      return 0;
    }
    if (command === 'configure') return await cmdConfigure(rest);
    if (command === 'reset') return await cmdReset(rest);
    if (command === 'claude' || command === 'codex') return await runTool(command, rest);
    if (command === 'status') return await cmdStatus(rest);
    if (command === 'models') return await cmdModels(rest);
    if (command === 'login') return await cmdLogin(rest);
    if (command === 'logout') return await cmdLogout();
    if (command === '--help' || command === '-h' || command === 'help') {
      console.log(USAGE);
      return 0;
    }
    console.error(`unknown command: ${command}\n${USAGE}`);
    return 1;
  } catch (error) {
    if (error instanceof KenariError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
