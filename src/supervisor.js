// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { KenariError } from './store.js';
import { startRouter } from './router.js';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// Windows cannot execute a file whose extension it does not recognise. npm installs
// three shims side by side, `claude` for a Unix-like shell, `claude.cmd` for cmd and
// PowerShell, and `claude.ps1`. Joining the directory and the bare name found the
// first one, so CreateProcess answered ENOENT for a file that plainly exists, and
// `kenari claude` could not start on Windows at all. The bare name stays as the last
// candidate rather than being dropped, because an extensionless file that is a real
// executable image does run on Windows. Preferring the extensions fixes the shim case
// without taking that away.
// PATHEXT is conventionally uppercase while npm writes `claude.cmd` in lowercase, so
// each extension is tried in both cases. A normal Windows filesystem is case
// insensitive and would match either, but a directory can be marked case sensitive
// through WSL interop, and there the case has to be right.
export function binaryCandidates(name, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || path.extname(name)) return [name];
  const names = [];
  for (const raw of (env.PATHEXT || DEFAULT_PATHEXT).split(';')) {
    const ext = raw.trim();
    if (!ext) continue;
    for (const cased of [ext, ext.toLowerCase()]) {
      const candidate = `${name}${cased}`;
      if (!names.includes(candidate)) names.push(candidate);
    }
  }
  names.push(name);
  return names;
}

// A .cmd or .bat is a script for the command interpreter, not an image CreateProcess
// can load, so it goes through cmd.exe. Node documents this and deprecates the
// shell option for it (DEP0190), leaving cmd.exe with the file as an argument.
export function spawnTarget(binary, args = [], env = process.env, platform = process.platform) {
  const extension = path.extname(binary).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/c', binary, ...args] };
  }
  return { file: binary, args: [...args] };
}

export function resolveBinary(name, options = {}) {
  if (!name || name.includes(path.sep)) {
    if (name && fs.existsSync(name)) return name;
    throw new KenariError(`original tool not found: ${name || '(missing name)'}`);
  }
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exclude = new Set((options.exclude || []).map((file) => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  }));
  const searched = [];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const candidateName of binaryCandidates(name, env, platform)) {
      const candidate = path.join(dir, candidateName);
      searched.push(candidate);
      try {
        const real = fs.realpathSync(candidate);
        if (!exclude.has(real) && fs.statSync(real).isFile()) {
          fs.accessSync(real, fs.constants.X_OK);
          return real;
        }
      } catch {}
    }
  }
  throw new KenariError(`original ${name} not found (searched ${searched.join(', ') || 'empty PATH'})`);
}

// Windows has no signal delivery. child.kill there terminates the target whatever name
// it is given, so forwarding SIGWINCH killed the wrapped session outright: the CI runner
// reported the child dead with signalCode SIGKILL after a resize. The other three are
// forwarded because termination is what they mean anyway. On POSIX all four are real
// signals and a resize has to reach the TUI for it to redraw.
export function forwardedSignals(platform = process.platform) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (platform !== 'win32') signals.push('SIGWINCH');
  return signals;
}

function exitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  const number = signal && os.constants.signals[signal];
  return number ? 128 + number : 1;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

// A helper process the tool needs for the whole session, such as the private Codex app
// server behind `kenari codex agents`. It is started before the tool, counts as ready
// once its socket path exists, and is stopped and cleaned up when the session ends.
export async function startSidecar(binary, spec, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const target = spawnTarget(binary, spec.args, env);
  // Its own process group on POSIX: a Ctrl-C meant for the TUI must not drain the server,
  // and a kill has to reach the native binary behind an npm launcher as well.
  const child = spawn(target.file, target.args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let tail = '';
  child.stderr.on('data', (chunk) => { tail = (tail + chunk.toString()).slice(-4096); });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
  let done = false;
  exited.then(() => { done = true; });

  const signalTree = (signal) => {
    if (done) return;
    if (process.platform === 'win32') {
      // child.kill on a .cmd shim ends cmd.exe and leaves the real server running.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  };
  const waitExit = (ms) => Promise.race([exited.then(() => true), delay(ms).then(() => false)]);
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      // Codex drains on the first SIGTERM and stops at once on the second. The session
      // that used this server has ended, so nothing is left to drain for.
      if (!done) {
        signalTree('SIGTERM');
        if (!(await waitExit(2000))) {
          signalTree('SIGTERM');
          if (!(await waitExit(3000))) {
            signalTree('SIGKILL');
            await waitExit(2000);
          }
        }
      }
      for (const file of spec.leftovers || []) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
    })();
    return stopping;
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (done) {
      await stop();
      const { code, signal, error } = await exited;
      const detail = stripAnsi(tail).trim().split('\n').filter(Boolean).pop()
        || error?.message
        || (signal ? `signal ${signal}` : `exit code ${code}`);
      throw new KenariError(`the Codex app server did not start: ${detail}`);
    }
    try {
      fs.lstatSync(spec.socketPath);
      return { child, stop };
    } catch {}
    if (options.signal?.aborted || Date.now() > deadline) {
      await stop();
      if (options.signal?.aborted) return null;
      throw new KenariError('the Codex app server did not start within 20 seconds');
    }
    await delay(25);
  }
}

export async function runWrappedTool(options) {
  const router = await startRouter(options.routerOptions);
  let child;
  let sidecar;
  let privateDir = null;
  let interrupted = null;
  const abort = new AbortController();
  const listeners = [];
  // Registered before anything else starts, so an interrupt while the sidecar is still
  // coming up ends the run through the cleanup below instead of killing this process
  // and leaving the sidecar behind.
  for (const signal of forwardedSignals()) {
    const handler = () => {
      if (child) {
        if (child.exitCode === null && !child.killed) {
          try { child.kill(signal); } catch {}
        }
        return;
      }
      if (signal === 'SIGWINCH') return;
      interrupted = signal;
      abort.abort();
    };
    try {
      process.on(signal, handler);
      listeners.push([signal, handler]);
    } catch {}
  }
  try {
    const built = options.runtimeBuilder({
      routerUrl: router.url,
      routerCapabilityToken: router.capabilityToken,
      args: options.args || [],
      env: options.env || process.env,
      // A 0700 directory for this run only, created on first use and removed at the end.
      privateDir: () => {
        privateDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'kenari-run-'));
        return privateDir;
      },
      ...(options.runtimeOptions || {}),
    });
    if (built.sidecar && !interrupted) {
      sidecar = await startSidecar(options.binary, built.sidecar, built.env, {
        signal: abort.signal,
        timeoutMs: options.sidecarTimeoutMs,
      });
    }
    if (interrupted) return exitCode(null, interrupted);
    const target = spawnTarget(options.binary, built.args, built.env);
    child = spawn(target.file, target.args, {
      env: built.env,
      stdio: 'inherit',
      windowsHide: false,
    });
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(exitCode(code, signal)));
    });
  } finally {
    for (const [signal, handler] of listeners) process.off(signal, handler);
    if (sidecar) await sidecar.stop();
    if (privateDir) {
      try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch {}
    }
    await router.close();
  }
}
