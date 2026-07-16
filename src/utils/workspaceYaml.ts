// spec <-> YAML round-trip for the advanced editor.
//
// The editor buffer holds only the CR `spec`. We re-serialize from a JS object, so we
// do NOT rely on JS insertion order or the API server's ordering (roughly alphabetical,
// not guaranteed) — that reads oddly (accessType before displayName). Instead we emit
// a curated order for the common top-level fields, then everything else alphabetically.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { WorkspaceSpec } from '../types';

// Curated ordering for the common top-level spec fields. Anything not listed here is
// appended afterwards in alphabetical order (deterministic + stable across reloads).
const PREFERRED_KEY_ORDER = ['displayName', 'image', 'desiredStatus', 'accessType', 'ownershipType', 'resources', 'storage', 'idleShutdown', 'env'];

/**
 * Reorder an object's top-level keys: preferred keys first (in curated order),
 * then the remainder alphabetically. Returns a new object; does not mutate.
 */
export function orderSpecKeys(spec: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of PREFERRED_KEY_ORDER) {
    if (key in spec) ordered[key] = spec[key];
  }
  const rest = Object.keys(spec)
    .filter((k) => !PREFERRED_KEY_ORDER.includes(k))
    .sort();
  for (const key of rest) {
    ordered[key] = spec[key];
  }
  return ordered;
}

/** Serialize a spec object to YAML with stable, human-friendly key ordering. */
export function specToYaml(spec: Record<string, unknown>): string {
  return stringifyYaml(orderSpecKeys(spec), { indent: 2, lineWidth: 0 });
}

export interface ParseResult {
  spec: WorkspaceSpec | null;
  /** Human-readable YAML syntax error, or null when parsing succeeded. */
  error: string | null;
}

/**
 * Parse a YAML buffer into a spec object. Returns a structured result rather than
 * throwing, so the editor can show the syntax error inline. A buffer that parses to a
 * non-object (e.g. a bare scalar or a list) is treated as an error — the spec must be
 * a mapping.
 */
export function yamlToSpec(text: string): ParseResult {
  if (text.trim() === '') {
    return { spec: {}, error: null };
  }
  try {
    const parsed = parseYaml(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { spec: null, error: 'Workspace spec must be a YAML mapping (key: value pairs).' };
    }
    return { spec: parsed as WorkspaceSpec, error: null };
  } catch (err) {
    return { spec: null, error: err instanceof Error ? err.message : 'Invalid YAML' };
  }
}
