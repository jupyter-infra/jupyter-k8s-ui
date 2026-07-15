// Normalize a Kubernetes CRD `openAPIV3Schema` into something monaco-yaml /
// yaml-language-server (which speak JSON Schema draft-07) can consume.
//
// K8s "structural schemas" are OpenAPI-v3-flavored, not plain JSON Schema, so a
// handful of constructs need translating before the editor's language service can
// give useful completions/validation:
//
//   - `x-kubernetes-int-or-string: true`  -> `{ type: ["integer","string"] }`
//     (these nodes carry NO `type` of their own, so without this a validator sees
//     "no constraint" and can't complete/validate them — e.g. resource quantities)
//   - `nullable: true`                    -> fold "null" into `type`
//   - `x-kubernetes-*` vendor keys        -> dropped (unknown to JSON Schema; CEL in
//     `x-kubernetes-validations` is covered authoritatively by the dry-run layer)
//
// This is deliberately best-effort: the goal is sane editor guidance on the common
// fields, not full fidelity across the embedded pod-spec. The server dry-run is the
// authoritative safety net, so anything this pass gets wrong is only cosmetic.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
// A normalized schema is just JSON we serialize to the client — model it as JsonValue.
export type JsonSchema = JsonValue;

// Vendor extension keys that JSON Schema doesn't understand. Stripped so they don't
// linger in the shipped schema. `x-kubernetes-int-or-string` is handled specially
// (it changes `type`), so it is NOT in this drop-list.
const X_KUBERNETES_DROP_KEYS = new Set([
  'x-kubernetes-validations',
  'x-kubernetes-preserve-unknown-fields',
  'x-kubernetes-list-type',
  'x-kubernetes-list-map-keys',
  'x-kubernetes-map-type',
  'x-kubernetes-embedded-resource',
]);

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively normalize a CRD OpenAPI schema node into JSON Schema draft-07.
 * Pure — returns a new tree, never mutates its input.
 */
export function normalizeOpenAPISchema(node: JsonValue): JsonValue {
  if (Array.isArray(node)) {
    return node.map(normalizeOpenAPISchema);
  }
  if (!isObject(node)) {
    return node;
  }

  const out: Record<string, JsonValue> = {};

  // int-or-string: give the node a concrete type union so it validates/completes.
  const isIntOrString = node['x-kubernetes-int-or-string'] === true;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'x-kubernetes-int-or-string') continue; // handled below
    if (X_KUBERNETES_DROP_KEYS.has(key)) continue;
    if (key === 'nullable') continue; // folded into `type` below
    out[key] = normalizeOpenAPISchema(value);
  }

  if (isIntOrString) {
    out.type = ['integer', 'string'];
  }

  // nullable: true  ->  add "null" to the type (draft-07 has no `nullable` keyword)
  if (node.nullable === true && !isIntOrString) {
    const t = out.type;
    if (typeof t === 'string') {
      out.type = [t, 'null'];
    } else if (Array.isArray(t) && !t.includes('null')) {
      out.type = [...t, 'null'];
    }
    // if there's no `type`, dropping `nullable` is the right no-op
  }

  return out;
}

/**
 * Extract the `spec` sub-schema from a full CRD `openAPIV3Schema` and normalize it.
 *
 * The editor buffer holds only the CR `spec`, so we hand monaco-yaml just
 * `properties.spec` rather than the whole object (which would carry
 * `status`/`metadata`/`apiVersion` noise). Falls back to normalizing the whole schema
 * if there is no `spec` property (defensive — shouldn't happen for our CRDs).
 */
export function extractSpecSchema(openAPIV3Schema: JsonValue): JsonValue {
  if (isObject(openAPIV3Schema) && isObject(openAPIV3Schema.properties)) {
    const spec = openAPIV3Schema.properties.spec;
    if (spec !== undefined) {
      return normalizeOpenAPISchema(spec);
    }
  }
  return normalizeOpenAPISchema(openAPIV3Schema);
}
