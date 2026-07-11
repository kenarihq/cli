import { gatewayBase } from './paths.js';
import { KenariError } from './store.js';

export class AuthError extends KenariError {}

export async function fetchModels(key) {
  const base = gatewayBase();
  let res;
  try {
    res = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + key } });
  } catch (e) {
    throw new KenariError(`cannot reach ${base}: ${e.cause?.code || e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`kenari rejected the API key (HTTP ${res.status}). Run: kenari key set`);
  }
  if (!res.ok) throw new KenariError(`gateway error (HTTP ${res.status})`);
  const body = await res.json();
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
