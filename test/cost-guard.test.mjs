import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  evaluateCostGuard,
  renderMarkdown,
  validatePolicy,
  validateReportContracts,
  validateSnapshot,
} from "../src/cost-guard.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures", "cost");
const INFRA_ROOT = resolve(ROOT, "..", "atlas-infra");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadPolicy() {
  return loadJson(join(FIXTURES, "policy.json"));
}

function loadFixture(name) {
  const fixture = loadJson(join(FIXTURES, name));
  return {
    now: fixture.evaluation_time,
    records: fixture.snapshots.map((snapshot, index) => ({
      snapshot,
      location: `${name.replace(/\.json$/, "")}-${index + 1}.json`,
    })),
  };
}

function evaluate(name, { policy = loadPolicy(), previousReport = null } = {}) {
  const fixture = loadFixture(name);
  const declaredKeys = new Set(
    policy.services.map(
      (service) => `${service.service_id}:${service.provider}:${service.quota_type}`,
    ),
  );
  const scopedRecords = fixture.records.filter((record) => {
    const snapshot = record.snapshot;
    if (!snapshot?.service_id || !snapshot?.provider || !snapshot?.quota_type) return true;
    return declaredKeys.has(
      `${snapshot.service_id}:${snapshot.provider}:${snapshot.quota_type}`,
    );
  });
  return evaluateCostGuard({
    policy,
    snapshots: scopedRecords,
    now: fixture.now,
    previousReport,
  });
}

function workerRecords(name) {
  return loadFixture(name).records.filter(
    (record) => record.snapshot.quota_type === "workers-requests",
  );
}

test("valid policy is accepted and malformed policy is rejected", () => {
  assert.deepEqual(validatePolicy(loadPolicy()), []);
  assert.ok(validatePolicy(loadJson(join(FIXTURES, "policy.malformed.json"))).length > 0);
});

test("healthy usage stays healthy and has fixed and rolling burn", () => {
  const report = evaluate("healthy.json", {
    policy: loadPolicy(),
  });
  assert.equal(report.summary.state, "healthy");
  assert.equal(report.states[0].state, "healthy");
  assert.equal(report.states[0].burn_rate.selected_method, "rolling-window");
  assert.ok(report.states[0].burn_rate.fixed_window_per_day > 0);
  assert.equal(report.states[0].projection.history_status, "sufficient");
});

test("warning and critical thresholds emit distinct findings", () => {
  const warning = evaluate("warning.json");
  assert.equal(warning.summary.state, "warning");
  assert.ok(warning.findings.some((finding) => finding.rule_id === "warning-threshold-exceeded"));

  const critical = evaluate("critical.json");
  assert.equal(critical.summary.state, "failed");
  assert.ok(
    critical.findings.some(
      (finding) =>
        finding.rule_id === "critical-threshold-exceeded" &&
        finding.severity === "critical",
    ),
  );
});

test("projected exhaustion inside the horizon emits a finding", () => {
  const report = evaluate("projected-exhaustion.json");
  const state = report.states[0];
  assert.equal(state.state, "warning");
  assert.ok(state.projection.days_until_exhaustion <= 7);
  assert.ok(report.findings.some((finding) => finding.rule_id === "projected-exhaustion"));
});

test("insufficient history remains explicit and unknown", () => {
  const report = evaluate("insufficient-history.json");
  assert.equal(report.states[0].state, "unknown");
  assert.equal(report.states[0].projection.status, "insufficient-history");
  assert.equal(report.states[0].projection.history_status, "insufficient-history");
});

test("acceleration compares adjacent intervals without statistical claims", () => {
  const report = evaluate("acceleration.json");
  assert.equal(report.states[0].acceleration.status, "compared");
  assert.equal(report.states[0].acceleration.detected, true);
  assert.equal(report.states[0].state, "warning");
  assert.ok(report.findings.some((finding) => finding.rule_id === "usage-acceleration"));
});

test("stale, unavailable, and malformed input are never healthy", () => {
  const stale = evaluate("stale.json");
  assert.equal(stale.summary.state, "stale");
  assert.ok(stale.findings.some((finding) => finding.rule_id === "stale-quota-data"));

  const unavailable = evaluate("unavailable.json");
  assert.equal(unavailable.summary.state, "unavailable");
  assert.ok(
    unavailable.findings.some((finding) => finding.rule_id === "unavailable-quota-data"),
  );

  const malformed = evaluate("malformed.json");
  assert.equal(malformed.summary.state, "failed");
  assert.ok(
    malformed.findings.some((finding) => finding.rule_id === "malformed-quota-snapshot"),
  );
});

test("missing owner and missing limit produce unknown cost state", () => {
  const ownerPolicy = loadPolicy();
  ownerPolicy.services[0].owner = null;
  const ownerReport = evaluate("healthy.json", { policy: ownerPolicy });
  assert.equal(ownerReport.states[0].state, "unknown");
  assert.ok(ownerReport.findings.some((finding) => finding.rule_id === "missing-policy-owner"));

  const limitPolicy = loadPolicy();
  limitPolicy.services[0].free_tier_limit = null;
  const limitReport = evaluate("healthy.json", { policy: limitPolicy });
  assert.equal(limitReport.states[0].state, "unknown");
  assert.ok(limitReport.findings.some((finding) => finding.rule_id === "missing-quota-limit"));
});

test("unknown service and classification conflict are explicit findings", () => {
  const fixture = loadFixture("healthy.json");
  const unknownRecords = workerRecords("healthy.json").map((record) => ({
    ...record,
    snapshot: { ...record.snapshot, service_id: "unknown-service" },
  }));
  const unknown = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: unknownRecords,
    now: fixture.now,
  });
  assert.ok(unknown.findings.some((finding) => finding.rule_id === "unknown-service-id"));
  assert.notEqual(unknown.summary.state, "healthy");

  const conflictRecords = workerRecords("healthy.json").map((record) => ({
    ...record,
    snapshot: {
      ...record.snapshot,
      classification: { ...record.snapshot.classification, scope: "internal" },
    },
  }));
  const conflict = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: conflictRecords,
    now: fixture.now,
  });
  assert.equal(conflict.states[0].state, "failed");
  assert.ok(conflict.findings.some((finding) => finding.rule_id === "classification-conflict"));
});

test("simple-proxy exclusion is visible but does not degrade the active aggregate", () => {
  const report = evaluate("healthy.json");
  assert.equal(report.summary.state, "healthy");
  const finding = report.findings.find(
    (candidate) => candidate.rule_id === "simple-proxy-exclusion",
  );
  assert.equal(finding.severity, "info");
  assert.equal(finding.subject.service_id, "simple-proxy");
});

test("fingerprints and sorted output are deterministic", () => {
  const fixture = loadFixture("warning.json");
  const first = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: fixture.records,
    now: fixture.now,
  });
  const second = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: [...fixture.records].reverse(),
    now: fixture.now,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.findings.map((finding) => finding.fingerprint),
    [...first.findings.map((finding) => finding.fingerprint)].sort(),
  );
});

test("cooldown suppresses duplicates and every action remains advisory-only", () => {
  const first = evaluate("warning.json");
  const fixture = loadFixture("warning.json");
  const second = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: fixture.records,
    now: "2026-07-14T13:00:00Z",
    previousReport: first,
  });
  assert.equal(first.notification_candidates.length, 1);
  assert.ok(first.notification_candidates.some((candidate) => candidate.eligible));
  assert.ok(second.notification_candidates.every((candidate) => !candidate.eligible));
  for (const candidate of second.notification_candidates) {
    assert.equal(candidate.dry_run, true);
    assert.equal(candidate.network_send, false);
    assert.equal(candidate.issue_creation, false);
    assert.equal(candidate.advisory_only, true);
  }
});

test("zero use has no projected exhaustion", () => {
  const fixture = loadFixture("healthy.json");
  const records = workerRecords("healthy.json").map((record) => ({
    ...record,
    snapshot: { ...record.snapshot, usage: 0 },
  }));
  const report = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: records,
    now: fixture.now,
  });
  assert.equal(report.states[0].state, "healthy");
  assert.equal(report.states[0].burn_rate.selected_per_day, 0);
  assert.equal(report.states[0].projection.days_until_exhaustion, null);
});

test("previous-period comparison and top contributors are bounded and sorted", () => {
  const fixture = loadFixture("healthy.json");
  const records = workerRecords("healthy.json").map((record, index, values) =>
    index === values.length - 1
      ? {
          ...record,
          snapshot: {
            ...record.snapshot,
            previous_period_usage: 250000,
            contributors: [
              { id: "worker-b", usage: 100000 },
              { id: "worker-a", usage: 150000 },
            ],
          },
        }
      : record,
  );
  const report = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: records,
    now: fixture.now,
  });
  assert.equal(report.states[0].previous_period_comparison.status, "compared");
  assert.equal(report.states[0].previous_period_comparison.change_pct, 20);
  assert.deepEqual(
    report.states[0].top_contributors.map((contributor) => contributor.id),
    ["worker-a", "worker-b"],
  );
  assert.ok(report.states[0].recommended_actions.length > 0);
});

test("rolling history does not cross a billing-period boundary", () => {
  const fixture = loadFixture("healthy.json");
  const current = workerRecords("healthy.json").slice(-2);
  const previous = {
    ...current[0],
    location: "previous-period.json",
    snapshot: {
      ...current[0].snapshot,
      observed_at: "2026-07-01T12:00:00Z",
      period_start: "2026-06-02T00:00:00Z",
      period_end: "2026-07-02T00:00:00Z",
      usage: 9000000,
    },
  };
  const report = evaluateCostGuard({
    policy: loadPolicy(),
    snapshots: [previous, ...current],
    now: fixture.now,
  });
  assert.equal(report.states[0].projection.history_status, "sufficient");
  assert.ok(report.states[0].burn_rate.rolling_window_per_day > 0);
});

test("timezone offsets and partial records are malformed", () => {
  const record = workerRecords("healthy.json")[0].snapshot;
  assert.ok(
    validateSnapshot({ ...record, observed_at: "2026-07-10T13:00:00+01:00" }).some(
      (error) => error.includes("observed_at"),
    ),
  );
  const partial = { ...record };
  delete partial.usage;
  assert.ok(validateSnapshot(partial).some((error) => error.includes("usage")));
  const unsafeMetadata = {
    ...record,
    source: { ...record.source, authorization: "redacted-fixture" },
  };
  assert.ok(
    validateSnapshot(unsafeMetadata).some((error) => error.includes("authorization")),
  );
});

test("Findings and EvidenceEnvelope validate against the canonical Phase 1 contracts", {
  skip: !existsSync(join(INFRA_ROOT, "contracts", "v1", "finding.schema.json")),
}, () => {
  const report = evaluate("warning.json");
  const findingSchema = loadJson(
    join(INFRA_ROOT, "contracts", "v1", "finding.schema.json"),
  );
  const evidenceSchema = loadJson(
    join(INFRA_ROOT, "contracts", "v1", "evidence-envelope.schema.json"),
  );
  assert.deepEqual(
    validateReportContracts(report, { findingSchema, evidenceSchema }),
    [],
  );

  const script = [
    "import json, pathlib, sys",
    `sys.path.insert(0, ${JSON.stringify(join(INFRA_ROOT, "scripts"))})`,
    "import control_plane_contracts as c",
    `root = pathlib.Path(${JSON.stringify(join(INFRA_ROOT, "contracts", "v1"))})`,
    "report = json.load(sys.stdin)",
    "rules = c.load_json(root / 'fingerprint-rules.json')",
    "errors = []",
    "for finding in report['findings']:",
    "    errors += c.validate_instance(finding, c.load_json(root / 'finding.schema.json'))",
    "    errors += c.semantic_errors('finding.schema.json', finding, rules)",
    "envelope = report['evidence_envelope']",
    "errors += c.validate_instance(envelope, c.load_json(root / 'evidence-envelope.schema.json'))",
    "errors += c.semantic_errors('evidence-envelope.schema.json', envelope, rules)",
    "print(json.dumps(errors))",
    "raise SystemExit(1 if errors else 0)",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script], {
    input: JSON.stringify(report),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout || result.stderr);
});

test("Markdown and JSON reports are generated idempotently by the offline CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-cost-guard-"));
  try {
    const jsonPath = join(directory, "report.json");
    const markdownPath = join(directory, "report.md");
    const args = [
      join(ROOT, "scripts", "cost-guard.js"),
      "--policy",
      join(FIXTURES, "policy.json"),
      "--fixture",
      join(FIXTURES, "warning.json"),
      "--report",
      jsonPath,
      "--markdown",
      markdownPath,
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstJson = readFileSync(jsonPath, "utf8");
    const firstMarkdown = readFileSync(markdownPath, "utf8");
    assert.equal(JSON.parse(firstJson).schema_version, "atlas-cost-guard/report/v1");
    assert.match(firstMarkdown, /# Cost guard report/);
    assert.equal(firstMarkdown, renderMarkdown(JSON.parse(firstJson)));

    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(jsonPath, "utf8"), firstJson);
    assert.equal(readFileSync(markdownPath, "utf8"), firstMarkdown);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
