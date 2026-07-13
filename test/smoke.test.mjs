// Smoke coverage for the pure logic: the billing window and the meter
// analysis, nothing network-facing. The GraphQL calls are exercised
// for real by the first manual /quota fetch after deploy, not mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { billingPeriod, analyzeMeter, validateConfig } from "../src/index.js";

test("period starts on the anchor day of the current month once passed", () => {
  const now = new Date(Date.UTC(2026, 6, 13));
  const p = billingPeriod(now, "2");
  assert.equal(p.start.toISOString().slice(0, 10), "2026-07-02");
  assert.equal(p.end.toISOString().slice(0, 10), "2026-08-02");
});

test("period reaches back a month when the anchor is still ahead", () => {
  const now = new Date(Date.UTC(2026, 6, 1));
  const p = billingPeriod(now, "2");
  assert.equal(p.start.toISOString().slice(0, 10), "2026-06-02");
  assert.equal(p.end.toISOString().slice(0, 10), "2026-07-02");
});

test("anchor clamps to 28 so every month has the day", () => {
  const now = new Date(Date.UTC(2026, 1, 15));
  const p = billingPeriod(now, "31");
  assert.equal(p.start.toISOString().slice(0, 10), "2026-01-28");
  assert.equal(p.end.toISOString().slice(0, 10), "2026-02-28");
});

test("a nonsense anchor falls back to the 1st", () => {
  const now = new Date(Date.UTC(2026, 6, 13));
  const p = billingPeriod(now, "not-a-number");
  assert.equal(p.start.toISOString().slice(0, 10), "2026-07-01");
});

test("a counter meter breaches on projection even below the threshold", () => {
  const meter = { id: "workers_requests", label: "x", usage: 3000000, limit: 10000000 };
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
  assert.equal(early.breach, false, "static storage early in the period is not a runaway");
  assert.equal(early.projected_end_of_period, null);
  const full = analyzeMeter({ ...gauge, usage: 900 * 1024 * 1024 }, 2, 30, 0.8);
  assert.equal(full.breach, true, "a genuinely full store still breaches the threshold");
});


test("configuration rejects missing secrets and invalid limits", () => {
  assert.throws(() => validateConfig({}), /CF_ANALYTICS_TOKEN/);
  const base = {
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
  assert.equal(validateConfig(base).threshold, 0.8);
  assert.throws(
    () => validateConfig({ ...base, LIMIT_KV_READS_MONTH: "0" }),
    /LIMIT_KV_READS_MONTH/,
  );
});
