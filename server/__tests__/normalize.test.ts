import { describe, expect, test } from 'bun:test';
import { normalizeOpenAPISchema, extractSpecSchema } from '../schema/normalize';

describe('normalizeOpenAPISchema', () => {
  test('translates x-kubernetes-int-or-string to a type union', () => {
    const out = normalizeOpenAPISchema({ 'x-kubernetes-int-or-string': true }) as Record<string, unknown>;
    expect(out.type).toEqual(['integer', 'string']);
    expect(out['x-kubernetes-int-or-string']).toBeUndefined();
  });

  test('folds nullable:true into a string type', () => {
    const out = normalizeOpenAPISchema({ type: 'string', nullable: true }) as Record<string, unknown>;
    expect(out.type).toEqual(['string', 'null']);
    expect(out.nullable).toBeUndefined();
  });

  test('folds nullable:true into an existing type array without duplicating null', () => {
    const out = normalizeOpenAPISchema({ type: ['string', 'null'], nullable: true }) as Record<string, unknown>;
    expect(out.type).toEqual(['string', 'null']);
  });

  test('drops nullable when there is no type (no-op, no null leaked)', () => {
    const out = normalizeOpenAPISchema({ nullable: true, description: 'x' }) as Record<string, unknown>;
    expect(out.type).toBeUndefined();
    expect(out.nullable).toBeUndefined();
  });

  test('drops x-kubernetes-validations (CEL — covered by dry-run)', () => {
    const out = normalizeOpenAPISchema({
      type: 'object',
      'x-kubernetes-validations': [{ rule: 'self == oldSelf' }],
    }) as Record<string, unknown>;
    expect(out['x-kubernetes-validations']).toBeUndefined();
    expect(out.type).toBe('object');
  });

  test('drops other x-kubernetes-* vendor keys', () => {
    const out = normalizeOpenAPISchema({
      type: 'array',
      'x-kubernetes-list-type': 'map',
      'x-kubernetes-list-map-keys': ['name'],
      'x-kubernetes-preserve-unknown-fields': true,
    }) as Record<string, unknown>;
    expect(out['x-kubernetes-list-type']).toBeUndefined();
    expect(out['x-kubernetes-list-map-keys']).toBeUndefined();
    expect(out['x-kubernetes-preserve-unknown-fields']).toBeUndefined();
    expect(out.type).toBe('array');
  });

  test('recurses into nested properties and array items', () => {
    const out = normalizeOpenAPISchema({
      type: 'object',
      properties: {
        limits: {
          type: 'object',
          additionalProperties: { 'x-kubernetes-int-or-string': true },
        },
        tags: { type: 'array', items: { type: 'string', nullable: true } },
      },
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    expect(out.properties.limits.additionalProperties.type).toEqual(['integer', 'string']);
    expect(out.properties.tags.items.type).toEqual(['string', 'null']);
  });

  test('preserves enums and descriptions untouched', () => {
    const out = normalizeOpenAPISchema({
      type: 'string',
      enum: ['Running', 'Stopped'],
      description: 'desired status',
    }) as Record<string, unknown>;
    expect(out.enum).toEqual(['Running', 'Stopped']);
    expect(out.description).toBe('desired status');
  });

  test('leaves primitives and arrays without schema keywords intact', () => {
    expect(normalizeOpenAPISchema('hello')).toBe('hello');
    expect(normalizeOpenAPISchema(42)).toBe(42);
    expect(normalizeOpenAPISchema([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('extractSpecSchema', () => {
  test('returns the normalized spec sub-schema when present', () => {
    const out = extractSpecSchema({
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          properties: { cpu: { 'x-kubernetes-int-or-string': true } },
        },
        status: { type: 'object' },
      },
    }) as Record<string, Record<string, Record<string, unknown>>>;
    // spec content is lifted and normalized
    expect(out.properties.cpu.type).toEqual(['integer', 'string']);
    // status is not present in the extracted spec schema
    expect(out.properties.status).toBeUndefined();
  });

  test('falls back to normalizing the whole schema when there is no spec property', () => {
    const out = extractSpecSchema({
      type: 'object',
      properties: { foo: { type: 'string', nullable: true } },
    }) as Record<string, Record<string, Record<string, unknown>>>;
    expect(out.properties.foo.type).toEqual(['string', 'null']);
  });
});
