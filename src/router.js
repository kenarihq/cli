import http from 'node:http';
import https from 'node:https';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KenariError } from './store.js';
import { validateGatewayUrl } from './gateway.js';

const REQUEST_STRIP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding',
  'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'upgrade',
  'keep-alive', 'proxy-connection', 'x-kenari-capability',
]);
const RESPONSE_STRIP = new Set([
  'connection', 'content-length', 'transfer-encoding',
  'proxy-authenticate', 'te', 'trailer', 'upgrade', 'keep-alive', 'proxy-connection',
]);
const NATIVE_AUTH_HEADERS = [
  'authorization', 'x-api-key', 'api-key', 'anthropic-api-key',
];

function safeHeaders(headers, strip) {
  const dynamicStrip = new Set(strip);
  for (const token of String(headers.connection || '').split(',')) {
    if (token.trim()) dynamicStrip.add(token.trim().toLowerCase());
  }
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!dynamicStrip.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

function replyJson(res, status, message) {
  const body = JSON.stringify({ error: { message } }) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function modelMap(catalog) {
  return new Map((catalog?.models || []).map((model) => [model.id, model]));
}

function compatibilityLimit(model, body, compatibility) {
  if (!model?.output_limit || !compatibility) return null;
  const requested = body.max_tokens ?? body.max_output_tokens;
  let desired = null;
  if (typeof compatibility === 'function') desired = compatibility({ model, requested, body });
  else {
    const rule = compatibility[model.id];
    if (rule && (rule.from === undefined || rule.from === requested)) desired = rule.to;
  }
  if (!Number.isInteger(desired) || desired <= requested || desired > model.output_limit) return null;
  return desired;
}

async function startRouterServer(options) {
  if (!options?.nativeBase || !options?.kenariBase) {
    throw new KenariError('router requires nativeBase and kenariBase');
  }
  const nativeBase = new URL(options.nativeBase);
  const kenariBase = new URL(options.kenariBase);
  const models = modelMap(options.catalog);
  const capabilityToken = options.capabilityToken || null;
  const bodyLimit = options.bodyLimit ?? 64 * 1024 * 1024;
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    if (capabilityToken && req.headers['x-kenari-capability'] !== capabilityToken) {
      replyJson(res, 403, 'invalid router capability');
      return;
    }
    let raw;
    let body = null;
    try {
      raw = await readBody(req, bodyLimit);
      if (raw.length) {
        try { body = JSON.parse(raw.toString('utf8')); } catch {}
      } else {
        body = {};
      }
    } catch (error) {
      if (!res.headersSent) replyJson(res, error.statusCode || 400, 'invalid request body');
      return;
    }

    const selected = typeof body?.model === 'string' ? body.model : '';
    const isKenari = selected.startsWith('kenari/');
    const id = isKenari ? selected.slice('kenari/'.length) : selected;
    const model = isKenari ? models.get(id) : null;
    if (isKenari && (!id || !model)) {
      replyJson(res, 400, `unknown or unavailable Kenari model "${selected}"`);
      return;
    }
    if (isKenari && !options.credential) {
      replyJson(res, 401, 'Kenari login required. Run: kenari login');
      return;
    }

    const target = isKenari ? kenariBase : nativeBase;
    const outgoing = { ...(body || {}) };
    if (isKenari) outgoing.model = id;
    const raised = isKenari ? compatibilityLimit(model, outgoing, options.compatibility) : null;
    if (raised !== null) {
      if ('max_output_tokens' in outgoing) outgoing.max_output_tokens = raised;
      else outgoing.max_tokens = raised;
    }
    const payload = isKenari ? Buffer.from(JSON.stringify(outgoing)) : raw;
    const headers = safeHeaders(req.headers, REQUEST_STRIP);
    if (isKenari) {
      for (const name of NATIVE_AUTH_HEADERS) delete headers[name];
      headers.authorization = `Bearer ${options.credential}`;
    }
    headers.host = target.host;
    headers['content-length'] = String(payload.length);
    const basePath = target.pathname.replace(/\/$/, '');
    const requestPath = req.url?.startsWith('/') ? req.url : `/${req.url || ''}`;
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: basePath + requestPath,
      headers,
    }, (upstreamRes) => {
      const responseHeaders = safeHeaders(upstreamRes.headers, RESPONSE_STRIP);
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      res.on('close', () => {
        if (!res.writableEnded) upstreamRes.destroy();
      });
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) replyJson(res, 502, `${isKenari ? 'Kenari' : 'native'} upstream error`);
      else res.destroy(error);
    });
    req.on('aborted', () => upstream.destroy());
    upstream.end(payload);
    if (options.debug) {
      const rewrite = raised === null ? '' : ` max_tokens=${body?.max_tokens ?? body?.max_output_tokens}->${raised}`;
      options.debug(`route=${isKenari ? 'kenari' : 'native'} model=${id}${rewrite}`);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const close = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of sockets) socket.destroy();
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    capabilityToken,
    close,
  };
}

function childError(message) {
  const error = new KenariError(message || 'router child failed');
  error.code = 'KENARI_ROUTER_CHILD';
  return error;
}

export async function startRouter(options) {
  if (typeof options?.compatibility === 'function') {
    throw new KenariError('router compatibility rules must be serializable data');
  }
  validateGatewayUrl(options.kenariBase);
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, KENARI_ROUTER_CHILD: '1' },
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => {
    childStderr = (childStderr + chunk.toString()).slice(-4000);
  });
  let settled = false;
  const ready = await new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : childError(String(error)));
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      const detail = childStderr.trim() ? `: ${childStderr.trim()}` : '';
      fail(childError(`router exited before ready (${signal || code})${detail}`));
    });
    child.on('message', (message) => {
      if (message?.type === 'ready' && !settled) {
        settled = true;
        resolve(message);
      } else if (message?.type === 'error') {
        fail(childError(message.message));
      } else if (message?.type === 'debug' && typeof options.debug === 'function') {
        options.debug(message.message);
      }
    });
    child.send({
      type: 'start',
      options: {
        nativeBase: options.nativeBase,
        kenariBase: options.kenariBase,
        credential: options.credential || null,
        catalog: options.catalog || null,
        capabilityToken: options.capabilityToken || null,
        bodyLimit: options.bodyLimit,
        compatibility: options.compatibility || null,
        debug: typeof options.debug === 'function',
      },
    });
  });
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.send({ type: 'shutdown' }); }
      catch { clearTimeout(timer); resolve(); }
    });
  };
  return {
    url: ready.url,
    port: ready.port,
    capabilityToken: ready.capabilityToken,
    childPid: child.pid,
    close,
  };
}

async function runRouterChild() {
  let router = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await router?.close(); } catch {}
    process.exit(0);
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('message', async (message) => {
    if (message?.type === 'shutdown') { await stop(); return; }
    if (message?.type !== 'start' || router) return;
    try {
      const childOptions = {
        ...message.options,
        debug: message.options.debug
          ? (line) => process.send?.({ type: 'debug', message: line })
          : null,
      };
      router = await startRouterServer(childOptions);
      process.send?.({
        type: 'ready',
        url: router.url,
        port: router.port,
        capabilityToken: router.capabilityToken,
      });
    } catch (error) {
      process.send?.({ type: 'error', message: error.message });
      await stop();
    }
  });
}

if (process.env.KENARI_ROUTER_CHILD === '1' && typeof process.send === 'function') {
  runRouterChild();
}
