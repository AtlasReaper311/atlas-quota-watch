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
