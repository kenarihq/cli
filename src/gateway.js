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
  return (body.data || []).map((m) => ({
    id: m.id,
    in: m.pricing?.prompt ?? null,
    out: m.pricing?.completion ?? null,
    context: m.context_length ?? null,
  }));
}

export function formatRp(microPer1M) {
  if (microPer1M === null || microPer1M === undefined) return '-';
  return 'Rp' + Math.round(microPer1M / 1e6).toLocaleString('id-ID');
}
