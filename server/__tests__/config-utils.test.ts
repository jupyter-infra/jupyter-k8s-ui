import { describe, test, expect } from 'bun:test';
import { parseIntSafe, parseCsv } from '../k8s/config';

// Pure env-parsing helpers behind the namespaceSelection/session config. Each test targets
// a distinct branch: a bug in that branch (and only that branch) fails exactly one test.
// declaredNamespaces has its own suite (declared-namespaces.test.ts).

describe('parseIntSafe', () => {
  test('parses a valid non-negative integer', () => {
    expect(parseIntSafe('42', 7)).toBe(42);
  });

  test('accepts 0 (the >= 0 boundary, not > 0)', () => {
    expect(parseIntSafe('0', 7)).toBe(0);
  });

  test('undefined → fallback', () => {
    expect(parseIntSafe(undefined, 7)).toBe(7);
  });

  test('empty string → fallback', () => {
    expect(parseIntSafe('', 7)).toBe(7);
  });

  test('non-numeric → fallback', () => {
    expect(parseIntSafe('abc', 7)).toBe(7);
  });

  test('negative → fallback (never a negative cap/timeout)', () => {
    expect(parseIntSafe('-5', 7)).toBe(7);
  });

  test('parses the leading integer of a mixed value (parseInt semantics)', () => {
    expect(parseIntSafe('20px', 7)).toBe(20);
  });
});

describe('parseCsv', () => {
  test('splits on commas', () => {
    expect(parseCsv('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  test('trims surrounding whitespace on each entry', () => {
    expect(parseCsv(' a , b ,c ')).toEqual(['a', 'b', 'c']);
  });

  test('drops blank / whitespace-only entries (trailing comma, double comma)', () => {
    expect(parseCsv('a,,b, ,')).toEqual(['a', 'b']);
  });

  test('de-duplicates, keeping first occurrence', () => {
    expect(parseCsv('a,b,a')).toEqual(['a', 'b']);
  });

  test('undefined → empty list', () => {
    expect(parseCsv(undefined)).toEqual([]);
  });

  test('empty string → empty list', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
