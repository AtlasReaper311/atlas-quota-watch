<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# atlas-quota-watch

```text
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // atlas-quota-watch         │
│  daily watchdog for usage ceilings         │
└─────────────────────────────────────────────┘
```

![Runtime](https://img.shields.io/badge/runtime-cloudflare_workers-f5a623?style=flat-square&labelColor=0a0a0f)
![Trigger](https://img.shields.io/badge/trigger-daily_cron-4ade80?style=flat-square&labelColor=0a0a0f)
![Writes](https://img.shields.io/badge/state_writes-zero-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Incremental cost](https://img.shields.io/badge/incremental_cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

`atlas-quota-watch` reads Cloudflare account analytics, compares Workers requests and Workers KV usage with the paid plan's included monthly allotments, and sends one consolidated warning through `atlas-notify` before the projected usage crosses a ceiling.

The Worker is read-only. It has no KV binding and no application state. Its only side effect is an alert through the existing notification router.

Phase 5 adds a separate offline cost-guard engine and CLI. It consumes local,
versioned policy and snapshot files, calculates current state and projections,
emits Phase 1 `Finding` and `EvidenceEnvelope` records, and writes local JSON or
Markdown reports. It does not call Cloudflare, send a notification, create an
issue, change billing or limits, deploy, or shut down a service.

## What it measures

| Meter | Included monthly amount |
|---|---:|
| Workers requests | 10,000,000 |
| KV reads | 10,000,000 |
| KV writes | 1,000,000 |
| KV deletes | 1,000,000 |
| KV list requests | 1,000,000 |
| KV stored data | 1 GiB |

The limits are variables in `wrangler.toml`, not hard-coded in the Worker. Update them when the Cloudflare plan or published pricing changes.

Workers CPU time is not included in this first contract. The account analytics query used here is deliberately limited to datasets that have been validated for this estate. That boundary is reported plainly rather than presenting partial CPU data as complete cost coverage.

## Alert rules

A cumulative meter warns when either condition is true:

1. Current usage is at or above the configured threshold, set to 80 percent by default.
2. Usage projected to the end of the current billing period is above the included amount.

KV storage is a point-in-time gauge. It is checked against the threshold but is not projected as a daily burn rate.

Healthy checks are silent. Current data remains readable through `GET /quota`.
Healthy meters now report `level: "healthy"`; they are no longer labelled as
warnings merely because the field is present.

## Offline cost guard

The canonical policy and response runbooks live in
[`atlas-infra`](https://github.com/AtlasReaper311/atlas-infra/tree/main/policy).
This repository owns the quota snapshot schema, deterministic calculations,
findings/evidence production, fixtures, and CLI.

Each result includes current usage, quota limit, percentage consumed, remaining
allowance, fixed and rolling daily burn, horizon projection, projected
exhaustion and days remaining, evidence timestamp, freshness, source metadata,
confidence, optional previous-period comparison and bounded top contributors,
recommended advisory actions, and one shared state: `healthy`, `warning`,
`failed`, `stale`, `unavailable`, or `unknown`.

Rolling burn requires at least two current-period observations. Acceleration
compares the two most recent adjacent intervals and requires three observations.
With insufficient history the fixed-window arithmetic remains visible, but the
projection/history state is explicit and the meter is not declared healthy.
Gauges such as KV storage are never projected as cumulative counters.

Run a complete offline fixture report from this repository:

```bash
node scripts/cost-guard.js \
  --policy ../atlas-infra/policy/cost-guard.json \
  --fixture test/fixtures/cost/healthy.json \
  --report /tmp/cost-report.json \
  --markdown /tmp/cost-report.md
```

Validate or inspect one layer at a time:

```bash
node scripts/cost-guard.js --policy ../atlas-infra/policy/cost-guard.json --validate-policy
node scripts/cost-guard.js --policy ../atlas-infra/policy/cost-guard.json --fixture test/fixtures/cost/healthy.json --validate-snapshots
node scripts/cost-guard.js --policy ../atlas-infra/policy/cost-guard.json --fixture test/fixtures/cost/healthy.json --state
node scripts/cost-guard.js --policy test/fixtures/cost/policy.json --fixture test/fixtures/cost/projected-exhaustion.json --projections
node scripts/cost-guard.js --policy test/fixtures/cost/policy.json --fixture test/fixtures/cost/warning.json --emit-findings
```

Fixture sets declare `evaluation_time`, so two identical runs are byte-for-byte
stable. `--snapshots <directory>` reads only local `*.json` files in lexical
order. `--previous-report` applies state-transition/cooldown deduplication. The
resulting notification candidates always retain `dry_run: true`,
`network_send: false`, `issue_creation: false`, and `advisory_only: true`.

The implementation uses only Node's standard library and the existing
repository dependencies. The MIT licence continues to cover it; no external
or `simple-proxy` code is copied.

### Failure behavior

- stale data is `stale`, never healthy;
- an unavailable source is `unavailable`;
- malformed records emit redacted failure findings and are excluded from burn;
- missing history, owner, limit, or policy identity is `unknown`;
- conflicting lifecycle/scope/provenance is `failed`;
- `simple-proxy` is reported as an informational exclusion and never evaluated,
  notified, or used as an action target.

The architecture, algorithm limits, future read-only provider adapter, rollback,
and focused response runbooks are maintained in
[`atlas-infra/docs/cost-guard.md`](https://github.com/AtlasReaper311/atlas-infra/blob/main/docs/cost-guard.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/quota` | Current usage, burn rate, projection, and billing-period position |
| `GET` | `/quota/_meta` | Atlas Worker metadata contract |

## Prerequisites

- Node.js 20 or newer
- Wrangler authenticated to the Atlas Systems Cloudflare account
- A Cloudflare API token scoped to Account Analytics read access
- The shared `NOTIFY_TOKEN` used by `atlas-notify`

## Local validation

```bash
npm ci
npm run validate
node scripts/cost-guard.js --policy ../atlas-infra/policy/cost-guard.json --fixture test/fixtures/cost/healthy.json --report /tmp/cost-report.json --markdown /tmp/cost-report.md
```

## First deployment

Set Worker runtime secrets through Wrangler's interactive prompt:

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN
npx wrangler secret put NOTIFY_TOKEN
npx wrangler deploy
```

Verify both contracts:

```bash
curl -fsS https://api.atlas-systems.uk/quota | python3 -m json.tool
curl -fsS https://api.atlas-systems.uk/quota/_meta | python3 -m json.tool
```

## Security boundary

`CF_ANALYTICS_TOKEN` should have Account Analytics read access only. The Worker does not require zone-edit, Workers-edit, KV-edit, or billing-edit permission. `NOTIFY_TOKEN` grants access only to the estate notification ingest.

Public responses never include token values or upstream response bodies. An analytics failure returns an opaque error class and sends a separate failure notification.

## How it fits into Atlas Systems

This Worker adds capacity and cost assurance to the existing control plane. `atlas-journey-watch` checks public behavior, `atlas-dep-audit` checks software supply-chain evidence, `atlas-infra` checks estate conformance and change impact, and `atlas-quota-watch` checks whether platform usage is moving toward paid overage.

Its `/quota` contract can feed the Home Assistant estate dashboard and future digest reporting without adding a second source of truth.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
