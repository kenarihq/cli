// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import https from 'node:https';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { KenariError } from './store.js';
import { validateGatewayUrl } from './gateway.js';
import { remapClaudeModel } from './runtime/claude.js';

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

function stripClaudeOneMMarker(model) {
  return model.replace(/\[1m\]$/i, '');
}

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

function requestPathOnly(url) {
  return String(url || '/').split('?')[0];
}

function modelsListPath(url) {
  return /\/models\/?$/.test(requestPathOnly(url));
}

function isHelloPath(url) {
  return requestPathOnly(url) === '/api/hello';
}

function prefixKenariCatalog(raw) {
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return raw; }
  const list = Array.isArray(parsed?.data) ? parsed.data
    : Array.isArray(parsed?.models) ? parsed.models
    : null;
  if (!list) return raw;
  for (const entry of list) {
    if (entry && typeof entry.id === 'string' && !entry.id.startsWith('kenari/')) {
      entry.id = `kenari/${entry.id}`;
    }
  }
  return Buffer.from(JSON.stringify(parsed));
}

function injectServerTools(outgoing, types) {
  if (!Array.isArray(types) || !types.length) return outgoing;
  const tools = Array.isArray(outgoing.tools) ? [...outgoing.tools] : [];
  for (const type of types) {
    if (!tools.some((tool) => tool && tool.type === type)) tools.push({ type });
  }
  return { ...outgoing, tools };
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

const UPSTREAM_HINT = 'Check your internet connection, VPN or proxy, then try again.';
const UPSTREAM_CAUSE_LIMIT = 120;

// What failed, as one short token. The error code tells DNS (ENOTFOUND), refused
// (ECONNREFUSED), reset (ECONNRESET), timeout (ETIMEDOUT) and TLS apart. Errors that
// carry no code fall back to their message, trimmed so a long one cannot flood the line.
function upstreamCause(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const text = (code || String(error?.message ?? '')).replace(/\s+/g, ' ').trim();
  if (text.length > UPSTREAM_CAUSE_LIMIT) return `${text.slice(0, UPSTREAM_CAUSE_LIMIT).trimEnd()}...`;
  return text || 'unknown error';
}

// The body of the 502 when a call to the upstream fails. The wrapped tool shows it as the
// API error, so it is the only diagnosis the customer ever sees: the cause says what
// failed and the hostname says which side. Nothing from the request goes in, no header,
// no credential and no body. Customer copy carries no semicolons, so none can get in
// through the message of a library error either.
export function describeUpstreamError(error, { kenari, hostname }) {
  const label = kenari ? 'Kenari' : 'native';
  return `${label} upstream error (${upstreamCause(error)} connecting to ${hostname}). ${UPSTREAM_HINT}`
    .replace(/;/g, ',');
}

// A pooled socket the server closed fails within one round trip of the write. A reset that
// comes later means the upstream had the whole call and was working on it, and a second
// call would be billed twice.
export const STALE_RETRY_WINDOW_MS = 1000;

// Node keeps connections alive since 19, and Cloudflare closes idle ones. A request that
// goes out on a pooled socket in the moment it closes fails with ECONNRESET before any
// byte of a response, and sending it once more on a new connection is the pattern the
// Node http docs give. It is the only failure repeated. A reset on a fresh socket is a
// real one, and so is one that took longer than the window above to arrive. Once a
// response has started the upstream has done the work. A second failure ends it, so a
// call is sent at most twice. A client that has gone is not worth a second billed call.
// elapsedMs is the time from handing the call over to the error. Without a number, no retry.
export function shouldRetryUpstream({
  reusedSocket, code, received, retried, clientGone, elapsedMs,
}) {
  return reusedSocket === true && code === 'ECONNRESET' && !received && !retried && !clientGone
    && Number.isFinite(elapsedMs) && elapsedMs <= STALE_RETRY_WINDOW_MS;
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
  const onEffort = typeof options.onEffort === 'function' ? options.onEffort : null;
  const effortPins = new Map(Object.entries(options.effortPins || {}));
  // Keyed by model, not one shared key. Claude Code alternates slots inside a session,
  // sonnet for the work and haiku for background tasks, so a single key would see every
  // alternation as a change and report on every request for the whole session.
  const lastEffort = new Map();

  // Diagnostic only, so a hook that throws must never reach the request it describes.
  function debugLine(line) {
    if (!options.debug) return;
    try { options.debug(line); } catch {}
  }

  // Observe only. The gateway owns clamping and stripping and has a tested matrix for
  // it; a router that adjusted the level here would make this record a lie.
  function recordEffort(upstreamRes, body, model, pinned) {
    const asked = pinned ?? body?.output_config?.effort;
    const stamped = upstreamRes.headers['x-kenari-gated-effort'];
    // requested is what the upstream actually received, so a pin reports the pinned
    // level rather than what the session happened to send. The flag keeps the two
    // distinguishable, because a status line that silently disagreed with the client
    // is the confusion this whole feature exists to remove.
    const requested = typeof asked === 'string' ? asked : null;
    const gated = typeof stamped === 'string' ? stamped : null;
    const status = upstreamRes.statusCode || 0;
    // Three primitive compares, on a proxy that sees every request of a session. The
    // record and its timestamp are built only when something actually changed, so an
    // unchanged response costs no allocation and no serialization.
    const isPinned = typeof pinned === 'string';
    const last = lastEffort.get(model);
    if (last && last.requested === requested && last.gated === gated && last.status === status) return;
    lastEffort.set(model, { requested, gated, status });
    try { onEffort({ model, requested, gated, status, pinned: isPinned, at: Date.now() }); } catch {}
  }

  const server = http.createServer(async (req, res) => {
    const requestPath = req.url?.startsWith('/') ? req.url : `/${req.url || ''}`;
    // Warmup probe. Claude Code HEAD/GETs this before inference and may omit the
    // capability header; answering here keeps a stand-in session from 401ing on boot.
    if (isHelloPath(requestPath) && (req.method === 'HEAD' || req.method === 'GET')) {
      res.writeHead(200);
      res.end();
      return;
    }
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

    const catalogList = Boolean(options.kenariCatalog)
      && req.method === 'GET'
      && modelsListPath(requestPath);
    if (!catalogList && body && typeof body.model === 'string' && options.claudeRoles) {
      const remapped = remapClaudeModel(body.model, req.headers, options.claudeRoles);
      if (remapped !== body.model) body = { ...body, model: remapped };
    }
    const selected = catalogList ? '' : (typeof body?.model === 'string' ? body.model : '');
    const isKenari = catalogList || selected.startsWith('kenari/');
    const id = catalogList
      ? ''
      : isKenari
        ? stripClaudeOneMMarker(selected.slice('kenari/'.length))
        : selected;
    const model = isKenari && !catalogList ? models.get(id) : null;
    if (isKenari && !catalogList && (!id || !model)) {
      replyJson(res, 400, `unknown or unavailable Kenari model "${selected}"`);
      return;
    }
    if (isKenari && !options.credential) {
      replyJson(res, 401, 'Kenari login required. Run: kenari login');
      return;
    }

    const target = isKenari ? kenariBase : nativeBase;
    let outgoing = { ...(body || {}) };
    // A pinned slot wins over whatever the session sent. Claude Code's effort is a
    // single session-wide setting, so a user running a native orchestrator that
    // delegates to a Kenari slot has no way to ask for a level on that slot alone.
    // The pin is that missing control, and it is the user's own configuration, not the
    // router second-guessing a request. Native routes are never touched.
    let pinned;
    if (isKenari && !catalogList) {
      outgoing.model = id;
      outgoing = injectServerTools(outgoing, options.injectTools);
      pinned = effortPins.get(id);
      if (pinned) {
        const config = outgoing.output_config;
        outgoing.output_config = {
          ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}),
          effort: pinned,
        };
      }
    }
    const raised = isKenari && !catalogList
      ? compatibilityLimit(model, outgoing, options.compatibility)
      : null;
    if (raised !== null) {
      if ('max_output_tokens' in outgoing) outgoing.max_output_tokens = raised;
      else outgoing.max_tokens = raised;
    }
    const payload = isKenari && !catalogList ? Buffer.from(JSON.stringify(outgoing)) : raw;
    const headers = safeHeaders(req.headers, REQUEST_STRIP);
    if (isKenari) {
      for (const name of NATIVE_AUTH_HEADERS) delete headers[name];
      headers.authorization = `Bearer ${options.credential}`;
    }
    headers.host = target.host;
    headers['content-length'] = String(payload.length);
    const basePath = target.pathname.replace(/\/$/, '');
    const transport = target.protocol === 'https:' ? https : http;
    const route = isKenari ? 'kenari' : 'native';
    // The call is built in one function so it can be issued twice. Once, and again if it
    // fails the way a stale keep-alive socket fails (see shouldRetryUpstream). The payload
    // is a buffer, so the second call is the same bytes as the first.
    let upstream = null;
    let received = false;
    let retried = false;
    let clientAborted = false;
    const onResponse = (upstreamRes) => {
      received = true;
      if (onEffort && isKenari && !catalogList) recordEffort(upstreamRes, body, id, pinned);
      const terminateDownstream = (error) => {
        if (!res.destroyed) res.destroy(error);
      };
      upstreamRes.on('aborted', () => {
        terminateDownstream(new Error(`${isKenari ? 'Kenari' : 'native'} upstream response aborted`));
      });
      upstreamRes.on('error', terminateDownstream);
      if (catalogList) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const rewritten = prefixKenariCatalog(Buffer.concat(chunks));
          const responseHeaders = safeHeaders(upstreamRes.headers, RESPONSE_STRIP);
          delete responseHeaders['content-length'];
          responseHeaders['content-length'] = String(rewritten.length);
          res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
          res.end(rewritten);
        });
        return;
      }
      const responseHeaders = safeHeaders(upstreamRes.headers, RESPONSE_STRIP);
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.on('close', () => {
        if (!upstreamRes.complete) {
          terminateDownstream(new Error(`${isKenari ? 'Kenari' : 'native'} upstream response closed early`));
        }
      });
      upstreamRes.pipe(res);
      res.on('close', () => {
        if (!res.writableEnded) upstreamRes.destroy();
      });
    };
    // Answers the client when the call to the upstream failed. A client that has gone has
    // nobody to tell, and one that already has headers can only be cut off.
    const failUpstream = (error, detail = '') => {
      debugLine(`upstream-error route=${route} host=${target.hostname} cause=${upstreamCause(error)} retried=${retried}${detail}`);
      if (res.destroyed) return;
      if (!res.headersSent) {
        replyJson(res, 502, describeUpstreamError(error, { kenari: isKenari, hostname: target.hostname }));
      } else {
        res.destroy(error);
      }
    };
    const sendUpstream = () => {
      let attempt;
      try {
        attempt = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: req.method,
          path: basePath + requestPath,
          headers,
        }, onResponse);
      } catch (error) {
        // Thrown before anything is sent, for a header value Node refuses for one. Left
        // alone it ends the whole router and every later call of the session with it.
        failUpstream(error);
        return;
      }
      upstream = attempt;
      const sentAt = performance.now();
      attempt.on('error', (error) => {
        if (attempt !== upstream) return;
        const elapsedMs = performance.now() - sentAt;
        const after = `after=${Math.round(elapsedMs)}ms`;
        if (shouldRetryUpstream({
          reusedSocket: attempt.reusedSocket,
          code: error?.code,
          received,
          retried,
          clientGone: clientAborted || res.destroyed,
          elapsedMs,
        })) {
          retried = true;
          debugLine(`upstream-retry route=${route} host=${target.hostname} cause=${upstreamCause(error)} ${after}`);
          sendUpstream();
          return;
        }
        failUpstream(error, ` reused=${attempt.reusedSocket === true} ${after}`);
      });
      attempt.end(payload);
    };
    // The client left before the response was whole. Nobody will read the answer, so the
    // call it waits on is cancelled instead of billed. This replaces a listener on the
    // request's 'aborted', which only fires before the body is read and so never ran. A
    // response that ended is a normal completion, and then there is nothing to cancel.
    res.on('close', () => {
      if (res.writableEnded) return;
      clientAborted = true;
      debugLine(`upstream-cancel route=${route} host=${target.hostname}`);
      upstream?.destroy();
    });
    sendUpstream();
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

export function sanitizeForkExecArgv(execArgv = process.execArgv) {
  const safe = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    if (['-e', '--eval', '-p', '--print'].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--eval=') || arg.startsWith('--print=')
      || arg.startsWith('--input-type')) {
      continue;
    }
    safe.push(arg);
  }
  return safe;
}

export async function startRouter(options) {
  if (typeof options?.compatibility === 'function') {
    throw new KenariError('router compatibility rules must be serializable data');
  }
  validateGatewayUrl(options.kenariBase);
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, KENARI_ROUTER_CHILD: '1' },
    execArgv: sanitizeForkExecArgv(),
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
      } else if (message?.type === 'effort' && typeof options.onEffort === 'function') {
        try { options.onEffort(message.record); } catch {}
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
        effortPins: options.effortPins || null,
        injectTools: options.injectTools || null,
        kenariCatalog: Boolean(options.kenariCatalog),
        claudeRoles: options.claudeRoles || null,
        debug: typeof options.debug === 'function',
        onEffort: typeof options.onEffort === 'function',
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
        onEffort: message.options.onEffort
          ? (record) => process.send?.({ type: 'effort', record })
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
