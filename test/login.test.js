import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  base64url,
  genPkce,
  genState,
  buildLoopbackUrl,
  browserCommand,
  startCallbackServer,
  handleCallbackRequest,
} from '../src/oauth.js';

test('PKCE: challenge is base64url(sha256(verifier)) for a known verifier (RFC 7636 vector)', () => {
  // Precomputed independently (RFC 7636 Appendix B) so this fails if the
  // base64url or sha256 encoding drifts, not just an echo of the code above it.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('genPkce: verifier is 43 chars of the unreserved charset, challenge matches it', () => {
  const { verifier, challenge } = genPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = base64url(crypto.createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
});

test('genState: 64 hex chars, different each call', () => {
  const a = genState();
  const b = genState();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('buildLoopbackUrl: has challenge, state, port, host and a valid integer port', () => {
  const url = buildLoopbackUrl('https://kenari.id', { challenge: 'c1', state: 's1', port: 54321, host: 'my host' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://kenari.id/cli-auth');
  assert.equal(u.searchParams.get('challenge'), 'c1');
  assert.equal(u.searchParams.get('state'), 's1');
  assert.equal(u.searchParams.get('host'), 'my host');
  const port = Number(u.searchParams.get('port'));
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(port, 54321);
});

// The login URL always carries `&` and `?`, both of which a Windows shell eats.
// Every platform cell must therefore pass the URL as one untouched argv entry
// and must not route it through a shell: `cmd /c start "" <url>` opened the URL
// cut at the first `&`, so /cli-auth saw only the challenge and answered
// "This login link is invalid" on every Windows run.
test('browserCommand: every platform passes the URL as one verbatim argv entry, never through a shell', () => {
  const url = buildLoopbackUrl('https://kenari.id', {
    challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    state: genState(),
    port: 54321,
    host: 'DESKTOP-A1B2C3',
  });
  assert.ok(url.includes('&') && url.includes('?'), 'premise: the login URL carries shell metacharacters');

  const shells = /^(cmd|cmd\.exe|command\.com|powershell|powershell\.exe|pwsh|sh|bash|zsh)$/i;
  const cells = [
    { platform: 'darwin', file: 'open' },
    { platform: 'win32', file: 'rundll32.exe' },
    { platform: 'linux', file: 'xdg-open' },
    { platform: 'freebsd', file: 'xdg-open' },
  ];
  for (const cell of cells) {
    const { file, args } = browserCommand(cell.platform, url);
    assert.equal(file, cell.file, `${cell.platform}: launcher`);
    assert.ok(!shells.test(file), `${cell.platform}: must not launch a shell`);
    assert.equal(args.filter((a) => a === url).length, 1, `${cell.platform}: URL passed verbatim, exactly once`);
    for (const arg of args) {
      if (arg === url) continue;
      assert.ok(!arg.includes(url), `${cell.platform}: URL must not be embedded in a larger argument`);
      assert.ok(!/[&"^%]/.test(arg), `${cell.platform}: no shell metacharacters in the other arguments`);
    }
  }
});

test('callback server: wrong state is rejected and keeps listening; right state resolves with the code', async () => {
  const state = genState();
  const { server, port, codePromise } = await startCallbackServer(state);
  try {
    const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=not-the-state`);
    assert.equal(wrong.status, 400);
    await wrong.text();

    // Server must still be listening after a bad callback: a second request
    // gets a real response instead of a connection error.
    const right = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${state}`);
    assert.equal(right.status, 200);
    const body = await right.text();
    assert.match(body, /signed in/);
    assert.ok(!body.includes('the-code'), 'the callback page must not reflect the code');

    const code = await codePromise;
    assert.equal(code, 'the-code');
  } finally {
    server.close();
  }
});

// A browser asks for /favicon.ico on the same keep-alive connection right after the
// callback page renders, and the caller closes the server as soon as the code lands,
// so that request can be served after the close. Reading the port off the server per
// request made this an uncaught TypeError that killed the login process:
// "Cannot read properties of null (reading 'port')" at the request handler.
// The second request is started before the close and finished after it, which keeps
// the socket out of the idle set on every Node version.
test('a request finishing after server.close() is answered, not fatal', async () => {
  const state = genState();
  const { server, port, codePromise } = await startCallbackServer(state);
  let uncaught;
  const onUncaught = (error) => { uncaught = error; };
  process.on('uncaughtException', onUncaught);
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (chunk) => { received += chunk.toString(); });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      `GET /callback?code=the-code&state=${state} HTTP/1.1\r\n`
      + `Host: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
    );
    assert.equal(await codePromise, 'the-code');

    socket.write('GET /favicon.ico HTTP/1.1\r\n');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    server.close();
    assert.equal(server.address(), null, 'the server must be closed for this to prove anything');
    socket.write(`Host: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    await new Promise((resolve) => { setTimeout(resolve, 250); });

    assert.equal(uncaught, undefined, `late request crashed the process: ${uncaught?.message}`);
    assert.match(received, /HTTP\/1\.1 200/);
    assert.match(received, /HTTP\/1\.1 404/);
  } finally {
    process.off('uncaughtException', onUncaught);
    socket.destroy();
    server.close();
  }
});

test('path/method guard: a POST to /callback and a GET to any other path both 404', async () => {
  const state = genState();
  const { server, port } = await startCallbackServer(state);
  try {
    const posted = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=${state}`, { method: 'POST' });
    assert.equal(posted.status, 404);
    await posted.text();

    const otherPath = await fetch(`http://127.0.0.1:${port}/not-callback?code=x&state=${state}`);
    assert.equal(otherPath.status, 404);
    await otherPath.text();
  } finally {
    server.close();
  }
});

test('handleCallbackRequest: a Host header not matching the bound port 404s (no fake req/res needs a real socket)', () => {
  let called = false;
  const fakeReq = { method: 'GET', url: '/callback?code=x&state=s1', headers: { host: 'evil.example:9999' } };
  const fakeRes = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b ?? ''; } };
  handleCallbackRequest(fakeReq, fakeRes, { expectedState: 's1', port: 12345, onCode: () => { called = true; } });
  assert.equal(fakeRes.statusCode, 404);
  assert.equal(called, false);
});
