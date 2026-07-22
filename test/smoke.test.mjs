import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_URLS,
  analyzeMeter,
  billingPeriod,
  computeQuota,
  parseRetryAfterSeconds,
  requestAnalytics,
  serveQuota,
  validateConfig,
} from "../src/index.js";

const validEnv = {
  CF_ANALYTICS_TOKEN: "x",
  CF_ACCOUNT_TAG: "a",
  WARN_THRESHOLD_PCT: "80",
  LIMIT_WORKERS_REQUESTS_MONTH: "10000000",
  LIMIT_KV_READS_MONTH: "10000000",
  LIMIT_KV_WRITES_MONTH: "1000000",
  LIMIT_KV_DELETES_MONTH: "1000000",
  LIMIT_KV_LISTS_MONTH: "1000000",
  LIMIT_KV_STORAGE_BYTES: "1073741824",
};

function rateLimitResponse() {
  return new Response(
    JSON.stringify({
      errors: [
        { message: "rate limiter budget depleted, try again after 5 minutes" },
      ],
    }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

function createCache(initial = new Map()) {
  const store = new Map(initial);
  return {
    async match(request) {
      const response = store.get(request.url);
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      const body = await response.text();
      store.set(
        request.url,
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      );
    },
    async delete(request) {
      return store.delete(request.url);
    },
    store,
  };
}

test("period starts on the anchor day of the current month once passed", () => {
  const now = new Date(Date.UTC(2026, 6, 13));
  const period = billingPeriod(now, "2");
  assert.equal(period.start.toISOString().slice(0, 10), "2026-07-02");
  assert.equal(period.end.toISOString().slice(0, 10), "2026-08-02");
});

test("period reaches back a month when the anchor is still ahead", () => {
  const now = new Date(Date.UTC(2026, 6, 1));
  const period = billingPeriod(now, "2");
  assert.equal(period.start.toISOString().slice(0, 10), "2026-06-02");
  assert.equal(period.end.toISOString().slice(0, 10), "2026-07-02");
});

test("anchor clamps to 28 so every month has the day", () => {
  const now = new Date(Date.UTC(2026, 1, 15));
  const period = billingPeriod(now, "31");
  assert.equal(period.start.toISOString().slice(0, 10), "2026-01-28");
  assert.equal(period.end.toISOString().slice(0, 10), "2026-02-28");
});

test("a nonsense anchor falls back to the 1st", () => {
  const now = new Date(Date.UTC(2026, 6, 13));
  const period = billingPeriod(now, "not-a-number");
  assert.equal(period.start.toISOString().slice(0, 10), "2026-07-01");
});

test("a counter meter breaches on projection even below the threshold", () => {
  const meter = {
    id: "workers_requests",
    label: "x",
    usage: 3000000,
    limit: 10000000,
  };
  const result = analyzeMeter(meter, 2, 30, 0.8);
  assert.equal(result.breach, true);
  assert.ok(result.projected_end_of_period > meter.limit);
});

test("a gauge meter never breaches on projection, only on threshold", () => {
  const gauge = {
    id: "kv_storage",
    label: "x",
    usage: 600 * 1024 * 1024,
    limit: 1024 * 1024 * 1024,
    point_in_time: true,
  };
  const early = analyzeMeter(gauge, 2, 30, 0.8);
  assert.equal(early.breach, false);
  assert.equal(early.level, "healthy");
  assert.equal(early.projected_end_of_period, null);
  const full = analyzeMeter(
    { ...gauge, usage: 900 * 1024 * 1024 },
    2,
    30,
    0.8,
  );
  assert.equal(full.breach, true);
});

test("a healthy cumulative meter is not labelled as a warning", () => {
  const meter = {
    id: "workers_requests",
    label: "x",
    usage: 100000,
    limit: 10000000,
  };
  const result = analyzeMeter(meter, 20, 30, 0.8);
  assert.equal(result.breach, false);
  assert.equal(result.level, "healthy");
});

test("configuration rejects missing secrets and invalid limits", () => {
  assert.throws(() => validateConfig({}), /CF_ANALYTICS_TOKEN/);
  assert.equal(validateConfig(validEnv).threshold, 0.8);
  assert.throws(
    () => validateConfig({ ...validEnv, LIMIT_KV_READS_MONTH: "0" }),
    /LIMIT_KV_READS_MONTH/,
  );
});

test("retry-after parsing is bounded and defaults to five minutes", () => {
  assert.equal(parseRetryAfterSeconds(null), 300);
  assert.equal(parseRetryAfterSeconds("120"), 120);
  assert.equal(parseRetryAfterSeconds("99999"), 3600);
});

test("analytics 429 errors preserve the dataset and bounded reason", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => rateLimitResponse();
  try {
    await assert.rejects(
      requestAnalytics(validEnv, "workers_analytics", "query Test { viewer }", {}),
      (error) => {
        assert.equal(error.name, "AnalyticsApiError");
        assert.equal(error.status, 429);
        assert.equal(error.source, "workers_analytics");
        assert.equal(error.retryAfterSeconds, 300);
        assert.match(error.message, /rate limiter budget depleted/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quota computation stops fan-out after the first rate limit", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return rateLimitResponse();
  };
  try {
    await assert.rejects(computeQuota(validEnv), /workers_analytics/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a rate-limited refresh serves the last successful snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return rateLimitResponse();
  };

  const cachedSnapshot = {
    ok: true,
    generated_at: "2026-07-22T12:09:03.963Z",
    meters: [],
  };
  const cache = createCache(
    new Map([
      [
        CACHE_URLS.stale,
        new Response(JSON.stringify(cachedSnapshot), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=86400",
          },
        }),
      ],
    ]),
  );
  globalThis.caches = { default: cache };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  try {
    const response = await serveQuota(
      new Request("https://api.atlas-systems.uk/quota"),
      validEnv,
      ctx,
    );
    await Promise.all(pending);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-atlas-cache"), "stale");
    assert.equal(body.ok, true);
    assert.equal(body.degraded, true);
    assert.equal(body.freshness, "stale");
    assert.equal(body.stale_reason, "analytics_rate_limited");
    assert.equal(body.retry_after_seconds, 300);
    assert.equal(calls, 1);
    assert.ok(cache.store.has(CACHE_URLS.cooldown));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  }
});

test("an active cooldown prevents another GraphQL request", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return rateLimitResponse();
  };
  const cache = createCache(
    new Map([
      [
        CACHE_URLS.cooldown,
        new Response(JSON.stringify({ retry_after_seconds: 300 }), {
          headers: { "cache-control": "public, max-age=300" },
        }),
      ],
    ]),
  );
  globalThis.caches = { default: cache };

  try {
    const response = await serveQuota(
      new Request("https://api.atlas-systems.uk/quota"),
      validEnv,
      null,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "300");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  }
});
