import registry from './adapters/registry.js';
import { KenariError, getKey, setKey, deleteKey, maskKey, withLock } from './store.js';
import { fetchModels, formatRp, AuthError } from './gateway.js';
import { askHidden, pickNumber } from './prompt.js';

const isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function parseFlags(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1] ?? true; if (argv[i + 1] !== undefined) i += 1; }
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

async function readStdinLine() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split('\n')[0].trim();
}

function findAdapter(id) {
  return registry.find((a) => a.id === id) || null;
}

function printStatus() {
  for (const a of registry) {
    const det = a.detect();
    if (!det.installed) { console.log(`${a.id.padEnd(8)} not found`); continue; }
    const st = a.status();
    if (st.provider === 'kenari') {
      const map = Object.entries(st.mapping || {}).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`${a.id.padEnd(8)} kenari   ${map}`);
    } else {
      console.log(`${a.id.padEnd(8)} default`);
    }
    for (const n of st.notes) console.log(`         note: ${n}`);
  }
}

async function ensureKey() {
  const key = getKey();
  if (key) return key;
  if (!isTTY()) throw new KenariError('no API key stored. Run: kenari key set');
  const entered = await askHidden('kenari API key (kn-..., from https://kenari.id/keys): ');
  setKey(entered);
  return entered;
}

async function buildMapping(adapter, key, flags) {
  // Validate any flag-provided slot value up front. A bare `--opus` (no value)
  // parses as boolean true; it must fail with a clear message naming the slot
  // instead of slipping through as a bogus model id or an unvalidated offline
  // value.
  for (const slot of adapter.slots) {
    if (flags[slot.id] !== undefined) {
      const chosen = flags[slot.id];
      if (!(typeof chosen === 'string' && chosen.length > 0 && !chosen.startsWith('--'))) {
        throw new KenariError(`--${slot.id} needs a model id (e.g. --${slot.id} glm-5-2)`);
      }
    }
  }
  let catalog = null;
  try { catalog = await fetchModels(key); }
  catch (e) {
    if (e instanceof AuthError) throw e;
    const allProvided = adapter.slots.every((s) => flags[s.id]);
    if (!allProvided) throw new KenariError(e.message + '. To apply without validation, pass every slot flag explicitly.');
    console.log('warning: cannot reach gateway, applying without validation');
  }
  if (catalog && catalog.length === 0) {
    throw new KenariError('the kenari catalog returned no models; try again later');
  }
  const ids = catalog ? new Set(catalog.map((m) => m.id)) : null;
  const mapping = {};
  for (const slot of adapter.slots) {
    let chosen = flags[slot.id];
    if (chosen && ids && !ids.has(chosen)) {
      throw new KenariError(`model "${chosen}" is not in the kenari catalog. Run: kenari models`);
    }
    if (!chosen) {
      if (isTTY()) {
        const items = catalog.map((m) => `${m.id.padEnd(24)} in ${formatRp(m.in)}/1M  out ${formatRp(m.out)}/1M  ctx ${m.context ?? '-'}`);
        let defIdx = catalog.findIndex((m) => m.id === slot.defaultModel);
        if (defIdx === -1) defIdx = 0;
        const idx = await pickNumber(`${adapter.name}: ${slot.label}`, items, defIdx);
        chosen = catalog[idx].id;
      } else {
        chosen = slot.defaultModel;
        if (ids && !ids.has(chosen)) {
          throw new KenariError(`default model "${chosen}" is not in the catalog; pass --${slot.id} explicitly`);
        }
      }
    }
    mapping[slot.id] = chosen;
  }
  return mapping;
}

async function cmdUse(argv) {
  const { flags, rest } = parseFlags(argv);
  const toolId = rest[0];
  if (!toolId) throw new KenariError('usage: kenari use <claude|codex> [default]');
  const adapter = findAdapter(toolId);
  if (!adapter) {
    throw new KenariError(`unknown tool "${toolId}". Known tools: ${registry.map((a) => a.id).join(', ')}`);
  }
  const det = adapter.detect();
  if (!det.installed) {
    throw new KenariError(`${adapter.id} not found (looked for ${det.configPath})`);
  }

  if (rest[1] === 'default') {
    const { restored, conflicts } = await withLock(() => adapter.restore());
    if (!restored) { console.log(`${adapter.id} is not switched (nothing to restore)`); return 0; }
    if (conflicts.length === 0) {
      console.log(`ok: ${adapter.id} restored to its previous default`);
      return 0;
    }
    console.log(`${adapter.id}: restored with conflicts:`);
    for (const c of conflicts) console.log(`  ${c}`);
    return 1;
  }

  const key = await ensureKey();
  const mapping = await buildMapping(adapter, key, flags);
  await withLock(() => adapter.apply(mapping, key));
  const mapStr = Object.entries(mapping).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`ok: ${adapter.id} -> kenari (${mapStr})`);
  if (adapter.id === 'claude') {
    console.log('in-app /model now moves between your mapped kenari models');
  }
  return 0;
}

async function cmdModels() {
  const key = await ensureKey();
  const models = await fetchModels(key);
  console.log(`${'id'.padEnd(24)} ${'in /1M'.padStart(12)} ${'out /1M'.padStart(12)} ${'ctx'.padStart(10)}`);
  for (const m of models) {
    console.log(
      `${m.id.padEnd(24)} ${formatRp(m.in).padStart(12)} ${formatRp(m.out).padStart(12)} ${String(m.context ?? '-').padStart(10)}`,
    );
  }
  return 0;
}

async function cmdKey(argv) {
  const { flags, rest } = parseFlags(argv);
  const sub = rest[0] || 'show';
  if (sub === 'show') {
    const key = getKey();
    if (!key) { console.log('no key stored. Run: kenari key set'); return 0; }
    console.log(maskKey(key));
    return 0;
  }
  if (sub === 'delete') {
    deleteKey();
    console.log('deleted the stored API key');
    return 0;
  }
  if (sub === 'set') {
    let key;
    if (flags.stdin) key = await readStdinLine();
    else if (isTTY()) key = await askHidden('kenari API key (kn-...): ');
    else throw new KenariError('provide the key via --stdin');
    setKey(key);
    for (const a of registry) {
      if (!a.detect().installed) continue;
      const st = a.status();
      if (st.provider === 'kenari') {
        const vals = Object.values(st.mapping || {});
        if (vals.length === 0 || vals.some((v) => v === null || v === undefined || v === '')) {
          console.log(`warning: skipped re-applying to ${a.id} (its mapping is missing a model; run: kenari use ${a.id})`);
          continue;
        }
        await withLock(() => a.apply(st.mapping, key));
        console.log(`re-applied to ${a.id}`);
      }
    }
    console.log(`stored the API key (${maskKey(key)})`);
    return 0;
  }
  throw new KenariError(`unknown key command "${sub}". Use: set, show, delete`);
}

async function interactive() {
  printStatus();
  const installed = registry.filter((a) => a.detect().installed);
  if (installed.length === 0) {
    console.log('no supported tools installed (looked for Claude Code, Codex).');
    return 0;
  }
  const items = [...installed.map((a) => a.name), 'quit'];
  const pick = await pickNumber('switch which tool?', items, 0);
  if (pick === installed.length) return 0;
  const adapter = installed[pick];
  const target = await pickNumber('target?', ['kenari', 'default (restore)'], 0);
  if (target === 1) return await cmdUse([adapter.id, 'default']);
  return await cmdUse([adapter.id]);
}

const USAGE = `kenari CLI

usage:
  kenari                 interactive switcher
  kenari use <tool> [default] [--opus M --sonnet M --haiku M | --model M]
  kenari status          show what each tool points at
  kenari models          list kenari models with prices
  kenari key [set|show|delete]  manage the stored API key

tools: ${registry.map((a) => a.id).join(', ')}
`;

export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd) return isTTY() ? await interactive() : (printStatus(), 0);
    if (cmd === 'status') { printStatus(); return 0; }
    if (cmd === 'use') return await cmdUse(rest);
    if (cmd === 'models') return await cmdModels();
    if (cmd === 'key') return await cmdKey(rest);
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return 0; }
    console.error(`unknown command: ${cmd}\n${USAGE}`);
    return 1;
  } catch (e) {
    if (e instanceof KenariError) { console.error(`error: ${e.message}`); return 1; }
    throw e;
  }
}
