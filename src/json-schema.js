/**
 * Dependency-free JSON Schema subset used by the offline cost guard.
 *
 * This is intentionally limited to the Draft 2020-12 keywords used by the
 * cost policy, quota snapshot, Finding, and EvidenceEnvelope contracts. It is
 * not presented as a general-purpose JSON Schema implementation.
 */

const UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function resolvePointer(root, pointer) {
  if (!pointer.startsWith("#/")) {
    throw new Error(`unsupported JSON Schema reference: ${pointer}`);
  }
  return pointer
    .slice(2)
    .split("/")
    .reduce(
      (current, rawPart) =>
        current[rawPart.replaceAll("~1", "/").replaceAll("~0", "~")],
      root,
    );
}

function typeMatches(value, expected) {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function formatErrors(value, format, path) {
  if (format === "date-time") {
    if (!UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
      return [`${path}: must be a valid UTC RFC 3339 timestamp ending in Z`];
    }
    return [];
  }
  if (format === "uri") {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        return [`${path}: must be an HTTPS URI without user information`];
      }
    } catch {
      return [`${path}: must be an HTTPS URI without user information`];
    }
    return [];
  }
  throw new Error(`unsupported JSON Schema format: ${format}`);
}

export function validateJsonSchema(
  value,
  schema,
  { rootSchema = schema, path = "$" } = {},
) {
  if (schema.$ref) {
    return validateJsonSchema(value, resolvePointer(rootSchema, schema.$ref), {
      rootSchema,
      path,
    });
  }

  const errors = [];
  const expectedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (
    expectedTypes.length > 0 &&
    !expectedTypes.some((expected) => typeMatches(value, expected))
  ) {
    return [`${path}: expected type ${expectedTypes.join(" or ")}`];
  }

  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0)) {
      errors.push(`${path}: is shorter than minLength`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: is longer than maxLength`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match required pattern`);
    }
    if (schema.format) errors.push(...formatErrors(value, schema.format, path));
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) {
      errors.push(`${path}: has fewer than minItems`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: has more than maxItems`);
    }
    if (schema.uniqueItems) {
      const values = value.map(canonicalJson);
      if (new Set(values).size !== values.length) {
        errors.push(`${path}: items must be unique`);
      }
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => {
        errors.push(
          ...validateJsonSchema(item, schema.items, {
            rootSchema,
            path: `${path}[${index}]`,
          }),
        );
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${path}: missing required property ${JSON.stringify(required)}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (schema.properties?.[key]) {
        errors.push(
          ...validateJsonSchema(child, schema.properties[key], {
            rootSchema,
            path: childPath,
          }),
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: additional property ${JSON.stringify(key)} is not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        errors.push(
          ...validateJsonSchema(child, schema.additionalProperties, {
            rootSchema,
            path: childPath,
          }),
        );
      }
    }
  }

  for (const child of schema.allOf ?? []) {
    errors.push(...validateJsonSchema(value, child, { rootSchema, path }));
  }
  if (schema.anyOf) {
    const candidates = schema.anyOf.map((child) =>
      validateJsonSchema(value, child, { rootSchema, path }),
    );
    if (!candidates.some((candidate) => candidate.length === 0)) {
      errors.push(`${path}: does not satisfy anyOf`);
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (child) => validateJsonSchema(value, child, { rootSchema, path }).length === 0,
    ).length;
    if (matches !== 1) errors.push(`${path}: must satisfy exactly one oneOf branch`);
  }
  if (schema.if) {
    const condition = validateJsonSchema(value, schema.if, { rootSchema, path });
    const branch = condition.length === 0 ? schema.then : schema.else;
    if (branch) errors.push(...validateJsonSchema(value, branch, { rootSchema, path }));
  }

  return errors;
}
