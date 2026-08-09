import { modelCachePath } from './paths.js';
import { fetchCatalog, validateGatewayUrl } from './gateway.js';
import { KenariError, readJson, writeFileAtomic, writePrivateJson } from './store.js';
import { codexKenariModels } from './runtime/codex.js';

export const CACHE_VERSION = 2;

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Null means the gateway published nothing, an array means it published a list. Every
// model leaving this module holds that invariant, including one read back from a file
// written before the field existed, so no consumer has to guard for undefined.
function normalizeOptions(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((v) => typeof v === 'string'))];
}

// The tri-state decision in one place. Every surface that renders capability branches on
// the same three cases, and confusing null with [] was the single most repeated defect in
// building this. The unknown label differs by surface, a narrow table column against a
// line of prose, so it is a parameter rather than a reason to keep three copies.
export function formatEffortOptions(options, unknownLabel) {
  if (options === null || options === undefined) return unknownLabel;
  return options.length ? options.join(', ') : 'unsupported';
}

// Largest whole unit, floored. Returns the bare unit so a caller can add "ago" or not.
export function formatAge(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
      reasoning_options: normalizeOptions(model.reasoning_options),
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
    model.reasoning_options = normalizeOptions(model.reasoning_options);
  }
  return value;
}

export function loadCatalogCache() {
  const value = readJson(modelCachePath());
  // Any other version is discarded, not fatal. A cache is regenerable, so blocking a
  // launch over one written by a different CLI build would trade a refresh for an outage.
  if (value === null || value?.version !== CACHE_VERSION) return null;
  return validateCatalogCache(value);
}

export function saveCatalogCache(cache) {
  const value = validateCatalogCache(cache);
  writePrivateJson(modelCachePath(), value);
  return value;
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
  if (options.refresh !== false && options.key) {
    try {
      const refreshed = await refreshCatalogCache(options.key, options);
      return { cache: refreshed, warning: null, refreshed: true };
    } catch (error) {
      if (cache) {
        return {
          cache,
          warning: `catalog refresh failed, using catalog from ${formatAge((options.now ?? Date.now()) - Date.parse(cache.fetched_at))} ago: ${error.message}`,
          refreshed: false,
        };
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
