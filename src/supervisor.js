// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { KenariError } from './store.js';
import { startRouter } from './router.js';

export function resolveBinary(name, options = {}) {
  if (!name || name.includes(path.sep)) {
    if (name && fs.existsSync(name)) return name;
    throw new KenariError(`original tool not found: ${name || '(missing name)'}`);
  }
  const env = options.env || process.env;
  const exclude = new Set((options.exclude || []).map((file) => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  }));
  const searched = [];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    searched.push(candidate);
    try {
      const real = fs.realpathSync(candidate);
      if (!exclude.has(real) && fs.statSync(real).isFile()) {
        fs.accessSync(real, fs.constants.X_OK);
        return real;
      }
    } catch {}
  }
  throw new KenariError(`original ${name} not found (searched ${searched.join(', ') || 'empty PATH'})`);
}

function exitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  const number = signal && os.constants.signals[signal];
  return number ? 128 + number : 1;
}

export async function runWrappedTool(options) {
  const router = await startRouter(options.routerOptions);
  let child;
  const listeners = [];
  try {
    const built = options.runtimeBuilder({
      routerUrl: router.url,
      routerCapabilityToken: router.capabilityToken,
      args: options.args || [],
      env: options.env || process.env,
      ...(options.runtimeOptions || {}),
    });
    child = spawn(options.binary, built.args, {
      env: built.env,
      stdio: 'inherit',
      windowsHide: false,
    });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGWINCH']) {
      const handler = () => {
        if (child.exitCode === null && !child.killed) {
          try { child.kill(signal); } catch {}
        }
      };
      try {
        process.on(signal, handler);
        listeners.push([signal, handler]);
      } catch {}
    }
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(exitCode(code, signal)));
    });
  } finally {
    for (const [signal, handler] of listeners) process.off(signal, handler);
    await router.close();
  }
}
