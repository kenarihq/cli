// SPDX-License-Identifier: GPL-3.0-or-later
import crypto from 'node:crypto';
import http from 'node:http';

export function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function genPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function genState() {
  return crypto.randomBytes(32).toString('hex');
}

export function buildLoopbackUrl(base, { challenge, state, port, host }) {
  return `${base}/cli-auth?challenge=${encodeURIComponent(challenge)}&state=${encodeURIComponent(state)}` +
    `&port=${port}&host=${encodeURIComponent(host)}`;
}

// How to hand the login URL to the desktop browser, per platform. Kept pure and
// exported so the platform matrix is testable without spawning anything.
//
// Windows must NOT go through cmd.exe. There, an unquoted `&` is a command
// separator and `%NAME%` expands, and node/libuv only quotes an argument that
// contains a space, tab or quote, so `cmd /c start "" <url>` shipped the URL
// raw: cmd opened `...?challenge=abc` and tried to run `state=...`, `port=...`
// and `host=...` as commands. The browser landed on /cli-auth with only the
// challenge and the page answered "This login link is invalid" every time.
// rundll32 is a real executable, so the URL stays one argv entry with no shell
// parsing at all.
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { file: 'open', args: [url] };
  if (platform === 'win32') return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  return { file: 'xdg-open', args: [url] };
}

// Self-contained: never reflects the code or a key. Just tells the person to
// go back to the terminal.
const CALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>kenari</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; color: #241F1B;">
<p>You are signed in. You can close this tab and return to your terminal.</p>
</body></html>
`;

// Exported on its own so a test can drive it with a fake req/res, no socket
// needed, in addition to the real-server tests below.
export function handleCallbackRequest(req, res, { expectedState, port, onCode }) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const hostHeader = req.headers.host || '';
  const hostOk = hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
  if (req.method !== 'GET' || url.pathname !== '/callback' || !hostOk) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (state !== expectedState) {
    res.statusCode = 400;
    res.end('state mismatch');
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(CALLBACK_HTML);
  onCode(code);
}

// Binds the loopback port first (no browser is opened until the caller has a
// port to put in the URL), then resolves once a valid /callback lands.
export function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let onCode;
    const codePromise = new Promise((res) => { onCode = res; });
    const server = http.createServer((req, res) => {
      handleCallbackRequest(req, res, { expectedState, port: server.address().port, onCode });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, codePromise });
    });
  });
}
