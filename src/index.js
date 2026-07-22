/**
 * atlas-quota-watch: daily usage-ceiling watchdog for the estate.
 *
 * Reads the account's own usage from the Cloudflare GraphQL Analytics
 * API (Workers requests, KV operations, KV storage), compares each
 * meter against the plan's included monthly allotment, and raises one
 * consolidated alert through the ATLAS_NOTIFY envelope when a meter is
 * past the warning threshold or projected to cross its ceiling before
 * the billing period ends. Healthy checks are silent by design; the
 * live snapshot is always readable at GET /quota.
 *
 * Read-only by construction: no KV bindings and no DRY_RUN valve,
 * because there is nothing a dry run would gate. The only side effect
 * this Worker ever produces is a Discord embed via atlas-notify.
 *
 * Route layering: /quota* on the shared api hostname is more specific
 * than atlas-notify's /* wildcard, so this Worker owns the path
 * without unwiring anything (same precedent as /sonify and /v1).
 */

import { handleMeta } from "./_meta.js";
import { notify } from "./notify.js";

export const META = {
  name: "atlas-quota-watch",
  description:
    "Daily watchdog comparing account usage (Workers requests, KV operations, KV storage) against plan allotments",
  version: "1.0.0",
  endpoints: [
    {
      method: "GET",
      path: "/quota",
      description: "Live usage snapshot with burn rate and projection per meter",
    },
    {
      method: "GET",
      path: "/quota/_meta",
      description: "This contract",
    },
  ],
  source: "https://github.com/AtlasReaper311/atlas-quota-watch",
};

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_CACHE_TTL_SECONDS = 300;
const FRESH_CACHE_TTL_SECONDS = 60 * 60;
const STALE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_COOLDOWN_SECONDS = 5 * 60;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;

export const CACHE_URLS = Object.freeze({
  fresh: "https://atlas-quota-watch.internal/quota",
  stale: "https://atlas-quota-watch.internal/quota/stale",
  cooldown: "https://atlas-quota-watch.internal/quota/rate-limit",
});

export class AnalyticsApiError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AnalyticsApiError";
    this.status = options.status ?? null;
    this.source = options.source ?? "unknown";
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function positiveNumber(env, name) {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`configuration ${name} must be a positive number`);
  }
  return value;
}

export function validateConfig(env) {
  if (!env.CF_ANALYTICS_TOKEN) {
    throw new Error("configuration CF_ANALYTICS_TOKEN is required");
  }
  if (!env.CF_ACCOUNT_TAG) {
    throw new Error("configuration CF_ACCOUNT_TAG is required");
  }
  const threshold = Number(env.WARN_THRESHOLD_PCT ?? "80");
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 100) {
    throw new Error("configuration WARN_THRESHOLD_PCT must be between 0 and 100");
  }
  return {
    threshold: threshold / 100,
    limits: {
      workersRequests: positiveNumber(env, "LIMIT_WORKERS_REQUESTS_MONTH"),
      kvReads: positiveNumber(env, "LIMIT_KV_READS_MONTH"),
      kvWrites: positiveNumber(env, "LIMIT_KV_WRITES_MONTH"),
      kvDeletes: positiveNumber(env, "LIMIT_KV_DELETES_MONTH"),
      kvLists: positiveNumber(env, "LIMIT_KV_LISTS_MONTH"),
      kvStorageBytes: positiveNumber(env, "LIMIT_KV_STORAGE_BYTES"),
    },
  };
}

/**
 * The current billing period, anchored to the day of month the plan
 * renews on. The anchor is clamped to 1..28 so the same day exists in
 * every month and no end-of-month arithmetic is needed.
 */
export function billingPeriod(now, anchorDayRaw) {
  const anchor = Math.min(Math.max(Number(anchorDayRaw) || 1, 1), 28);
  let start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), anchor),
  );
  if (start.getTime() > now.getTime()) {
    start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, anchor),
    );
  }
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, anchor),
  );
  return { start, end };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function safeErrorMessage(error) {
  return String(error?.message || "unknown analytics failure")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export function parseRetryAfterSeconds(value, fallback = RATE_LIMIT_COOLDOWN_SECONDS) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
}

function isRateLimitMessage(message) {
  return /rate limit|rate limiter|too many queries|excessive resources/i.test(message);
}

async function responseErrorDetail(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  if (!text) return "";

  try {
    const doc = JSON.parse(text);
    const messages = Array.isArray(doc?.errors)
      ? doc.errors
          .map((entry) => String(entry?.message || "").trim())
          .filter(Boolean)
      : [];
    if (messages.length > 0) return messages.join("; ").slice(0, 300);
  } catch {
    // Fall back to a bounded plain-text description below.
  }

  return text.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * One POST to the GraphQL endpoint. Errors carry a bounded diagnostic,
 * dataset identity, status, and cooldown hint without exposing secrets.
 */
export async function requestAnalytics(env, source, query, variables) {
  let response;
  try {
    response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new AnalyticsApiError(
      `${source}: analytics request failed: ${safeErrorMessage(error)}`,
      { source, cause: error },
    );
  }

  if (!response.ok) {
    const detail = await responseErrorDetail(response);
    const suffix = detail ? `: ${detail}` : "";
    throw new AnalyticsApiError(
      `${source}: analytics API returned http ${response.status}${suffix}`,
      {
        status: response.status,
        source,
        retryAfterSeconds:
          response.status === 429
            ? parseRetryAfterSeconds(response.headers.get("retry-after"))
            : null,
      },
    );
  }

  const doc = await response.json();
  if (doc.errors && doc.errors.length) {
    const detail = doc.errors
      .map((entry) => entry.message)
      .join("; ")
      .slice(0, 300);
    const rateLimited = isRateLimitMessage(detail);
    throw new AnalyticsApiError(
      `${source}: analytics query failed: ${detail}`,
      {
        status: rateLimited ? 429 : 502,
        source,
        retryAfterSeconds: rateLimited ? RATE_LIMIT_COOLDOWN_SECONDS : null,
      },
    );
  }

  const account = doc?.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new AnalyticsApiError(
      `${source}: analytics query returned no account node`,
      { status: 502, source },
    );
  }
  return account;
}

const WORKERS_QUERY = `
query WorkersUsage($accountTag: string!, $start: string!, $end: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests errors }
        dimensions { scriptName }
      }
    }
  }
}`;

const KV_OPS_QUERY = `
query KvOps($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

const KV_STORAGE_QUERY = `
query KvStorage($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvStorageAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
      ) {
        max { byteCount keyCount }
        dimensions { namespaceId date }
      }
    }
  }
}`;

async function fetchWorkersUsage(env, period, now) {
  const account = await requestAnalytics(env, "workers_analytics", WORKERS_QUERY, {
    accountTag: env.CF_ACCOUNT_TAG,
    start: period.start.toISOString(),
    end: now.toISOString(),
  });
  const groups = account.workersInvocationsAdaptive ?? [];
  let requests = 0;
  let errors = 0;
  const perScript = [];
  for (const group of groups) {
    requests += group.sum?.requests ?? 0;
    errors += group.sum?.errors ?? 0;
    perScript.push({
      script: group.dimensions?.scriptName ?? "unknown",
      requests: group.sum?.requests ?? 0,
    });
  }
  perScript.sort((a, b) => b.requests - a.requests);
  return { requests, errors, topScripts: perScript.slice(0, 5) };
}

async function fetchKvOps(env, period, now) {
  const account = await requestAnalytics(env, "kv_operations", KV_OPS_QUERY, {
    accountTag: env.CF_ACCOUNT_TAG,
    start: isoDate(period.start),
    end: isoDate(now),
  });
  const groups = account.kvOperationsAdaptiveGroups ?? [];
  const ops = { read: 0, write: 0, delete: 0, list: 0 };
  for (const group of groups) {
    const action = group.dimensions?.actionType;
    if (action in ops) ops[action] += group.sum?.requests ?? 0;
  }
  return ops;
}

/**
 * Account-wide storage is the sum, per namespace, of the most recent
 * daily reading. The dataset reports per-namespace maxima per day, so
 * summing the latest day for each namespace is the honest total; a
 * naive account-level max would report only the largest namespace.
 */
async function fetchKvStorage(env, now) {
  const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);
  const account = await requestAnalytics(env, "kv_storage", KV_STORAGE_QUERY, {
    accountTag: env.CF_ACCOUNT_TAG,
    start: isoDate(twoDaysAgo),
    end: isoDate(now),
  });
  const groups = account.kvStorageAdaptiveGroups ?? [];
  const latest = new Map();
  for (const group of groups) {
    const namespace = group.dimensions?.namespaceId ?? "unknown";
    const date = group.dimensions?.date ?? "";
    const previous = latest.get(namespace);
    if (!previous || date > previous.date) {
      latest.set(namespace, {
        date,
        bytes: group.max?.byteCount ?? 0,
        keys: group.max?.keyCount ?? 0,
      });
    }
  }
  let bytes = 0;
  let keys = 0;
  for (const entry of latest.values()) {
    bytes += entry.bytes;
    keys += entry.keys;
  }
  return { bytes, keys, namespaces: latest.size };
}

/**
 * Two independent breach conditions, both needed:
 *   1. usage already at or past the warning threshold (default 80%);
 *      catches late-period creep with one full weekly check interval
 *      of headroom before the ceiling.
 *   2. projected end-of-period usage past 100% at the current daily
 *      burn rate; catches early-period spikes that would blow the
 *      ceiling long before condition 1 ever fires.
 *
 * Condition 2 only applies to cumulative counters. KV storage is a
 * point-in-time gauge; dividing its current level by elapsed days is
 * not a burn rate, and projecting it forward would make a perfectly
 * static store read as a runaway. Gauges get condition 1 only.
 */
export function analyzeMeter(meter, elapsedDays, totalDays, warnPct) {
  const pct = meter.limit > 0 ? meter.usage / meter.limit : 0;
  if (meter.point_in_time) {
    const breach = pct >= warnPct;
    return {
      ...meter,
      pct: Math.round(pct * 1000) / 10,
      burn_per_day: null,
      projected_end_of_period: null,
      days_to_limit: null,
      breach,
      level: breach ? (pct >= 0.95 ? "failure" : "warning") : "healthy",
    };
  }
  const burnPerDay = meter.usage / Math.max(elapsedDays, 0.5);
  const projected = burnPerDay * totalDays;
  const remaining = Math.max(meter.limit - meter.usage, 0);
  const daysToLimit = burnPerDay > 0 ? remaining / burnPerDay : null;
  const breach = pct >= warnPct || projected > meter.limit;
  return {
    ...meter,
    pct: Math.round(pct * 1000) / 10,
    burn_per_day: Math.round(burnPerDay),
    projected_end_of_period: Math.round(projected),
    days_to_limit: daysToLimit === null ? null : Math.round(daysToLimit * 10) / 10,
    breach,
    level: breach ? (pct >= 0.95 ? "failure" : "warning") : "healthy",
  };
}

export async function computeQuota(env) {
  const config = validateConfig(env);
  const now = new Date();
  const period = billingPeriod(now, env.BILLING_ANCHOR_DAY);
  const elapsedDays = (now.getTime() - period.start.getTime()) / DAY_MS;
  const totalDays = (period.end.getTime() - period.start.getTime()) / DAY_MS;
  const daysLeft = Math.max(totalDays - elapsedDays, 0);

  // Run sequentially. A rate-limit response stops the remaining calls instead
  // of allowing two more GraphQL requests to continue inside Promise.all().
  const workers = await fetchWorkersUsage(env, period, now);
  const kvOps = await fetchKvOps(env, period, now);
  const kvStorage = await fetchKvStorage(env, now);

  const warnPct = config.threshold;
  const rawMeters = [
    {
      id: "workers_requests",
      label: "Workers requests / month",
      usage: workers.requests,
      limit: config.limits.workersRequests,
    },
    {
      id: "kv_reads",
      label: "KV reads / month",
      usage: kvOps.read,
      limit: config.limits.kvReads,
    },
    {
      id: "kv_writes",
      label: "KV writes / month",
      usage: kvOps.write,
      limit: config.limits.kvWrites,
    },
    {
      id: "kv_deletes",
      label: "KV deletes / month",
      usage: kvOps.delete,
      limit: config.limits.kvDeletes,
    },
    {
      id: "kv_lists",
      label: "KV lists / month",
      usage: kvOps.list,
      limit: config.limits.kvLists,
    },
    {
      id: "kv_storage",
      label: "KV storage bytes",
      usage: kvStorage.bytes,
      limit: config.limits.kvStorageBytes,
      point_in_time: true,
    },
  ];

  const meters = rawMeters.map((meter) =>
    analyzeMeter(meter, elapsedDays, totalDays, warnPct),
  );

  return {
    ok: true,
    generated_at: now.toISOString(),
    plan_note:
      "limits are the Workers Paid plan included monthly allotments, set in wrangler.toml vars",
    warn_threshold_pct: warnPct * 100,
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      elapsed_days: Math.round(elapsedDays * 10) / 10,
      total_days: Math.round(totalDays),
      days_left: Math.round(daysLeft * 10) / 10,
    },
    meters,
    workers_errors_this_period: workers.errors,
    top_workers_by_requests: workers.topScripts,
    kv_namespaces_counted: kvStorage.namespaces,
  };
}

function formatCount(n) {
  if (n >= 1000000) return `${Math.round((n / 1000000) * 10) / 10}M`;
  if (n >= 1000) return `${Math.round((n / 1000) * 10) / 10}k`;
  return String(n);
}

function failureFields(error) {
  const fields = {
    error_type: error?.name || "Error",
    error_message: safeErrorMessage(error),
  };
  if (error?.source) fields.source = error.source;
  if (Number.isInteger(error?.status)) fields.http_status = String(error.status);
  if (Number.isFinite(error?.retryAfterSeconds)) {
    fields.retry_after_seconds = String(error.retryAfterSeconds);
  }
  return fields;
}

async function runCheck(env) {
  let snapshot;
  try {
    snapshot = await computeQuota(env);
  } catch (error) {
    const rateLimited = error?.status === 429;
    console.error("quota check failed", failureFields(error));
    await notify(env, {
      level: rateLimited ? "warning" : "failure",
      title: rateLimited
        ? "Quota watch analytics rate limited"
        : "Quota watch could not read account analytics",
      message: rateLimited
        ? "Cloudflare rejected the analytics query budget. The next scheduled check will retry; no quota breach was inferred from the failed read."
        : "The usage check failed before producing any numbers. The watchdog is blind until the analytics read succeeds.",
      fields: failureFields(error),
    });
    return;
  }

  const breaches = snapshot.meters.filter((meter) => meter.breach);
  if (breaches.length === 0) {
    console.log(
      "quota check: all meters healthy,",
      snapshot.period.days_left,
      "days left in period",
    );
    return;
  }

  const worst = breaches.some((meter) => meter.level === "failure")
    ? "failure"
    : "warning";
  const lines = breaches.map((meter) => {
    const eta = meter.point_in_time
      ? "point-in-time gauge, threshold breach"
      : meter.days_to_limit === null
        ? "no burn recorded, static usage"
        : `~${meter.days_to_limit}d to ceiling at current burn`;
    return `${meter.label}: ${formatCount(meter.usage)} of ${formatCount(meter.limit)} (${meter.pct}%), ${eta}`;
  });
  const fields = {
    period_days_left: `${snapshot.period.days_left}`,
    period_ends: snapshot.period.end.slice(0, 10),
    snapshot: "https://api.atlas-systems.uk/quota",
  };
  for (const meter of breaches.slice(0, 4)) {
    fields[meter.id] = meter.point_in_time
      ? `${meter.pct}% of ceiling in use now`
      : `${meter.pct}% used, projected ${formatCount(meter.projected_end_of_period)} by period end`;
  }

  await notify(env, {
    level: worst,
    title: `Quota watch: ${breaches.length} meter${breaches.length === 1 ? "" : "s"} approaching a ceiling`,
    message: lines.join("\n"),
    fields,
  });
}

function cacheKey(url) {
  return new Request(url);
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function responseWithHeaders(response, extraHeaders) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cacheSnapshotResponse(body, ttlSeconds) {
  return jsonResponse(body, 200, {
    "cache-control": `public, max-age=${ttlSeconds}`,
  });
}

function schedule(ctx, promise) {
  if (ctx) {
    ctx.waitUntil(promise);
    return;
  }
  return promise;
}

async function staleSnapshotResponse(cache, reason, retryAfterSeconds = null) {
  if (!cache) return null;
  const stale = await cache.match(cacheKey(CACHE_URLS.stale));
  if (!stale) return null;

  let body;
  try {
    body = await stale.json();
  } catch {
    return null;
  }

  const degraded = {
    ...body,
    degraded: true,
    freshness: "stale",
    stale_reason: reason,
    served_at: new Date().toISOString(),
  };
  if (Number.isFinite(retryAfterSeconds)) {
    degraded.retry_after_seconds = retryAfterSeconds;
  }

  return jsonResponse(degraded, 200, {
    "cache-control": "no-store",
    "x-atlas-cache": "stale",
    warning: '110 - "Response is stale"',
  });
}

function unavailableResponse(error, status = 502) {
  const retryAfterSeconds = Number.isFinite(error?.retryAfterSeconds)
    ? error.retryAfterSeconds
    : null;
  const headers = {
    "cache-control": "no-store",
    "x-atlas-cache": "unavailable",
  };
  if (retryAfterSeconds !== null) {
    headers["retry-after"] = String(retryAfterSeconds);
  }
  return jsonResponse(
    {
      ok: false,
      error: error?.name || "Error",
      degraded: true,
      retry_after_seconds: retryAfterSeconds,
    },
    status,
    headers,
  );
}

export async function serveQuota(_request, env, ctx) {
  const cache = globalThis.caches?.default ?? null;
  const freshKey = cacheKey(CACHE_URLS.fresh);
  const staleKey = cacheKey(CACHE_URLS.stale);
  const cooldownKey = cacheKey(CACHE_URLS.cooldown);

  if (cache) {
    const fresh = await cache.match(freshKey);
    if (fresh) {
      const staleSeed = fresh.clone();
      const staleHeaders = new Headers(staleSeed.headers);
      staleHeaders.set(
        "cache-control",
        `public, max-age=${STALE_CACHE_TTL_SECONDS}`,
      );
      schedule(
        ctx,
        cache.put(
          staleKey,
          new Response(staleSeed.body, {
            status: staleSeed.status,
            statusText: staleSeed.statusText,
            headers: staleHeaders,
          }),
        ),
      );
      return responseWithHeaders(fresh, {
        "cache-control": `public, max-age=${CLIENT_CACHE_TTL_SECONDS}`,
        "x-atlas-cache": "fresh",
      });
    }

    const cooldown = await cache.match(cooldownKey);
    if (cooldown) {
      let retryAfterSeconds = RATE_LIMIT_COOLDOWN_SECONDS;
      try {
        const marker = await cooldown.json();
        retryAfterSeconds = parseRetryAfterSeconds(
          marker?.retry_after_seconds,
          RATE_LIMIT_COOLDOWN_SECONDS,
        );
      } catch {
        // Use the fixed GraphQL cooldown when the marker is unreadable.
      }
      const stale = await staleSnapshotResponse(
        cache,
        "analytics_rate_limited",
        retryAfterSeconds,
      );
      if (stale) return stale;
      return unavailableResponse(
        new AnalyticsApiError("analytics rate-limit cooldown active", {
          status: 429,
          source: "cache_cooldown",
          retryAfterSeconds,
        }),
        503,
      );
    }
  }

  let body;
  try {
    body = await computeQuota(env);
  } catch (error) {
    console.error("quota snapshot failed", failureFields(error));

    if (error?.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(
        error.retryAfterSeconds,
        RATE_LIMIT_COOLDOWN_SECONDS,
      );
      if (cache) {
        schedule(
          ctx,
          cache.put(
            cooldownKey,
            jsonResponse(
              {
                active: true,
                retry_after_seconds: retryAfterSeconds,
                created_at: new Date().toISOString(),
              },
              200,
              { "cache-control": `public, max-age=${retryAfterSeconds}` },
            ),
          ),
        );
      }
      const stale = await staleSnapshotResponse(
        cache,
        "analytics_rate_limited",
        retryAfterSeconds,
      );
      if (stale) return stale;
      return unavailableResponse(error, 503);
    }

    const stale = await staleSnapshotResponse(cache, "analytics_unavailable");
    if (stale) return stale;
    return unavailableResponse(error, 502);
  }

  if (cache) {
    const writes = [
      cache.put(
        freshKey,
        cacheSnapshotResponse(body, FRESH_CACHE_TTL_SECONDS),
      ),
      cache.put(
        staleKey,
        cacheSnapshotResponse(body, STALE_CACHE_TTL_SECONDS),
      ),
      cache.delete(cooldownKey),
    ];
    schedule(ctx, Promise.all(writes));
  }

  return jsonResponse(body, 200, {
    "cache-control": `public, max-age=${CLIENT_CACHE_TTL_SECONDS}`,
    "x-atlas-cache": "miss",
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    // Route pattern is api.atlas-systems.uk/quota*, so the only valid
    // paths here are /quota itself and /quota/_meta (handled above).
    if (url.pathname === "/quota" || url.pathname === "/quota/") {
      return serveQuota(request, env, ctx);
    }

    return jsonResponse({ error: "not found", see: "/quota" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};
