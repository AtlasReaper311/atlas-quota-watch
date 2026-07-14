import { createHash } from "node:crypto";

import { canonicalJson, validateJsonSchema } from "./json-schema.js";

export const COST_GUARD_VERSION = "1.0.0";
export const POLICY_SCHEMA_VERSION = "atlas-cost-guard/policy/v1";
export const SNAPSHOT_SCHEMA_VERSION = "atlas-cost-guard/quota-snapshot/v1";
export const SNAPSHOT_SET_SCHEMA_VERSION = "atlas-cost-guard/snapshot-set/v1";
export const REPORT_SCHEMA_VERSION = "atlas-cost-guard/report/v1";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STATE_PRECEDENCE = [
  "failed",
  "unavailable",
  "stale",
  "warning",
  "unknown",
  "healthy",
];
const SERVICE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^AtlasReaper311\/[A-Za-z0-9._-]+$/;
const FINDING_REFERENCE =
  "https://github.com/AtlasReaper311/atlas-infra/blob/main/policy/cost-guard.json";

const RUNBOOKS = {
  "warning-threshold-exceeded":
    "docs/runbooks/cost-guard-warning-threshold-exceeded.md",
  "critical-threshold-exceeded":
    "docs/runbooks/cost-guard-critical-threshold-exceeded.md",
  "projected-exhaustion": "docs/runbooks/cost-guard-projected-exhaustion.md",
  "stale-quota-data": "docs/runbooks/cost-guard-stale-data.md",
  "unavailable-quota-data": "docs/runbooks/cost-guard-provider-unavailable.md",
  "malformed-quota-snapshot": "docs/runbooks/cost-guard-malformed-snapshot.md",
  "missing-policy-owner": "docs/runbooks/cost-guard-policy-owner-missing.md",
  "duplicate-finding": "docs/runbooks/cost-guard-noisy-or-duplicate-finding.md",
};

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function round(value, places = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function isUtcTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function policyKey(item) {
  return `${item.service_id}\u0000${item.provider}\u0000${item.quota_type}`;
}

function stateKey(item) {
  return `${item.service_id}:${item.provider}:${item.quota_type}`;
}

function compareByKey(a, b) {
  return stateKey(a).localeCompare(stateKey(b));
}

function worstState(states) {
  for (const candidate of STATE_PRECEDENCE) {
    if (states.includes(candidate)) return candidate;
  }
  return "unknown";
}

function sanitizeLocation(location, fallback) {
  const leaf = String(location ?? fallback)
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 160);
  return `snapshots/${leaf || fallback}`;
}

function classificationEqual(left, right) {
  return (
    left?.lifecycle === right?.lifecycle &&
    left?.scope === right?.scope &&
    left?.provenance === right?.provenance
  );
}

function recommendedActions(state) {
  const actions = {
    healthy: ["Continue the approved read-only observation schedule."],
    warning: [
      "Review bounded contributors and prepare owner-approved usage reduction options.",
      "Collect the next read-only snapshot before changing policy thresholds.",
    ],
    failed: [
      "Escalate to the declared owner and independently verify the evidence.",
      "Keep all provider, billing, deployment, and shutdown actions human-gated.",
    ],
    stale: [
      "Restore the approved read-only data collection path and retain the last result as stale.",
    ],
    unavailable: [
      "Diagnose the read-only source and permission names without reading credential values.",
    ],
    unknown: [
      "Supply the missing history, owner, limit, or policy identity before deciding action.",
    ],
  };
  return actions[state] ?? actions.unknown;
}

function findingFingerprint(finding) {
  const selected = {
    "category": finding.category,
    "location": finding.location,
    "rule_id": finding.rule_id,
    "source.check_id": finding.source.check_id,
    "source.producer": finding.source.producer,
    "subject.repository": finding.subject.repository,
    "subject.service_id": finding.subject.service_id ?? null,
  };
  return `sha256:${sha256(selected)}`;
}

function createFinding({
  ruleId,
  checkId,
  severity,
  summary,
  location,
  detectedAt,
  repository = "AtlasReaper311/atlas-quota-watch",
  serviceId,
  runbookRef = RUNBOOKS[ruleId],
}) {
  const subject = { repository };
  if (serviceId && SERVICE_ID.test(serviceId)) subject.service_id = serviceId;
  const references = [
    FINDING_REFERENCE,
    `https://github.com/${repository}`,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const finding = {
    schema_version: "atlas-control-plane/finding/v1",
    source: {
      producer: "atlas-quota-watch",
      check_id: checkId.slice(0, 96),
      producer_version: COST_GUARD_VERSION,
    },
    subject,
    category: "cost",
    severity,
    rule_id: ruleId,
    location,
    evidence: {
      summary: summary.slice(0, 500),
      references,
      redacted: true,
    },
    detected_at: detectedAt,
    fingerprint: "",
    remediation: {
      eligible: false,
      reason: "Cost guard is advisory-only; owner review is required.",
    },
  };
  if (runbookRef) finding.runbook_ref = runbookRef;
  finding.fingerprint = findingFingerprint(finding);
  return finding;
}

function requiredFieldErrors(value, fields, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path}: expected object`];
  }
  return fields
    .filter((field) => !Object.hasOwn(value, field))
    .map((field) => `${path}: missing required property ${JSON.stringify(field)}`);
}

function additionalPropertyErrors(value, allowed, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}: additional property ${JSON.stringify(key)} is not allowed`);
}

function safeSourceMetadata(source) {
  if (!source) return null;
  return {
    kind: source.kind,
    name: source.name,
    collected_by: source.collected_by,
  };
}

export function validatePolicy(policy) {
  const errors = requiredFieldErrors(
    policy,
    [
      "schema_version",
      "owner",
      "finding_contract",
      "evidence_contract",
      "defaults",
      "services",
    ],
    "$",
  );
  if (errors.length > 0) return errors.sort();
  errors.push(
    ...additionalPropertyErrors(
      policy,
      [
        "schema_version",
        "owner",
        "finding_contract",
        "evidence_contract",
        "defaults",
        "services",
      ],
      "$",
    ),
  );
  if (policy.schema_version !== POLICY_SCHEMA_VERSION) {
    errors.push(`$.schema_version: must equal ${POLICY_SCHEMA_VERSION}`);
  }
  if (policy.owner !== "AtlasReaper311/atlas-infra") {
    errors.push("$.owner: must equal AtlasReaper311/atlas-infra");
  }
  if (!Array.isArray(policy.services) || policy.services.length === 0) {
    errors.push("$.services: must contain at least one service policy");
    return errors.sort();
  }
  if (policy.defaults?.advisory_only !== true) {
    errors.push("$.defaults.advisory_only: must be true");
  }

  const required = [
    "service_id",
    "repository",
    "provider",
    "quota_type",
    "unit",
    "measurement_mode",
    "free_tier_limit",
    "warning_threshold_pct",
    "critical_threshold_pct",
    "projection_horizon_days",
    "cooldown_hours",
    "max_data_age_hours",
    "acceleration_threshold_pct",
    "owner",
    "route_ref",
    "worker_ref",
    "classification",
    "assurance",
    "notification_enabled",
    "issue_creation_allowed",
    "advisory_only",
  ];
  const keys = new Set();
  policy.services.forEach((service, index) => {
    const path = `$.services[${index}]`;
    errors.push(...requiredFieldErrors(service, required, path));
    if (!service || typeof service !== "object") return;
    errors.push(...additionalPropertyErrors(service, required, path));
    if (!SERVICE_ID.test(service.service_id ?? "")) {
      errors.push(`${path}.service_id: invalid stable service id`);
    }
    if (!REPOSITORY.test(service.repository ?? "")) {
      errors.push(`${path}.repository: invalid repository`);
    }
    if (!SERVICE_ID.test(service.provider ?? "")) {
      errors.push(`${path}.provider: invalid provider`);
    }
    if (!SERVICE_ID.test(service.quota_type ?? "")) {
      errors.push(`${path}.quota_type: invalid quota type`);
    }
    if (!SERVICE_ID.test(service.unit ?? "")) {
      errors.push(`${path}.unit: invalid unit`);
    }
    if (!["cumulative", "gauge"].includes(service.measurement_mode)) {
      errors.push(`${path}.measurement_mode: must be cumulative or gauge`);
    }
    if (
      !Number.isFinite(service.warning_threshold_pct) ||
      !Number.isFinite(service.critical_threshold_pct) ||
      service.warning_threshold_pct < 0 ||
      service.critical_threshold_pct > 100 ||
      service.warning_threshold_pct >= service.critical_threshold_pct
    ) {
      errors.push(`${path}: warning threshold must be below critical threshold`);
    }
    for (const field of [
      "projection_horizon_days",
      "cooldown_hours",
      "max_data_age_hours",
    ]) {
      if (!Number.isInteger(service[field]) || service[field] <= 0) {
        errors.push(`${path}.${field}: must be a positive integer`);
      }
    }
    if (
      !Number.isFinite(service.acceleration_threshold_pct) ||
      service.acceleration_threshold_pct < 0
    ) {
      errors.push(`${path}.acceleration_threshold_pct: must be non-negative`);
    }
    if (service.advisory_only !== true) {
      errors.push(`${path}.advisory_only: must be true`);
    }
    const key = policyKey(service);
    if (keys.has(key)) errors.push(`${path}: duplicate service/provider/quota key`);
    keys.add(key);
  });
  return errors.sort();
}

export function validateSnapshot(snapshot) {
  const required = [
    "schema_version",
    "service_id",
    "provider",
    "quota_type",
    "observed_at",
    "period_start",
    "period_end",
    "usage",
    "quota_limit",
    "availability",
    "source",
    "confidence",
    "classification",
  ];
  const errors = requiredFieldErrors(snapshot, required, "$");
  if (errors.length > 0) return errors.sort();
  errors.push(
    ...additionalPropertyErrors(
      snapshot,
      [...required, "previous_period_usage", "contributors"],
      "$",
    ),
  );
  if (snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`$.schema_version: must equal ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  for (const field of ["service_id", "provider", "quota_type"]) {
    if (!SERVICE_ID.test(snapshot[field] ?? "")) {
      errors.push(`$.${field}: invalid stable identifier`);
    }
  }
  for (const field of ["observed_at", "period_start", "period_end"]) {
    if (!isUtcTimestamp(snapshot[field])) {
      errors.push(`$.${field}: must be a UTC RFC 3339 timestamp ending in Z`);
    }
  }
  if (
    isUtcTimestamp(snapshot.period_start) &&
    isUtcTimestamp(snapshot.period_end) &&
    Date.parse(snapshot.period_end) <= Date.parse(snapshot.period_start)
  ) {
    errors.push("$.period_end: must be after period_start");
  }
  if (!REPOSITORY.test(snapshot.source?.collected_by ?? "")) {
    errors.push("$.source.collected_by: must be an Atlas repository");
  }
  if (!SERVICE_ID.test(snapshot.source?.kind ?? "")) {
    errors.push("$.source.kind: invalid source kind");
  }
  if (
    typeof snapshot.source?.name !== "string" ||
    snapshot.source.name.length === 0 ||
    snapshot.source.name.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(snapshot.source.name)
  ) {
    errors.push("$.source.name: must be a bounded non-sensitive identifier");
  }
  errors.push(
    ...additionalPropertyErrors(
      snapshot.source,
      ["kind", "name", "collected_by"],
      "$.source",
    ),
    ...additionalPropertyErrors(
      snapshot.classification,
      ["lifecycle", "scope", "provenance"],
      "$.classification",
    ),
  );
  if (!['high', 'medium', 'low', 'unknown'].includes(snapshot.confidence)) {
    errors.push("$.confidence: invalid confidence level");
  }
  if (!['available', 'unavailable'].includes(snapshot.availability)) {
    errors.push("$.availability: must be available or unavailable");
  }
  if (snapshot.availability === "available") {
    if (!Number.isFinite(snapshot.usage) || snapshot.usage < 0) {
      errors.push("$.usage: available snapshots require non-negative usage");
    }
  } else if (snapshot.usage !== null) {
    errors.push("$.usage: unavailable snapshots require null usage");
  }
  if (
    snapshot.quota_limit !== null &&
    (!Number.isFinite(snapshot.quota_limit) || snapshot.quota_limit < 0)
  ) {
    errors.push("$.quota_limit: must be null or a non-negative number");
  }
  if (
    snapshot.previous_period_usage !== undefined &&
    snapshot.previous_period_usage !== null &&
    (!Number.isFinite(snapshot.previous_period_usage) ||
      snapshot.previous_period_usage < 0)
  ) {
    errors.push("$.previous_period_usage: must be null or a non-negative number");
  }
  if (snapshot.contributors !== undefined) {
    if (!Array.isArray(snapshot.contributors) || snapshot.contributors.length > 10) {
      errors.push("$.contributors: must be an array with at most 10 items");
    } else {
      snapshot.contributors.forEach((contributor, index) => {
        if (
          typeof contributor?.id !== "string" ||
          contributor.id.length === 0 ||
          contributor.id.length > 128 ||
          !/^[A-Za-z0-9._:-]+$/.test(contributor.id) ||
          !Number.isFinite(contributor.usage) ||
          contributor.usage < 0
        ) {
          errors.push(`$.contributors[${index}]: invalid bounded contributor`);
        }
        errors.push(
          ...additionalPropertyErrors(
            contributor,
            ["id", "usage"],
            `$.contributors[${index}]`,
          ),
        );
      });
    }
  }
  const classification = snapshot.classification;
  if (
    !classification ||
    ![
      "production",
      "active",
      "experimental",
      "deprecated",
      "archived",
    ].includes(classification.lifecycle) ||
    !["public", "internal"].includes(classification.scope) ||
    !["original", "external-derived"].includes(classification.provenance)
  ) {
    errors.push("$.classification: invalid lifecycle/scope/provenance");
  }
  return errors.sort();
}

function intervalRate(older, newer) {
  const days = (Date.parse(newer.observed_at) - Date.parse(older.observed_at)) / DAY_MS;
  if (days <= 0) return null;
  const delta = newer.usage - older.usage;
  if (delta < 0) return null;
  return delta / days;
}

function calculateAcceleration(samples, threshold, measurementMode) {
  if (measurementMode === "gauge") {
    return {
      status: "not-applicable",
      previous_rate_per_day: null,
      recent_rate_per_day: null,
      change_pct: null,
      detected: false,
    };
  }
  if (samples.length < 3) {
    return {
      status: "insufficient-history",
      previous_rate_per_day: null,
      recent_rate_per_day: null,
      change_pct: null,
      detected: false,
    };
  }
  const [first, second, third] = samples.slice(-3);
  const previous = intervalRate(first, second);
  const recent = intervalRate(second, third);
  if (previous === null || recent === null) {
    return {
      status: "counter-reset-or-duplicate-time",
      previous_rate_per_day: round(previous),
      recent_rate_per_day: round(recent),
      change_pct: null,
      detected: false,
    };
  }
  if (previous === 0) {
    return {
      status: recent > 0 ? "baseline-zero" : "stable-zero",
      previous_rate_per_day: 0,
      recent_rate_per_day: round(recent),
      change_pct: null,
      detected: recent > 0,
    };
  }
  const change = ((recent - previous) / previous) * 100;
  return {
    status: "compared",
    previous_rate_per_day: round(previous),
    recent_rate_per_day: round(recent),
    change_pct: round(change),
    detected: change >= threshold,
  };
}

function emptyState(entry, state, location) {
  return {
    state_key: entry ? stateKey(entry) : `malformed:${location}`,
    service_id: entry?.service_id ?? null,
    repository: entry?.repository ?? "AtlasReaper311/atlas-quota-watch",
    provider: entry?.provider ?? null,
    quota_type: entry?.quota_type ?? null,
    unit: entry?.unit ?? null,
    current_usage: null,
    quota_limit: entry?.free_tier_limit ?? null,
    percentage_consumed: null,
    remaining_allowance: null,
    burn_rate: {
      selected_method: null,
      selected_per_day: null,
      fixed_window_per_day: null,
      rolling_window_per_day: null,
    },
    projection: {
      status: "unavailable",
      history_status: "unavailable",
      horizon_days: entry?.projection_horizon_days ?? null,
      fixed_window_usage: null,
      rolling_window_usage: null,
      selected_usage: null,
      projected_exhaustion_at: null,
      days_until_exhaustion: null,
    },
    acceleration: {
      status: "unavailable",
      previous_rate_per_day: null,
      recent_rate_per_day: null,
      change_pct: null,
      detected: false,
    },
    previous_period_comparison: {
      status: "unavailable",
      previous_usage: null,
      absolute_change: null,
      change_pct: null,
    },
    top_contributors: [],
    state,
    evidence_timestamp: null,
    data_freshness: {
      age_hours: null,
      max_age_hours: entry?.max_data_age_hours ?? null,
      state,
    },
    source_metadata: null,
    confidence: "unknown",
    recommended_actions: recommendedActions(state),
    advisory_only: true,
  };
}

function evaluateEntry(entry, records, nowIso, addFinding) {
  const nowMs = Date.parse(nowIso);
  const location = records.at(-1)?.location ?? "snapshots/missing.json";
  if (!entry.owner) {
    addFinding(
      createFinding({
        ruleId: "missing-policy-owner",
        checkId: `missing-policy-owner-${entry.quota_type}`,
        severity: "warning",
        summary: `${entry.service_id}/${entry.quota_type} has no declared policy owner.`,
        location: "policy/cost-guard.json",
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "unknown",
    );
  }
  if (records.length === 0) {
    addFinding(
      createFinding({
        ruleId: "unavailable-quota-data",
        checkId: `unavailable-quota-data-${entry.quota_type}`,
        severity: "failure",
        summary: `No quota snapshot is available for ${entry.service_id}/${entry.quota_type}.`,
        location: "snapshots/missing.json",
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "unavailable",
    );
    return emptyState(entry, "unavailable", location);
  }

  const sorted = [...records].sort(
    (a, b) => Date.parse(a.snapshot.observed_at) - Date.parse(b.snapshot.observed_at),
  );
  const latestRecord = sorted.at(-1);
  const latest = latestRecord.snapshot;
  const latestLocation = latestRecord.location;
  if (latest.availability === "unavailable") {
    addFinding(
      createFinding({
        ruleId: "unavailable-quota-data",
        checkId: `unavailable-quota-data-${entry.quota_type}`,
        severity: "failure",
        summary: `The quota source is unavailable for ${entry.service_id}/${entry.quota_type}.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "unavailable",
    );
    const state = emptyState(entry, "unavailable", latestLocation);
    state.evidence_timestamp = latest.observed_at;
    state.source_metadata = safeSourceMetadata(latest.source);
    state.confidence = latest.confidence;
    return state;
  }

  const ageHours = (nowMs - Date.parse(latest.observed_at)) / HOUR_MS;
  if (ageHours < -5 / 60) {
    addFinding(
      createFinding({
        ruleId: "malformed-quota-snapshot",
        checkId: `malformed-quota-snapshot-${entry.quota_type}`,
        severity: "failure",
        summary: `The newest ${entry.quota_type} snapshot is timestamped in the future.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "failed",
    );
    return emptyState(entry, "failed", latestLocation);
  }
  if (ageHours > entry.max_data_age_hours) {
    addFinding(
      createFinding({
        ruleId: "stale-quota-data",
        checkId: `stale-quota-data-${entry.quota_type}`,
        severity: "warning",
        summary: `${entry.service_id}/${entry.quota_type} evidence is ${round(ageHours, 2)} hours old.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "stale",
    );
    const state = emptyState(entry, "stale", latestLocation);
    state.evidence_timestamp = latest.observed_at;
    state.data_freshness = {
      age_hours: round(ageHours, 3),
      max_age_hours: entry.max_data_age_hours,
      state: "stale",
    };
    state.source_metadata = safeSourceMetadata(latest.source);
    state.confidence = latest.confidence;
    return state;
  }
  if (!classificationEqual(entry.classification, latest.classification)) {
    addFinding(
      createFinding({
        ruleId: "classification-conflict",
        checkId: `classification-conflict-${entry.quota_type}`,
        severity: "failure",
        summary: `${entry.service_id}/${entry.quota_type} snapshot classification conflicts with policy.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "failed",
    );
    return emptyState(entry, "failed", latestLocation);
  }

  const limit = latest.quota_limit ?? entry.free_tier_limit;
  if (!Number.isFinite(limit) || limit <= 0) {
    addFinding(
      createFinding({
        ruleId: "missing-quota-limit",
        checkId: `missing-quota-limit-${entry.quota_type}`,
        severity: "failure",
        summary: `${entry.service_id}/${entry.quota_type} has no positive quota limit.`,
        location: "policy/cost-guard.json",
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      "unknown",
    );
    const state = emptyState(entry, "unknown", latestLocation);
    state.current_usage = latest.usage;
    state.evidence_timestamp = latest.observed_at;
    state.source_metadata = safeSourceMetadata(latest.source);
    state.confidence = latest.confidence;
    return state;
  }

  const periodSamples = sorted
    .map((record) => record.snapshot)
    .filter(
      (snapshot) =>
        snapshot.availability === "available" &&
        snapshot.period_start === latest.period_start &&
        snapshot.period_end === latest.period_end,
    );
  const elapsedDays = Math.max(
    (Date.parse(latest.observed_at) - Date.parse(latest.period_start)) / DAY_MS,
    0,
  );
  const fixedBurn =
    entry.measurement_mode === "cumulative" && elapsedDays > 0
      ? latest.usage / elapsedDays
      : null;
  let rollingBurn = null;
  let historyStatus =
    entry.measurement_mode === "gauge" ? "not-applicable" : "insufficient-history";
  if (entry.measurement_mode === "cumulative" && periodSamples.length >= 2) {
    rollingBurn = intervalRate(periodSamples[0], periodSamples.at(-1));
    historyStatus = rollingBurn === null ? "counter-reset-or-duplicate-time" : "sufficient";
  }
  const selectedMethod =
    rollingBurn !== null ? "rolling-window" : fixedBurn !== null ? "fixed-window" : null;
  const selectedBurn = rollingBurn ?? fixedBurn;
  const remaining = Math.max(limit - latest.usage, 0);
  const daysToExhaustion =
    entry.measurement_mode === "cumulative" && selectedBurn > 0
      ? remaining / selectedBurn
      : null;
  const exhaustionAt =
    daysToExhaustion === null
      ? null
      : new Date(Date.parse(latest.observed_at) + daysToExhaustion * DAY_MS).toISOString();
  const fixedProjection =
    fixedBurn === null ? null : latest.usage + fixedBurn * entry.projection_horizon_days;
  const rollingProjection =
    rollingBurn === null ? null : latest.usage + rollingBurn * entry.projection_horizon_days;
  const selectedProjection =
    selectedBurn === null ? null : latest.usage + selectedBurn * entry.projection_horizon_days;
  const percentage = (latest.usage / limit) * 100;
  const acceleration = calculateAcceleration(
    periodSamples,
    entry.acceleration_threshold_pct,
    entry.measurement_mode,
  );
  const previousUsage = latest.previous_period_usage ?? null;
  const previousPeriodComparison = {
    status:
      previousUsage === null
        ? "unavailable"
        : previousUsage === 0
          ? "baseline-zero"
          : "compared",
    previous_usage: previousUsage,
    absolute_change:
      previousUsage === null ? null : round(latest.usage - previousUsage),
    change_pct:
      previousUsage === null || previousUsage === 0
        ? null
        : round(((latest.usage - previousUsage) / previousUsage) * 100),
  };
  const topContributors = [...(latest.contributors ?? [])]
    .sort((a, b) => b.usage - a.usage || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((contributor) => ({ id: contributor.id, usage: contributor.usage }));

  let state = "healthy";
  if (percentage >= entry.critical_threshold_pct) {
    state = "failed";
    addFinding(
      createFinding({
        ruleId: "critical-threshold-exceeded",
        checkId: `critical-threshold-exceeded-${entry.quota_type}`,
        severity: "critical",
        summary: `${entry.service_id}/${entry.quota_type} is at ${round(percentage, 2)}% of its quota.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      state,
    );
  } else if (percentage >= entry.warning_threshold_pct) {
    state = "warning";
    addFinding(
      createFinding({
        ruleId: "warning-threshold-exceeded",
        checkId: `warning-threshold-exceeded-${entry.quota_type}`,
        severity: "warning",
        summary: `${entry.service_id}/${entry.quota_type} is at ${round(percentage, 2)}% of its quota.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      state,
    );
  }
  if (
    historyStatus === "sufficient" &&
    daysToExhaustion !== null &&
    daysToExhaustion <= entry.projection_horizon_days
  ) {
    if (state !== "failed") state = "warning";
    addFinding(
      createFinding({
        ruleId: "projected-exhaustion",
        checkId: `projected-exhaustion-${entry.quota_type}`,
        severity: "warning",
        summary: `${entry.service_id}/${entry.quota_type} is projected to exhaust in ${round(daysToExhaustion, 2)} days.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      state,
    );
  }
  if (acceleration.detected) {
    if (state === "healthy" || state === "unknown") state = "warning";
    const comparison =
      acceleration.change_pct === null
        ? "after a zero prior interval"
        : `by ${acceleration.change_pct}%`;
    addFinding(
      createFinding({
        ruleId: "usage-acceleration",
        checkId: `usage-acceleration-${entry.quota_type}`,
        severity: "warning",
        summary: `${entry.service_id}/${entry.quota_type} burn accelerated ${comparison}.`,
        location: latestLocation,
        detectedAt: nowIso,
        repository: entry.repository,
        serviceId: entry.service_id,
      }),
      entry,
      state,
    );
  }
  if (!entry.owner && state === "healthy") state = "unknown";
  if (
    entry.measurement_mode === "cumulative" &&
    historyStatus !== "sufficient" &&
    state === "healthy"
  ) {
    state = "unknown";
  }

  const projectionStatus =
    entry.measurement_mode === "gauge"
      ? "not-applicable"
      : historyStatus !== "sufficient"
        ? "insufficient-history"
        : selectedBurn === 0
          ? "no-burn"
          : "projected";
  return {
    state_key: stateKey(entry),
    service_id: entry.service_id,
    repository: entry.repository,
    provider: entry.provider,
    quota_type: entry.quota_type,
    unit: entry.unit,
    current_usage: latest.usage,
    quota_limit: limit,
    percentage_consumed: round(percentage),
    remaining_allowance: round(remaining),
    burn_rate: {
      selected_method: selectedMethod,
      selected_per_day: round(selectedBurn),
      fixed_window_per_day: round(fixedBurn),
      rolling_window_per_day: round(rollingBurn),
    },
    projection: {
      status: projectionStatus,
      history_status: historyStatus,
      horizon_days: entry.projection_horizon_days,
      fixed_window_usage: round(fixedProjection),
      rolling_window_usage: round(rollingProjection),
      selected_usage: round(selectedProjection),
      projected_exhaustion_at: exhaustionAt,
      days_until_exhaustion: round(daysToExhaustion),
    },
    acceleration,
    previous_period_comparison: previousPeriodComparison,
    top_contributors: topContributors,
    state,
    evidence_timestamp: latest.observed_at,
    data_freshness: {
      age_hours: round(ageHours, 3),
      max_age_hours: entry.max_data_age_hours,
      state: "healthy",
    },
    source_metadata: safeSourceMetadata(latest.source),
    confidence: latest.confidence,
    recommended_actions: recommendedActions(state),
    advisory_only: true,
  };
}

function buildNotificationCandidates(findings, contexts, states, previousReport, nowIso) {
  const previousCandidates = new Map(
    (previousReport?.notification_candidates ?? []).map((candidate) => [
      candidate.deduplication_key,
      candidate,
    ]),
  );
  const previousStates = new Map(
    (previousReport?.states ?? []).map((state) => [state.state_key, state.state]),
  );
  const currentStates = new Map(states.map((state) => [state.state_key, state.state]));
  const grouped = new Map();
  for (const finding of findings) {
    if (finding.severity === "info" || !contexts.has(finding.fingerprint)) continue;
    const context = contexts.get(finding.fingerprint);
    if (!grouped.has(context.state_key)) {
      grouped.set(context.state_key, {
        entry: context.entry,
        state_key: context.state_key,
        fallback_state: context.state,
        finding_fingerprints: [],
      });
    }
    grouped.get(context.state_key).finding_fingerprints.push(finding.fingerprint);
  }
  return [...grouped.values()]
    .map((group) => {
      const entry = group.entry;
      const currentState = currentStates.get(group.state_key) ?? group.fallback_state;
      const key = `cost-guard:sha256:${sha256({
        state_key: group.state_key,
        state: currentState,
      })}`;
      const previous = previousCandidates.get(key);
      const stateChanged = previousStates.get(group.state_key) !== currentState;
      const basisAt =
        !previous || stateChanged ? nowIso : previous.notification_basis_at ?? previous.evaluated_at;
      const cooldownUntil = new Date(
        Date.parse(basisAt) + entry.cooldown_hours * HOUR_MS,
      ).toISOString();
      const enabled = entry.notification_enabled === true;
      const eligible = enabled && (stateChanged || Date.parse(nowIso) >= Date.parse(cooldownUntil));
      return {
        deduplication_key: key,
        finding_fingerprints: group.finding_fingerprints.sort(),
        state_key: group.state_key,
        state: currentState,
        state_changed: stateChanged,
        notification_enabled: enabled,
        eligible,
        reason: !enabled
          ? "Notification is disabled by policy."
          : eligible
            ? "State transition or expired cooldown; dry-run only."
            : "Duplicate finding suppressed inside the cooldown window.",
        notification_basis_at: basisAt,
        cooldown_until: cooldownUntil,
        evaluated_at: nowIso,
        dry_run: true,
        network_send: false,
        issue_creation_allowed_by_policy: entry.issue_creation_allowed,
        issue_creation: false,
        advisory_only: true,
      };
    })
    .sort((a, b) => a.deduplication_key.localeCompare(b.deduplication_key));
}

function buildEvidenceEnvelope(reportSummary, states, findings, nowIso) {
  const payload = {
    schema_version: "atlas-cost-guard/evidence-payload/v1",
    report_state: reportSummary.state,
    services_evaluated: reportSummary.services_evaluated,
    findings_by_severity: reportSummary.findings_by_severity,
    state_results: states.map((state) => ({
      state_key: state.state_key,
      state: state.state,
      evidence_timestamp: state.evidence_timestamp,
    })),
    finding_fingerprints: findings.map((finding) => finding.fingerprint),
  };
  return {
    schema_version: "atlas-control-plane/evidence-envelope/v1",
    producer: "atlas-quota-watch",
    subject: {
      repository: "AtlasReaper311/atlas-quota-watch",
      service_id: "atlas-quota-watch",
      evidence_type: "cost-guard-report",
    },
    timestamp: nowIso,
    digest: {
      algorithm: "sha-256",
      value: sha256(payload),
    },
    payload,
    sensitivity: "internal",
    expires_at: new Date(Date.parse(nowIso) + 90 * DAY_MS).toISOString(),
  };
}

export function evaluateCostGuard({
  policy,
  snapshots,
  now,
  previousReport = null,
  sourceMode = "fixture",
}) {
  const policyErrors = validatePolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`cost policy is invalid: ${policyErrors.join("; ")}`);
  }
  const nowIso = new Date(now).toISOString();
  const findingsByFingerprint = new Map();
  const findingContexts = new Map();
  const addFinding = (finding, entry = null, state = "unknown") => {
    findingsByFingerprint.set(finding.fingerprint, finding);
    if (entry) {
      findingContexts.set(finding.fingerprint, {
        entry,
        state,
        state_key: stateKey(entry),
      });
    }
  };

  const validRecords = [];
  const malformedStates = [];
  snapshots.forEach((input, index) => {
    const snapshot = input?.snapshot ?? input;
    const location = sanitizeLocation(input?.location, `input-${index + 1}.json`);
    const errors = validateSnapshot(snapshot);
    if (errors.length > 0) {
      const digest = sha256({ location, errors }).slice(0, 12);
      addFinding(
        createFinding({
          ruleId: "malformed-quota-snapshot",
          checkId: `malformed-quota-snapshot-${digest}`,
          severity: "failure",
          summary: `A quota snapshot is malformed: ${errors[0]}`,
          location,
          detectedAt: nowIso,
          serviceId: SERVICE_ID.test(snapshot?.service_id ?? "")
            ? snapshot.service_id
            : undefined,
        }),
      );
      malformedStates.push(emptyState(null, "failed", location));
      return;
    }
    validRecords.push({ snapshot, location });
  });

  const policyEntries = new Map(policy.services.map((entry) => [policyKey(entry), entry]));
  const grouped = new Map();
  validRecords.forEach((record) => {
    const key = policyKey(record.snapshot);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  });

  const states = [...malformedStates];
  for (const entry of [...policy.services].sort(compareByKey)) {
    if (!entry.assurance.enabled) {
      if (entry.service_id === "simple-proxy") {
        addFinding(
          createFinding({
            ruleId: "simple-proxy-exclusion",
            checkId: `simple-proxy-exclusion-${entry.quota_type}`,
            severity: "info",
            summary:
              "simple-proxy remains excluded because it is deprecated, internal, and external-derived.",
            location: "policy/cost-guard.json",
            detectedAt: nowIso,
            repository: entry.repository,
            serviceId: entry.service_id,
          }),
        );
      }
      continue;
    }
    states.push(evaluateEntry(entry, grouped.get(policyKey(entry)) ?? [], nowIso, addFinding));
  }

  for (const [key, records] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (policyEntries.has(key)) continue;
    const latestRecord = [...records].sort(
      (a, b) => Date.parse(a.snapshot.observed_at) - Date.parse(b.snapshot.observed_at),
    ).at(-1);
    const snapshot = latestRecord.snapshot;
    addFinding(
      createFinding({
        ruleId: "unknown-service-id",
        checkId: `unknown-service-id-${snapshot.quota_type}`,
        severity: "failure",
        summary: `${snapshot.service_id}/${snapshot.quota_type} is not declared in cost policy.`,
        location: latestRecord.location,
        detectedAt: nowIso,
        serviceId: snapshot.service_id,
      }),
    );
    const unknown = emptyState(
      {
        service_id: snapshot.service_id,
        repository: "AtlasReaper311/atlas-quota-watch",
        provider: snapshot.provider,
        quota_type: snapshot.quota_type,
        unit: null,
        free_tier_limit: null,
        projection_horizon_days: null,
        max_data_age_hours: null,
      },
      "unknown",
      latestRecord.location,
    );
    unknown.current_usage = snapshot.usage;
    unknown.evidence_timestamp = snapshot.observed_at;
    unknown.source_metadata = safeSourceMetadata(snapshot.source);
    unknown.confidence = snapshot.confidence;
    states.push(unknown);
  }

  states.sort((a, b) => a.state_key.localeCompare(b.state_key));
  const findings = [...findingsByFingerprint.values()].sort((a, b) =>
    a.fingerprint.localeCompare(b.fingerprint),
  );
  const findingsBySeverity = { info: 0, warning: 0, failure: 0, critical: 0 };
  findings.forEach((finding) => {
    findingsBySeverity[finding.severity] += 1;
  });
  const summary = {
    state: worstState(states.map((state) => state.state)),
    services_evaluated: states.length,
    active_policy_entries: policy.services.filter((entry) => entry.assurance.enabled).length,
    excluded_policy_entries: policy.services.filter((entry) => !entry.assurance.enabled).length,
    findings_total: findings.length,
    findings_by_severity: findingsBySeverity,
  };
  const notificationCandidates = buildNotificationCandidates(
    findings,
    findingContexts,
    states,
    previousReport,
    nowIso,
  );
  const evidenceEnvelope = buildEvidenceEnvelope(summary, states, findings, nowIso);
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: nowIso,
    advisory_only: true,
    source: {
      mode: sourceMode,
      network_access: false,
      provider_mutation: false,
    },
    summary,
    states,
    findings,
    notification_candidates: notificationCandidates,
    evidence_envelope: evidenceEnvelope,
  };
}

export function validateReportContracts(report, { findingSchema, evidenceSchema }) {
  const errors = [];
  if (findingSchema) {
    report.findings.forEach((finding, index) => {
      validateJsonSchema(finding, findingSchema).forEach((error) => {
        errors.push(`findings[${index}] ${error}`);
      });
    });
  }
  if (evidenceSchema) {
    validateJsonSchema(report.evidence_envelope, evidenceSchema).forEach((error) => {
      errors.push(`evidence_envelope ${error}`);
    });
  }
  return errors.sort();
}

function escapeMarkdown(value) {
  return String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdown(report) {
  const lines = [
    "# Cost guard report",
    "",
    `- Generated: ${report.generated_at}`,
    `- State: ${report.summary.state}`,
    `- Advisory only: ${report.advisory_only}`,
    `- Findings: ${report.summary.findings_total}`,
    "",
    "## Current states",
    "",
    "| Service | Quota | State | Used | Limit | Percent | Burn/day | Projection |",
    "|---|---|---|---:|---:|---:|---:|---|",
  ];
  for (const state of report.states) {
    lines.push(
      `| ${escapeMarkdown(state.service_id)} | ${escapeMarkdown(state.quota_type)} | ${state.state} | ${escapeMarkdown(state.current_usage)} | ${escapeMarkdown(state.quota_limit)} | ${escapeMarkdown(state.percentage_consumed)} | ${escapeMarkdown(state.burn_rate.selected_per_day)} | ${escapeMarkdown(state.projection.status)} |`,
    );
  }
  lines.push("", "## Findings", "");
  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of report.findings) {
      lines.push(
        `- **${finding.severity} / ${finding.rule_id}:** ${finding.evidence.summary} \`${finding.fingerprint}\``,
      );
    }
  }
  lines.push("", "## Dry-run notification decisions", "");
  if (report.notification_candidates.length === 0) {
    lines.push("No notification candidates.");
  } else {
    for (const candidate of report.notification_candidates) {
      lines.push(
        `- ${candidate.eligible ? "eligible" : "suppressed"}: ${candidate.finding_fingerprints.join(", ")} — ${candidate.reason}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
