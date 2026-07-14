#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateCostGuard,
  renderMarkdown,
  SNAPSHOT_SET_SCHEMA_VERSION,
  validatePolicy,
  validateReportContracts,
  validateSnapshot,
} from "../src/cost-guard.js";
import { validateJsonSchema } from "../src/json-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INFRA_ROOT = resolve(ROOT, "..", "atlas-infra");

function usage() {
  return `Usage:
  node scripts/cost-guard.js --policy <path> --fixture <file> [options]
  node scripts/cost-guard.js --policy <path> --snapshots <directory> [options]

Inputs:
  --policy <path>            Cost-guard policy JSON (defaults to sibling atlas-infra)
  --fixture <path>           One offline snapshot or snapshot-set fixture
  --snapshots <directory>    Directory of local JSON snapshots/sets
  --previous-report <path>   Prior JSON report for cooldown/deduplication
  --now <UTC timestamp>      Evaluation time; fixture sets may declare evaluation_time

Validation/actions:
  --validate-policy          Validate policy and exit
  --validate-snapshots       Validate every snapshot and exit
  --state                    Print calculated current states
  --projections              Print calculated projections
  --emit-findings            Print Finding-compatible records

Outputs:
  --report <path>            Write deterministic JSON report
  --markdown <path>          Write deterministic Markdown report

Contract overrides:
  --policy-schema <path>
  --snapshot-schema <path>
  --finding-schema <path>
  --evidence-schema <path>

The command reads local files only. It never sends notifications, creates
issues, calls a provider, changes billing, deploys, or mutates configuration.
`;
}

function parseArgs(argv) {
  const flags = new Set([
    "--help",
    "--validate-policy",
    "--validate-snapshots",
    "--state",
    "--projections",
    "--emit-findings",
  ]);
  const values = new Set([
    "--policy",
    "--fixture",
    "--snapshots",
    "--previous-report",
    "--now",
    "--report",
    "--markdown",
    "--policy-schema",
    "--snapshot-schema",
    "--finding-schema",
    "--evidence-schema",
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      parsed[argument.slice(2).replaceAll("-", "_")] = true;
    } else if (values.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      parsed[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (parsed.fixture && parsed.snapshots) {
    throw new Error("choose either --fixture or --snapshots, not both");
  }
  return parsed;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read JSON ${path}: ${error.message}`);
  }
}

function optionalSchema(path) {
  return existsSync(path) ? readJson(path) : null;
}

function recordsFromDocument(document, name) {
  if (document?.schema_version === SNAPSHOT_SET_SCHEMA_VERSION) {
    if (!Array.isArray(document.snapshots)) {
      throw new Error(`${name}: snapshot set must contain a snapshots array`);
    }
    return {
      evaluationTime: document.evaluation_time ?? null,
      records: document.snapshots.map((snapshot, index) => ({
        snapshot,
        location: `${name.replace(/\.json$/i, "")}-${String(index + 1).padStart(3, "0")}.json`,
      })),
    };
  }
  return {
    evaluationTime: null,
    records: [{ snapshot: document, location: name }],
  };
}

function loadSnapshotInput(options) {
  if (options.fixture) {
    const path = resolve(options.fixture);
    return recordsFromDocument(readJson(path), path.split(/[\\/]/).at(-1));
  }
  if (options.snapshots) {
    const directory = resolve(options.snapshots);
    if (!statSync(directory).isDirectory()) {
      throw new Error(`--snapshots is not a directory: ${directory}`);
    }
    const aggregate = { evaluationTime: null, records: [] };
    for (const name of readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
      const loaded = recordsFromDocument(readJson(join(directory, name)), name);
      if (loaded.evaluationTime) {
        if (aggregate.evaluationTime && aggregate.evaluationTime !== loaded.evaluationTime) {
          throw new Error("snapshot sets declare conflicting evaluation_time values");
        }
        aggregate.evaluationTime = loaded.evaluationTime;
      }
      aggregate.records.push(...loaded.records);
    }
    return aggregate;
  }
  return { evaluationTime: null, records: [] };
}

function resolveInput(path, fallback) {
  if (!path) return fallback;
  return isAbsolute(path) ? path : resolve(path);
}

function validatePolicyInput(policy, policySchema) {
  const errors = validatePolicy(policy);
  if (policySchema) errors.push(...validateJsonSchema(policy, policySchema));
  return [...new Set(errors)].sort();
}

function validateSnapshotInput(records, snapshotSchema) {
  const errors = [];
  records.forEach((record, index) => {
    validateSnapshot(record.snapshot).forEach((error) => {
      errors.push(`${record.location} [${index}] ${error}`);
    });
    if (snapshotSchema) {
      validateJsonSchema(record.snapshot, snapshotSchema).forEach((error) => {
        errors.push(`${record.location} [${index}] ${error}`);
      });
    }
  });
  return [...new Set(errors)].sort();
}

function writeOrPrint(value, path) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (path) writeFileSync(path, rendered, "utf8");
  else process.stdout.write(rendered);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const policyPath = resolveInput(
    options.policy,
    join(INFRA_ROOT, "policy", "cost-guard.json"),
  );
  const policySchemaPath = resolveInput(
    options.policy_schema,
    join(INFRA_ROOT, "policy", "cost-guard.schema.json"),
  );
  const snapshotSchemaPath = resolveInput(
    options.snapshot_schema,
    join(ROOT, "schemas", "quota-snapshot.schema.json"),
  );
  const findingSchemaPath = resolveInput(
    options.finding_schema,
    join(INFRA_ROOT, "contracts", "v1", "finding.schema.json"),
  );
  const evidenceSchemaPath = resolveInput(
    options.evidence_schema,
    join(INFRA_ROOT, "contracts", "v1", "evidence-envelope.schema.json"),
  );

  const policy = readJson(policyPath);
  const policySchema = optionalSchema(policySchemaPath);
  const policyErrors = validatePolicyInput(policy, policySchema);
  if (options.validate_policy) {
    writeOrPrint(
      {
        valid: policyErrors.length === 0,
        policy: policyPath,
        schema: policySchema ? policySchemaPath : null,
        errors: policyErrors,
      },
      null,
    );
    return policyErrors.length === 0 ? 0 : 1;
  }
  if (policyErrors.length > 0) {
    throw new Error(`policy validation failed: ${policyErrors.join("; ")}`);
  }

  const loaded = loadSnapshotInput(options);
  if (loaded.records.length === 0) {
    throw new Error("--fixture or --snapshots is required for this action");
  }
  const snapshotSchema = optionalSchema(snapshotSchemaPath);
  const snapshotErrors = validateSnapshotInput(loaded.records, snapshotSchema);
  if (options.validate_snapshots) {
    writeOrPrint(
      {
        valid: snapshotErrors.length === 0,
        snapshots_checked: loaded.records.length,
        schema: snapshotSchema ? snapshotSchemaPath : null,
        errors: snapshotErrors,
      },
      null,
    );
    return snapshotErrors.length === 0 ? 0 : 1;
  }

  const evaluationTime = options.now ?? loaded.evaluationTime;
  if (!evaluationTime) {
    throw new Error("--now or fixture evaluation_time is required for deterministic output");
  }
  if (Number.isNaN(Date.parse(evaluationTime)) || !evaluationTime.endsWith("Z")) {
    throw new Error("evaluation time must be a UTC RFC 3339 timestamp ending in Z");
  }
  const previousReport = options.previous_report
    ? readJson(resolve(options.previous_report))
    : null;
  const report = evaluateCostGuard({
    policy,
    snapshots: loaded.records,
    now: evaluationTime,
    previousReport,
    sourceMode: options.fixture ? "fixture" : "snapshot-directory",
  });
  const contractErrors = validateReportContracts(report, {
    findingSchema: optionalSchema(findingSchemaPath),
    evidenceSchema: optionalSchema(evidenceSchemaPath),
  });
  if (contractErrors.length > 0) {
    throw new Error(`Phase 1 contract validation failed: ${contractErrors.join("; ")}`);
  }

  if (options.report) writeOrPrint(report, resolve(options.report));
  if (options.markdown) {
    writeFileSync(resolve(options.markdown), renderMarkdown(report), "utf8");
  }
  if (options.state) writeOrPrint(report.states, null);
  else if (options.projections) {
    writeOrPrint(
      report.states.map((state) => ({
        state_key: state.state_key,
        burn_rate: state.burn_rate,
        projection: state.projection,
        acceleration: state.acceleration,
      })),
      null,
    );
  } else if (options.emit_findings) writeOrPrint(report.findings, null);
  else if (!options.report && !options.markdown) writeOrPrint(report, null);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`cost-guard: ${error.message}\n`);
  process.exitCode = 1;
}
