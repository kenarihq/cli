import { modelCachePath } from './paths.js';
import { fetchCatalog, validateGatewayUrl } from './gateway.js';
import { KenariError, readJson, writeFileAtomic, writePrivateJson } from './store.js';
import { codexKenariModels } from './runtime/codex.js';

export const CACHE_VERSION = 1;
export const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function validateCatalogResponse(body, gateway) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
    throw new KenariError('Kenari catalog has an unsupported schema');
  }
  const seen = new Set();
  const models = body.data.map((model) => {
    if (!model || typeof model.id !== 'string' || !/^[^/\s]+$/.test(model.id) || seen.has(model.id)) {
      throw new KenariError('Kenari catalog contains an invalid or duplicate model ID');
    }
    seen.add(model.id);
    const pricing = model.pricing || {};
    const knownUnit = !pricing.unit || pricing.unit === 'micro_idr_per_1m_tokens';
    const free = pricing.free === true;
    return {
      id: model.id,
      input_price: free ? 0 : knownUnit ? numberOrNull(pricing.input) : null,
      output_price: free ? 0 : knownUnit ? numberOrNull(pricing.output) : null,
      context_limit: numberOrNull(model.context_length),
      output_limit: numberOrNull(model.output_limit ?? model.max_output_tokens),
      reasoning_efforts: Array.isArray(model.reasoning_efforts)
        ? model.reasoning_efforts.filter((v) => typeof v === 'string')
        : [],
      compatibility: model.compatibility && typeof model.compatibility === 'object'
        ? model.compatibility
        : {},
    };
  });
  return {
    version: CACHE_VERSION,
    fetched_at: new Date().toISOString(),
    gateway,
    models,
  };
}

export function validateCatalogCache(value) {
  if (!value || value.version !== CACHE_VERSION || typeof value.gateway !== 'string'
    || !Number.isFinite(Date.parse(value.fetched_at)) || !Array.isArray(value.models)) {
    throw new KenariError('model-cache.json has an unsupported schema');
  }
  const ids = new Set();
  for (const model of value.models) {
    if (!model || typeof model.id !== 'string' || !/^[^/\s]+$/.test(model.id) || ids.has(model.id)) {
      throw new KenariError('model-cache.json contains an invalid or duplicate model');
    }
    ids.add(model.id);
  }
  return value;
}

export function loadCatalogCache() {
  const value = readJson(modelCachePath());
  return value === null ? null : validateCatalogCache(value);
}

export function saveCatalogCache(cache) {
  const value = validateCatalogCache(cache);
  writePrivateJson(modelCachePath(), value);
  return value;
}

export function catalogIsFresh(cache, now = Date.now(), maxAgeMs = DEFAULT_CACHE_MAX_AGE_MS) {
  return !!cache && now - Date.parse(cache.fetched_at) <= maxAgeMs;
}

export async function refreshCatalogCache(key, options = {}) {
  const gateway = options.base || process.env.KENARI_BASE_URL || 'https://kenari.id';
  const body = await fetchCatalog(key, options);
  const cache = validateCatalogResponse(body, gateway.replace(/\/+$/, ''));
  saveCatalogCache(cache);
  return cache;
}

export async function loadCatalogForLaunch(options = {}) {
  const loaded = loadCatalogCache();
  const currentGateway = validateGatewayUrl(
    options.base || process.env.KENARI_BASE_URL || 'https://kenari.id',
  );
  const cache = loaded?.gateway === currentGateway ? loaded : null;
  if (catalogIsFresh(cache, options.now, options.maxAgeMs)) {
    return { cache, warning: null, refreshed: false };
  }
  if (options.refresh !== false && options.key) {
    try {
      const refreshed = await refreshCatalogCache(options.key, options);
      return { cache: refreshed, warning: null, refreshed: true };
    } catch (error) {
      if (cache) {
        return { cache, warning: `catalog refresh failed, using cached catalog: ${error.message}`, refreshed: false };
      }
      if (options.requireKenari) throw error;
      return { cache: null, warning: null, refreshed: false };
    }
  }
  if (options.requireKenari && !cache) {
    throw new KenariError('Kenari model catalog unavailable. Run: kenari configure');
  }
  return { cache, warning: null, refreshed: false };
}

export function writeMergedCodexCatalog(nativeModels, cache, file) {
  const native = Array.isArray(nativeModels) ? nativeModels : [];
  const kenari = codexKenariModels(cache, native);
  const merged = [...native, ...kenari];
  writeFileAtomic(file, JSON.stringify({ models: merged }, null, 2) + '\n');
  return merged;
}
