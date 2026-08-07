import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  base64url,
  genPkce,
  genState,
  buildLoopbackUrl,
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
