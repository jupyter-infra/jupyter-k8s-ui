import { describe, expect, test } from 'bun:test';
import { handleGetCrdSchema } from '../handlers/crd-schema';
import { getSpecSchema, isCrdKey, __resetSchemaStore } from '../schema/store';

describe('isCrdKey', () => {
  test('accepts the three registered CRD keys', () => {
    expect(isCrdKey('workspaces')).toBe(true);
    expect(isCrdKey('workspacetemplates')).toBe(true);
    expect(isCrdKey('workspaceaccessstrategies')).toBe(true);
  });

  test('rejects unknown keys (guards the endpoint path param)', () => {
    expect(isCrdKey('pods')).toBe(false);
    expect(isCrdKey('../etc/passwd')).toBe(false);
    expect(isCrdKey('')).toBe(false);
  });
});

describe('getSpecSchema — lazy vendored fallback', () => {
  test('seeds from the vendored schema when the store is empty', () => {
    __resetSchemaStore();
    const schema = getSpecSchema('workspaces') as { properties?: Record<string, unknown> };
    expect(schema).not.toBeNull();
    // Vendored workspaces spec schema carries the well-known top-level fields.
    expect(schema.properties?.image).toBeDefined();
    expect(schema.properties?.desiredStatus).toBeDefined();
  });
});

describe('handleGetCrdSchema', () => {
  test('404s for an unknown CRD key', async () => {
    const res = handleGetCrdSchema('nope');
    expect(res.status).toBe(404);
  });

  test('returns the spec schema JSON for a known CRD', async () => {
    __resetSchemaStore();
    const res = handleGetCrdSchema('workspaces');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { properties?: Record<string, unknown> };
    expect(body.properties?.resources).toBeDefined();
  });
});
