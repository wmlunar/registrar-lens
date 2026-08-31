/**
 * Browser-first RDAP client.
 *
 * This module deliberately has no runtime dependencies. Domain names are
 * converted to their ASCII (IDNA) form by the platform URL implementation.
 */

const DNS_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_BATCH_CONCURRENCY = 3;

const lookupCache = new Map();
const bootstrapCache = new Map();
const bootstrapRequests = new Map();

class RdapError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RdapError';
    this.code = code;
  }
}

/**
 * Extract and normalize a domain from a hostname or URL-like input.
 *
 * @param {unknown} input
 * @returns {string} lowercase ASCII (punycode) hostname
 * @throws {Error & {code: string}} when the input is not a DNS domain
 */
export function normalizeDomainInput(input) {
  if (typeof input !== 'string') {
    throw new RdapError('INVALID_DOMAIN', 'Domain input must be a string.');
  }

  const raw = input.trim();
  if (!raw) {
    throw new RdapError('INVALID_DOMAIN', 'Domain input is empty.');
  }

  let parsed;
  try {
    if (raw.startsWith('//')) {
      parsed = new URL(`https:${raw}`);
    } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
      parsed = new URL(raw);
    } else {
      parsed = new URL(`https://${raw}`);
    }
  } catch (cause) {
    throw new RdapError('INVALID_DOMAIN', 'The value is not a valid domain or URL.', { cause });
  }

  let hostname = parsed.hostname.toLowerCase();
  while (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }

  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes(':') ||
    /^\d+(?:\.\d+){3}$/.test(hostname) ||
    /^\d+(?:\.\d+)*$/.test(hostname)
  ) {
    throw new RdapError('INVALID_DOMAIN', 'The value must contain a DNS domain, not an IP address.');
  }

  const labels = hostname.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z\d-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-'),
    )
  ) {
    throw new RdapError('INVALID_DOMAIN', 'The value is not a valid DNS domain.');
  }

  return hostname;
}

function cloneResult(result, overrides = {}) {
  return {
    ...result,
    statuses: [...result.statuses],
    ...overrides,
  };
}

function emptyResult(input, overrides = {}) {
  return {
    input,
    queriedDomain: null,
    domain: null,
    registrarName: null,
    ianaId: null,
    statuses: [],
    registeredAt: null,
    expiresAt: null,
    updatedAt: null,
    sourceUrl: null,
    rdapServer: null,
    cached: false,
    errorCode: null,
    error: null,
    ...overrides,
  };
}

function rawInput(input) {
  return typeof input === 'string' ? input : String(input ?? '');
}

function errorResult(input, error, overrides = {}) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  const message = error instanceof Error ? error.message : String(error || 'Unknown RDAP error.');
  return emptyResult(rawInput(input), {
    ...overrides,
    errorCode: code,
    error: message,
  });
}

function findRegistrarEntity(entities, seen = new Set()) {
  if (!Array.isArray(entities)) return null;

  for (const entity of entities) {
    if (!entity || typeof entity !== 'object' || seen.has(entity)) continue;
    seen.add(entity);

    if (
      Array.isArray(entity.roles) &&
      entity.roles.some((role) => String(role).toLowerCase() === 'registrar')
    ) {
      return entity;
    }

    const nested = findRegistrarEntity(entity.entities, seen);
    if (nested) return nested;
  }

  return null;
}

function vcardValue(entity, propertyName) {
  const entries = entity?.vcardArray?.[1];
  if (!Array.isArray(entries)) return null;

  const item = entries.find(
    (entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === propertyName,
  );
  const value = item?.[3];
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function registrarIanaId(entity) {
  if (!Array.isArray(entity?.publicIds)) return null;
  const publicId = entity.publicIds.find((item) => {
    const type = String(item?.type ?? '');
    return /iana\s*registrar\s*id/i.test(type) || (/iana/i.test(type) && /registrar/i.test(type));
  });

  const identifier = publicId?.identifier;
  return identifier === undefined || identifier === null || identifier === ''
    ? null
    : String(identifier);
}

function eventDate(events, actions) {
  if (!Array.isArray(events)) return null;
  for (const action of actions) {
    const event = events.find(
      (item) => String(item?.eventAction ?? '').trim().toLowerCase() === action,
    );
    if (event?.eventDate) return String(event.eventDate);
  }
  return null;
}

function responseSourceUrl(data, fallback) {
  if (Array.isArray(data?.links)) {
    const selfLink = data.links.find(
      (link) => String(link?.rel ?? '').toLowerCase() === 'self' && link?.href,
    );
    if (selfLink) return String(selfLink.href);
  }
  return fallback || null;
}

function serverFromSource(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Convert a domain RDAP response into the stable result shape used by the UI.
 *
 * @param {object} data Domain RDAP JSON response
 * @param {object} [context]
 * @returns {object}
 */
export function parseRdapDomain(data, context = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RdapError('INVALID_RDAP_RESPONSE', 'The RDAP response is not a JSON object.');
  }

  const input = rawInput(context.input ?? context.queriedDomain ?? data.ldhName ?? data.unicodeName);
  const queriedValue = context.queriedDomain ?? data.ldhName ?? data.unicodeName;
  const queriedDomain = queriedValue == null ? null : String(queriedValue).toLowerCase();
  const registrar = findRegistrarEntity(data.entities);
  const sourceUrl = responseSourceUrl(data, context.sourceUrl);
  const domainValue = data.ldhName ?? data.unicodeName ?? queriedDomain;
  const statuses = Array.isArray(data.status)
    ? [...new Set(data.status.filter((status) => status != null).map(String))]
    : [];

  return emptyResult(input, {
    queriedDomain,
    domain: domainValue == null ? null : String(domainValue).toLowerCase(),
    registrarName: vcardValue(registrar, 'fn') ?? (registrar?.handle ? String(registrar.handle) : null),
    ianaId: registrarIanaId(registrar),
    statuses,
    registeredAt: eventDate(data.events, ['registration', 'registered']),
    expiresAt: eventDate(data.events, ['expiration', 'expiry', 'expires']),
    updatedAt: eventDate(data.events, [
      'last changed',
      'last modified',
      'last update',
      'last update of rdap database',
    ]),
    sourceUrl,
    rdapServer: context.rdapServer ? String(context.rdapServer) : serverFromSource(sourceUrl),
    cached: Boolean(context.cached),
  });
}

function optionNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function currentTime(options) {
  return typeof options.now === 'function' ? Number(options.now()) : Date.now();
}

async function fetchWithTimeout(url, fetchImpl, options) {
  const timeoutMs = Math.max(0, optionNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const requestOptions = {
    method: 'GET',
    headers: { Accept: 'application/rdap+json, application/json' },
    signal: controller.signal,
  };

  let timeoutId;
  let removeAbortListener = () => {};
  const racers = [
    Promise.resolve().then(() => fetchImpl(url, requestOptions)),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new RdapError('TIMEOUT', `RDAP request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
    }),
  ];

  if (options.signal) {
    racers.push(
      new Promise((_, reject) => {
        const abort = () => {
          controller.abort();
          reject(new RdapError('ABORTED', 'RDAP request was cancelled.'));
        };
        if (options.signal.aborted) {
          abort();
          return;
        }
        options.signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => options.signal.removeEventListener('abort', abort);
      }),
    );
  }

  try {
    return await Promise.race(racers);
  } catch (cause) {
    if (cause instanceof RdapError) throw cause;
    if (options.signal?.aborted) {
      throw new RdapError('ABORTED', 'RDAP request was cancelled.', { cause });
    }
    throw new RdapError('NETWORK_ERROR', `Could not reach ${url}.`, { cause });
  } finally {
    clearTimeout(timeoutId);
    removeAbortListener();
  }
}

function validateBootstrap(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.services)) {
    throw new RdapError('BOOTSTRAP_INVALID', 'IANA returned an invalid DNS RDAP bootstrap document.');
  }
  return data;
}

async function bootstrapDocument(options, fetchImpl) {
  if (options.bootstrap) return validateBootstrap(options.bootstrap);

  const bootstrapUrl = options.bootstrapUrl || DNS_BOOTSTRAP_URL;
  const ttlMs = Math.max(
    0,
    optionNumber(options.bootstrapCacheTtlMs, DEFAULT_BOOTSTRAP_TTL_MS),
  );
  const now = currentTime(options);
  const cached = bootstrapCache.get(bootstrapUrl);
  if (ttlMs > 0 && cached && cached.expiresAt > now) return cached.data;

  if (bootstrapRequests.has(bootstrapUrl)) return bootstrapRequests.get(bootstrapUrl);

  const request = (async () => {
    const response = await fetchWithTimeout(bootstrapUrl, fetchImpl, options);
    if (!response?.ok) {
      const status = response?.status ?? 'unknown';
      throw new RdapError(
        'BOOTSTRAP_HTTP_ERROR',
        `IANA DNS RDAP bootstrap request failed with HTTP ${status}.`,
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (cause) {
      throw new RdapError('BOOTSTRAP_INVALID', 'IANA returned malformed bootstrap JSON.', { cause });
    }
    validateBootstrap(data);
    if (ttlMs > 0) {
      bootstrapCache.set(bootstrapUrl, {
        data,
        expiresAt: currentTime(options) + ttlMs,
      });
    }
    return data;
  })();

  bootstrapRequests.set(bootstrapUrl, request);
  try {
    return await request;
  } finally {
    if (bootstrapRequests.get(bootstrapUrl) === request) bootstrapRequests.delete(bootstrapUrl);
  }
}

function rdapServerForTld(bootstrap, tld) {
  for (const service of bootstrap.services) {
    if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) {
      continue;
    }

    const coversTld = service[0].some(
      (suffix) => String(suffix).replace(/^\.+|\.+$/g, '').toLowerCase() === tld,
    );
    if (!coversTld) continue;

    const valid = service[1]
      .map((endpoint) => String(endpoint))
      .filter((endpoint) => /^https?:\/\//i.test(endpoint));
    return valid.find((endpoint) => endpoint.toLowerCase().startsWith('https://')) ?? valid[0] ?? null;
  }
  return null;
}

function domainQueryUrl(server, domain) {
  const base = server.endsWith('/') ? server : `${server}/`;
  try {
    return new URL(`domain/${encodeURIComponent(domain)}`, base).href;
  } catch (cause) {
    throw new RdapError('BOOTSTRAP_INVALID', `IANA supplied an invalid RDAP server URL: ${server}`, {
      cause,
    });
  }
}

function candidateDomains(domain) {
  const labels = domain.split('.');
  const candidates = [];
  while (labels.length >= 2) {
    candidates.push(labels.join('.'));
    labels.shift();
  }
  return candidates;
}

/**
 * Look up one domain. Expected lookup failures are returned in the result
 * object, making this safe to use in a batch without try/catch per item.
 *
 * Supported options include fetch, timeoutMs, signal, cacheTtlMs,
 * bootstrapCacheTtlMs, bootstrapUrl, and bootstrap (preloaded bootstrap JSON).
 *
 * @param {unknown} input
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function lookupDomain(input, options = {}) {
  const originalInput = rawInput(input);
  let normalized;
  try {
    normalized = normalizeDomainInput(input);
  } catch (error) {
    return errorResult(originalInput, error);
  }

  const ttlMs = Math.max(0, optionNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS));
  const bootstrapUrl = options.bootstrapUrl || DNS_BOOTSTRAP_URL;
  const cacheKey = `${bootstrapUrl}\n${normalized}`;
  const cached = lookupCache.get(cacheKey);
  if (ttlMs > 0 && cached && cached.expiresAt > currentTime(options)) {
    return cloneResult(cached.result, { input: originalInput, cached: true });
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return errorResult(
      originalInput,
      new RdapError('FETCH_UNAVAILABLE', 'This browser does not provide the Fetch API.'),
      { queriedDomain: normalized },
    );
  }

  let bootstrap;
  try {
    bootstrap = await bootstrapDocument(options, fetchImpl);
  } catch (error) {
    return errorResult(originalInput, error, { queriedDomain: normalized });
  }

  const tld = normalized.split('.').at(-1);
  const server = rdapServerForTld(bootstrap, tld);
  if (!server) {
    return errorResult(
      originalInput,
      new RdapError('NO_RDAP_SERVER', `IANA lists no domain RDAP server for .${tld}.`),
      { queriedDomain: normalized },
    );
  }

  let lastUrl = null;
  let lastCandidate = normalized;
  try {
    for (const candidate of candidateDomains(normalized)) {
      lastCandidate = candidate;
      lastUrl = domainQueryUrl(server, candidate);
      const response = await fetchWithTimeout(lastUrl, fetchImpl, options);

      if (response?.status === 404) continue;
      if (!response?.ok) {
        const status = response?.status ?? 'unknown';
        throw new RdapError('HTTP_ERROR', `The RDAP server returned HTTP ${status}.`);
      }

      let data;
      try {
        data = await response.json();
      } catch (cause) {
        throw new RdapError('INVALID_RDAP_RESPONSE', 'The RDAP server returned malformed JSON.', {
          cause,
        });
      }

      const result = parseRdapDomain(data, {
        input: originalInput,
        queriedDomain: candidate,
        sourceUrl: lastUrl,
        rdapServer: server,
      });
      if (ttlMs > 0) {
        lookupCache.set(cacheKey, {
          result: cloneResult(result),
          expiresAt: currentTime(options) + ttlMs,
        });
      }
      return result;
    }

    throw new RdapError('NOT_FOUND', `No RDAP domain record was found for ${normalized}.`);
  } catch (error) {
    return errorResult(originalInput, error, {
      queriedDomain: lastCandidate,
      sourceUrl: lastUrl,
      rdapServer: server,
    });
  }
}

function inputsArray(inputs) {
  if (typeof inputs === 'string') {
    return inputs
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (inputs && typeof inputs[Symbol.iterator] === 'function') return [...inputs];
  return [inputs];
}

/**
 * Look up domains with a hard maximum of three simultaneous jobs.
 * Results remain in input order. onProgress receives
 * { completed, total, result, index }.
 *
 * @param {Iterable<unknown>|string} inputs
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
export async function lookupDomains(inputs, options = {}) {
  const values = inputsArray(inputs);
  const results = new Array(values.length);
  const requested = Math.floor(optionNumber(options.concurrency, MAX_BATCH_CONCURRENCY));
  const concurrency = Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, requested || 1, values.length || 1));
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await lookupDomain(values[index], options);
      results[index] = result;
      completed += 1;
      if (typeof options.onProgress === 'function') {
        options.onProgress({ completed, total: values.length, result, index });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/** Clear cached lookup results and the cached IANA bootstrap document. */
export function clearLookupCache() {
  lookupCache.clear();
  bootstrapCache.clear();
  bootstrapRequests.clear();
}
