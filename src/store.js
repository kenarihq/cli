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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.kenari-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
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

export function getKey() {
  const c = readJson(credentialsPath());
  return c && typeof c.api_key === 'string' ? c.api_key : null;
}
export function setKey(key) {
  if (!/^kn-[A-Za-z0-9]{8,}$/.test(key)) {
    throw new KenariError('That does not look like a kenari API key (kn-...). Get one at https://kenari.id/keys');
  }
  writeJson(credentialsPath(), { api_key: key });
}
export function deleteKey() {
  try { fs.rmSync(credentialsPath()); } catch {}
}
export function maskKey(key) {
  return key.slice(0, 6) + '...' + key.slice(-3);
}

export function loadState() {
  return readJson(statePath()) || { version: 1, tools: {} };
}
export function saveState(state) { writeJson(statePath(), state); }
export function getToolState(id) { return loadState().tools[id] || null; }
export function setToolState(id, toolState) {
  const s = loadState();
  s.tools[id] = toolState;
  saveState(s);
}
export function clearToolState(id) {
  const s = loadState();
  delete s.tools[id];
  saveState(s);
}

export async function withLock(fn) {
  const dir = lockDir();
  const pidFile = path.join(dir, 'pid');
  const acquire = () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.mkdirSync(dir); // throws EEXIST when held
    fs.writeFileSync(pidFile, String(process.pid));
  };
  try { acquire(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid = NaN;
    try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
    let alive = false;
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); alive = true; } catch {}
    }
    if (alive) throw new KenariError(`another kenari process is running (pid ${pid}). Wait for it to finish.`);
    fs.rmSync(dir, { recursive: true, force: true });
    acquire();
  }
  try { return await fn(); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
