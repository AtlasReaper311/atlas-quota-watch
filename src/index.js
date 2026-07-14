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

/**
 * One POST to the GraphQL endpoint. Errors surface as a thrown Error
 * whose message carries the GraphQL error text; the token itself is
 * never part of any error path.
 */
async function gql(env, query, variables) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`analytics API returned http ${res.status}`);
  }
  const doc = await res.json();
  if (doc.errors && doc.errors.length) {
    throw new Error(
      `analytics query failed: ${doc.errors
        .map((e) => e.message)
        .join("; ")
        .slice(0, 300)}`,
    );
  }
  const account = doc?.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error("analytics query returned no account node");
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
  const account = await gql(env, WORKERS_QUERY, {
    accountTag: env.CF_ACCOUNT_TAG,
    start: period.start.toISOString(),
    end: now.toISOString(),
  });
  const groups = account.workersInvocationsAdaptive ?? [];
  let requests = 0;
  let errors = 0;
  const perScript = [];
  for (const g of groups) {
    requests += g.sum?.requests ?? 0;
    errors += g.sum?.errors ?? 0;
    perScript.push({
      script: g.dimensions?.scriptName ?? "unknown",
      requests: g.sum?.requests ?? 0,
    });
  }
  perScript.sort((a, b) => b.requests - a.requests);
  return { requests, errors, topScripts: perScript.slice(0, 5) };
}

async function fetchKvOps(env, period, now) {
  const account = await gql(env, KV_OPS_QUERY, {
    accountTag: env.CF_ACCOUNT_TAG,
    start: isoDate(period.start),
    end: isoDate(now),
  });
  const groups = account.kvOperationsAdaptiveGroups ?? [];
  const ops = { read: 0, write: 0, delete: 0, list: 0 };
  for (const g of groups) {
    const action = g.dimensions?.actionType;
    if (action in ops) ops[action] += g.sum?.requests ?? 0;
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
  const account = await gql(env, KV_STORAGE_QUERY, {
    accountTag: env.CF_ACCOUNT_TAG,
    start: isoDate(twoDaysAgo),
    end: isoDate(now),
  });
  const groups = account.kvStorageAdaptiveGroups ?? [];
  const latest = new Map();
  for (const g of groups) {
    const ns = g.dimensions?.namespaceId ?? "unknown";
    const date = g.dimensions?.date ?? "";
    const prev = latest.get(ns);
    if (!prev || date > prev.date) {
      latest.set(ns, {
        date,
        bytes: g.max?.byteCount ?? 0,
        keys: g.max?.keyCount ?? 0,
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

  const [workers, kvOps, kvStorage] = await Promise.all([
    fetchWorkersUsage(env, period, now),
    fetchKvOps(env, period, now),
    fetchKvStorage(env, now),
  ]);

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

  const meters = rawMeters.map((m) =>
    analyzeMeter(m, elapsedDays, totalDays, warnPct),
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

async function runCheck(env) {
  let snapshot;
  try {
    snapshot = await computeQuota(env);
  } catch (err) {
    console.log("quota check failed:", err.message);
    await notify(env, {
      level: "failure",
      title: "Quota watch could not read account analytics",
      message:
        "The usage check failed before producing any numbers. " +
        "The watchdog is blind until this is fixed.",
      fields: { error: err.name || "Error" },
    });
    return;
  }

  const breaches = snapshot.meters.filter((m) => m.breach);
  if (breaches.length === 0) {
    console.log(
      "quota check: all meters healthy,",
      snapshot.period.days_left,
      "days left in period",
    );
    return;
  }

  const worst = breaches.some((m) => m.level === "failure")
    ? "failure"
    : "warning";
  const lines = breaches.map((m) => {
    const eta = m.point_in_time
      ? "point-in-time gauge, threshold breach"
      : m.days_to_limit === null
        ? "no burn recorded, static usage"
        : `~${m.days_to_limit}d to ceiling at current burn`;
    return `${m.label}: ${formatCount(m.usage)} of ${formatCount(m.limit)} (${m.pct}%), ${eta}`;
  });
  const fields = {
    period_days_left: `${snapshot.period.days_left}`,
    period_ends: snapshot.period.end.slice(0, 10),
    snapshot: "https://api.atlas-systems.uk/quota",
  };
  for (const m of breaches.slice(0, 4)) {
    fields[m.id] = m.point_in_time
      ? `${m.pct}% of ceiling in use now`
      : `${m.pct}% used, projected ${formatCount(m.projected_end_of_period)} by period end`;
  }

  await notify(env, {
    level: worst,
    title: `Quota watch: ${breaches.length} meter${breaches.length === 1 ? "" : "s"} approaching a ceiling`,
    message: lines.join("\n"),
    fields,
  });
}

async function serveQuota(request, env, ctx) {
  const cache = globalThis.caches ? globalThis.caches.default : null;
  const cacheKey = new Request("https://atlas-quota-watch.internal/quota");
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let body;
  let status = 200;
  try {
    body = await computeQuota(env);
  } catch (err) {
    console.log("quota snapshot failed:", err.message);
    body = { ok: false, error: err.name || "Error" };
    status = 502;
  }

  const res = new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      // Five minutes of edge cache keeps the public endpoint from
      // spending the GraphQL API's own rate budget; the underlying
      // datasets are daily-to-hourly grained, so nothing is lost.
      "cache-control": "public, max-age=300",
    },
  });
  if (cache && status === 200 && ctx) {
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json" },
      });
    }

    // Route pattern is api.atlas-systems.uk/quota*, so the only valid
    // paths here are /quota itself and /quota/_meta (handled above).
    if (url.pathname === "/quota" || url.pathname === "/quota/") {
      return serveQuota(request, env, ctx);
    }

    return new Response(
      JSON.stringify({ error: "not found", see: "/quota" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};
