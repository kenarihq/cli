// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import { KenariError } from '../store.js';
import { grokAuthPath } from '../paths.js';

export const GROK_CHAT_PROXY_ORIGIN = 'https://cli-chat-proxy.grok.com';
export const GROK_API_ORIGIN = 'https://api.x.ai';

const OVERRIDDEN_ENV = [
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'GROK_MODELS_BASE_URL',
  'GROK_XAI_API_BASE_URL',
  'GROK_DEFAULT_MODEL',
];

export function grokRouterBase(routerUrl) {
  return `${String(routerUrl).replace(/\/+$/, '')}/v1`;
}

export function grokRoutesEverySlot(roles = {}) {
  return ['main', 'subagents'].every((role) => roles[role]?.mode === 'fixed');
}

export function findGrokEnvConflicts(env = process.env) {
  return OVERRIDDEN_ENV.filter((name) => typeof env[name] === 'string' && env[name] !== '');
}

export function resolveGrokNativeBase(env = process.env) {
  if (env.KENARI_GROK_NATIVE_BASE_URL) {
    return env.KENARI_GROK_NATIVE_BASE_URL.replace(/\/+$/, '');
  }
  try {
    if (fs.existsSync(grokAuthPath())) return GROK_CHAT_PROXY_ORIGIN;
  } catch {}
  if (env.XAI_API_KEY?.trim()) return GROK_API_ORIGIN;
  throw new KenariError('cannot determine Grok login method. Run: grok login');
}

export function buildGrokLaunch(options) {
  const inputEnv = options.env || process.env;
  const args = options.args || [];
  const roles = options.toolConfig?.roles || {};
  const routerBase = grokRouterBase(options.routerUrl);
  const env = { ...inputEnv, GROK_CLI_CHAT_PROXY_BASE_URL: routerBase };
  const allKenari = grokRoutesEverySlot(roles);

  if (options.nativeOrigin === GROK_API_ORIGIN) {
    env.GROK_XAI_API_BASE_URL = routerBase;
  }
  if (allKenari) {
    env.GROK_MODELS_BASE_URL = routerBase;
    if (options.standInCredential) {
      env.XAI_API_KEY = options.standInCredential;
      // The stand-in is not an xAI key. Point API-key inference at the router too,
      // or Grok would send it to api.x.ai.
      env.GROK_XAI_API_BASE_URL = routerBase;
    }
  }
  if (roles.main?.mode === 'fixed') env.GROK_DEFAULT_MODEL = roles.main.model;
  else if (!( 'GROK_DEFAULT_MODEL' in inputEnv)) delete env.GROK_DEFAULT_MODEL;

  return { args: [...args], env };
}
