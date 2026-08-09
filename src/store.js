import fs from 'node:fs';
import path from 'node:path';
import { credentialsPath, statePath, lockDir } from './paths.js';

export class KenariError extends Error {}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomic(file, content) {
  let st = null;
  try { st = fs.lstatSync(file); } catch {}
  if (st && st.isSymbolicLink()) {
    throw new KenariError(
      `${file} is a symlink. Refusing to replace it with a regular file. ` +
      `Point the CLI at the real file or edit it manually.`);
  }
  const mode = st ? (st.mode & 0o777) : 0o600;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.kenari-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  let attempts = process.platform === 'win32' ? 5 : 1;
  for (;;) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      attempts -= 1;
      const retriable = ['EPERM', 'EBUSY', 'EACCES'].includes(e.code);
      if (attempts > 0 && retriable) { sleepSync(50); continue; }
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e;
    }
  }
}

export function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(raw); }
  catch {
    throw new KenariError(`${file} is not valid JSON. Fix or remove it, then retry.`);
  }
}

export function writeJson(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function writePrivateJson(file, obj) {
  writeJson(file, obj);
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function removeFile(file) {
  try { fs.rmSync(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export function getKey() {
  const c = readJson(credentialsPath());
  return c && typeof c.api_key === 'string' ? c.api_key : null;
}
export function setKey(key) {
  const k = key.trim();
  if (!/^kn-[A-Za-z0-9]{8,}$/.test(k)) {
    throw new KenariError('That does not look like a kenari API key (kn-...). Get one at https://kenari.id/keys');
  }
  writePrivateJson(credentialsPath(), { api_key: k });
}
export function deleteKey() {
  removeFile(credentialsPath());
}
export function maskKey(key) {
  return key.slice(0, 6) + '...' + key.slice(-3);
}

function validEffort(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.model !== 'string'
    || !(value.requested === null || typeof value.requested === 'string')
    || !(value.gated === null || typeof value.gated === 'string')
    || !Number.isInteger(value.status)
    || !Number.isFinite(value.at)) return null;
  return {
    model: value.model,
    requested: value.requested,
    gated: value.gated,
    status: value.status,
    at: value.at,
  };
}

export function loadState() {
  const parsed = readJson(statePath());
  if (parsed?.version === 2) {
    return {
      version: 2,
      migration: parsed.migration && typeof parsed.migration === 'object' ? parsed.migration : {},
      tools: {},
      effort: validEffort(parsed.effort),
    };
  }
  if (parsed && parsed.version && parsed.version !== 1) {
    throw new KenariError('state.json was written by a newer kenari CLI; upgrade this CLI or remove ~/.kenari/state.json');
  }
  // Both branches carry effort. A fresh install has no state.json at all and lands
  // here, on version 1, so leaving it off this branch would drop every record a new
  // user's session wrote: the file would grow the key and the next read would discard it.
  return {
    version: 1,
    tools: (parsed && typeof parsed.tools === 'object' && parsed.tools) || {},
    migration_conflicts: Array.isArray(parsed?.migration_conflicts) ? parsed.migration_conflicts : [],
    effort: validEffort(parsed?.effort),
  };
}
export function saveState(state) { writePrivateJson(statePath(), state); }
export function getToolState(id) { return loadState().tools[id] || null; }
export function setToolState(id, toolState) {
  const s = loadState();
  if (s.version !== 1) throw new KenariError('legacy provider switching is unavailable after version 2 migration');
  s.tools[id] = toolState;
  saveState(s);
}
export function clearToolState(id) {
  const s = loadState();
  if (s.version !== 1) throw new KenariError('legacy provider switching is unavailable after version 2 migration');
  delete s.tools[id];
  saveState(s);
}

export async function withLock(fn) {
  const lockPath = lockDir();
  const busy = () => new KenariError(
    `another kenari process is running. Wait for it to finish.`);
  const acquire = () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // O_EXCL: the lock file itself is the lock, atomic create-or-fail.
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    try { fs.chmodSync(lockPath, 0o600); } catch {}
  };
  try { acquire(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid = NaN;
    try { pid = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch {}
    if (Number.isInteger(pid) && pid > 0) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (alive) {
        throw new KenariError(`another kenari process is running (pid ${pid}). Wait for it to finish.`);
      }
    }
    // No live owner (missing/garbage/dead pid). Only reclaim if the lock file
    // is old enough that a concurrent acquisition cannot be in flight.
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(lockPath).mtimeMs; } catch {}
    if (mtimeMs >= Date.now() - 2000) throw busy();
    fs.rmSync(lockPath, { force: true });
    acquire();
  }
  try { return await fn(); }
  finally { fs.rmSync(lockPath, { force: true }); }
}
