import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLookupCache,
  lookupDomain,
  lookupDomains,
  normalizeDomainInput,
  parseRdapDomain,
} from '../public/rdap.js';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

function bootstrapFor(tld = 'test', endpoint = 'https://rdap.example.test/v1/') {
  return {
    version: '1.0',
    services: [[[tld], [endpoint]]],
  };
}

function domainResponse(domain, overrides = {}) {
  return {
    objectClassName: 'domain',
    ldhName: domain,
    status: ['active'],
    entities: [
      {
        roles: ['registrar'],
        vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]],
        publicIds: [{ type: 'IANA Registrar ID', identifier: '9999' }],
      },
    ],
    ...overrides,
  };
}

test.beforeEach(() => {
  clearLookupCache();
});

test('normalizeDomainInput extracts URLs and performs IDNA conversion', () => {
  assert.equal(
    normalizeDomainInput('  HTTPS://WWW.\u4f8b\u5b50.\u6d4b\u8bd5:443/a?q=1  '),
    'www.xn--fsqu00a.xn--0zwm56d',
  );
  assert.equal(normalizeDomainInput('//Example.COM./path'), 'example.com');
  assert.equal(normalizeDomainInput('sub.example.com/path'), 'sub.example.com');

  assert.throws(() => normalizeDomainInput(''), { code: 'INVALID_DOMAIN' });
  assert.throws(() => normalizeDomainInput('localhost'), { code: 'INVALID_DOMAIN' });
  assert.throws(() => normalizeDomainInput('127.0.0.1'), { code: 'INVALID_DOMAIN' });
  assert.throws(() => normalizeDomainInput('bad_label.example'), { code: 'INVALID_DOMAIN' });
});

test('parseRdapDomain parses a nested Google-style registrar entity and events', () => {
  const payload = {
    objectClassName: 'domain',
    ldhName: 'GOOGLE.COM',
    status: ['client delete prohibited', 'client transfer prohibited'],
    events: [
      { eventAction: 'registration', eventDate: '1997-09-15T04:00:00Z' },
      { eventAction: 'expiration', eventDate: '2028-09-14T04:00:00Z' },
      { eventAction: 'last changed', eventDate: '2024-08-02T17:33:37Z' },
    ],
    links: [
      { rel: 'related', href: 'https://example.invalid/' },
      { rel: 'self', href: 'https://rdap.verisign.com/com/v1/domain/GOOGLE.COM' },
    ],
    entities: [
      {
        roles: ['registrant'],
        entities: [
          {
            handle: '292',
            roles: ['registrar'],
            publicIds: [{ type: 'IANA Registrar ID', identifier: 292 }],
            vcardArray: [
              'vcard',
              [
                ['version', {}, 'text', '4.0'],
                ['fn', {}, 'text', 'MarkMonitor Inc.'],
              ],
            ],
          },
        ],
      },
    ],
  };

  const result = parseRdapDomain(payload, {
    input: 'google.com',
    queriedDomain: 'google.com',
    rdapServer: 'https://rdap.verisign.com/com/v1/',
  });

  assert.deepEqual(result, {
    input: 'google.com',
    queriedDomain: 'google.com',
    domain: 'google.com',
    registrarName: 'MarkMonitor Inc.',
    ianaId: '292',
    statuses: ['client delete prohibited', 'client transfer prohibited'],
    registeredAt: '1997-09-15T04:00:00Z',
    expiresAt: '2028-09-14T04:00:00Z',
    updatedAt: '2024-08-02T17:33:37Z',
    sourceUrl: 'https://rdap.verisign.com/com/v1/domain/GOOGLE.COM',
    rdapServer: 'https://rdap.verisign.com/com/v1/',
    cached: false,
    errorCode: null,
    error: null,
  });
});

test('parseRdapDomain supports ccTLD registrar data without an IANA ID', () => {
  const result = parseRdapDomain(
    {
      objectClassName: 'domain',
      unicodeName: '\u4f8b\u5b50.\u4e2d\u56fd',
      status: ['ok'],
      entities: [
        {
          roles: ['registrar'],
          vcardArray: ['vcard', [['fn', {}, 'text', '\u67d0域名注册服务商']]],
        },
      ],
    },
    {
      input: '\u4f8b\u5b50.\u4e2d\u56fd',
      queriedDomain: 'xn--fsqu00a.xn--fiqs8s',
      sourceUrl: 'https://rdap.example.cn/domain/xn--fsqu00a.xn--fiqs8s',
    },
  );

  assert.equal(result.registrarName, '某域名注册服务商');
  assert.equal(result.ianaId, null);
  assert.equal(result.domain, '例子.中国');
  assert.equal(result.rdapServer, 'https://rdap.example.cn');
});

test('lookupDomain selects the matching TLD service and prefers HTTPS', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url === BOOTSTRAP_URL) {
      return jsonResponse({
        services: [
          [['invalid'], ['https://not-used.invalid/']],
          [
            ['TEST.', 'other'],
            ['http://insecure.example.test/base/', 'https://secure.example.test/base/'],
          ],
        ],
      });
    }
    return jsonResponse(domainResponse('example.test'));
  };

  const result = await lookupDomain('example.test', { fetch });

  assert.equal(result.errorCode, null);
  assert.equal(result.rdapServer, 'https://secure.example.test/base/');
  assert.deepEqual(calls, [
    BOOTSTRAP_URL,
    'https://secure.example.test/base/domain/example.test',
  ]);
});

test('lookupDomain retries parent domains only after a subdomain 404', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url === BOOTSTRAP_URL) return jsonResponse(bootstrapFor());
    if (url.endsWith('/domain/shop.example.test')) return jsonResponse({}, 404);
    if (url.endsWith('/domain/example.test')) return jsonResponse(domainResponse('example.test'));
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await lookupDomain('https://shop.example.test/products', { fetch });

  assert.equal(result.queriedDomain, 'example.test');
  assert.equal(result.domain, 'example.test');
  assert.equal(result.errorCode, null);
  assert.deepEqual(calls.slice(1), [
    'https://rdap.example.test/v1/domain/shop.example.test',
    'https://rdap.example.test/v1/domain/example.test',
  ]);
});

test('lookupDomain caches successful results until the configured TTL', async () => {
  let now = 1_000;
  let calls = 0;
  const fetch = async (url) => {
    calls += 1;
    if (url === BOOTSTRAP_URL) return jsonResponse(bootstrapFor());
    return jsonResponse(domainResponse('cache.test'));
  };
  const options = { fetch, cacheTtlMs: 100, now: () => now };

  const first = await lookupDomain('cache.test', options);
  now = 1_050;
  const second = await lookupDomain('HTTPS://CACHE.TEST/path', options);
  now = 1_101;
  const third = await lookupDomain('cache.test', options);

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.input, 'HTTPS://CACHE.TEST/path');
  assert.equal(third.cached, false);
  assert.equal(calls, 3, 'one bootstrap request and two domain requests');
});

test('lookupDomains caps concurrency at three, preserves order, and isolates errors', async () => {
  let active = 0;
  let maximumActive = 0;
  const progress = [];
  const inputs = ['one.test', 'two.test', 'fail.test', 'three.test', 'four.test', 'five.test'];

  const fetch = async (url) => {
    if (url === BOOTSTRAP_URL) return jsonResponse(bootstrapFor());

    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const domain = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    try {
      await new Promise((resolve) => setTimeout(resolve, domain === 'one.test' ? 15 : 5));
      if (domain === 'fail.test') return jsonResponse({ title: 'failure' }, 503);
      return jsonResponse(domainResponse(domain));
    } finally {
      active -= 1;
    }
  };

  const results = await lookupDomains(inputs, {
    fetch,
    concurrency: 99,
    onProgress(update) {
      progress.push(update);
    },
  });

  assert.equal(maximumActive, 3);
  assert.deepEqual(
    results.map((result) => result.input),
    inputs,
  );
  assert.equal(results[2].errorCode, 'HTTP_ERROR');
  assert.match(results[2].error, /503/);
  assert.equal(results[0].domain, 'one.test');
  assert.equal(results[5].domain, 'five.test');
  assert.equal(progress.length, inputs.length);
  assert.deepEqual(
    progress.map((update) => update.completed).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(progress.every((update) => update.total === inputs.length));
});

test('lookupDomain returns a timeout error instead of rejecting', async () => {
  const result = await lookupDomain('slow.test', {
    bootstrap: bootstrapFor(),
    timeoutMs: 5,
    fetch: () => new Promise(() => {}),
  });

  assert.equal(result.errorCode, 'TIMEOUT');
  assert.equal(result.queriedDomain, 'slow.test');
  assert.match(result.error, /timed out/i);
});
