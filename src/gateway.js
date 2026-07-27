import { gatewayBase } from './paths.js';
import { KenariError } from './store.js';

export class AuthError extends KenariError {}

export function validateGatewayUrl(value = gatewayBase()) {
  let url;
  try { url = new URL(value); }
  catch { throw new KenariError(`invalid Kenari gateway URL: ${value}`); }
  const allowHttp = process.env.KENARI_ALLOW_HTTP === '1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp)) {
    throw new KenariError('Kenari gateway must use HTTPS. Set KENARI_ALLOW_HTTP=1 only for local development.');
  }
  if (url.username || url.password) {
    throw new KenariError('Kenari gateway URL must not contain credentials.');
  }
  return url.toString().replace(/\/+$/, '');
}

export async function fetchCatalog(key, options = {}) {
  if (!key) throw new AuthError('Kenari login required. Run: kenari login');
  const base = validateGatewayUrl(options.base || gatewayBase());
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let res;
  try {
    res = await fetch(base + '/v1/models', {
      headers: { authorization: 'Bearer ' + key },
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new KenariError(`catalog request to ${base} timed out`);
    throw new KenariError(`cannot reach ${base}: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Kenari rejected the credential (HTTP ${res.status}). Run: kenari login`);
  }
  if (!res.ok) throw new KenariError(`Kenari catalog error (HTTP ${res.status})`);
  try { return await res.json(); }
  catch { throw new KenariError('Kenari catalog response is not valid JSON'); }
}

export async function fetchModels(key) {
  const body = await fetchCatalog(key);
  return (body.data || []).map((m) => {
    // Only trust prices in the gateway's documented unit. An unknown unit
    // (or a future one) must not be printed as rupiah, so treat in/out as null.
    const knownUnit = !m.pricing?.unit || m.pricing.unit === 'micro_idr_per_1m_tokens';
    // pricing.free means a no-charge route: the numbers are the reference rate
    // card, but the customer is billed Rp0, so that is what we list.
    const free = m.pricing?.free === true;
    return {
      id: m.id,
      in: free ? 0 : knownUnit ? (m.pricing?.input ?? null) : null,
      out: free ? 0 : knownUnit ? (m.pricing?.output ?? null) : null,
      context: m.context_length ?? null,
    };
  });
}

export function formatRp(microPer1M) {
  if (microPer1M === null || microPer1M === undefined) return '-';
  return 'Rp' + Math.round(microPer1M / 1e6).toLocaleString('id-ID');
}
