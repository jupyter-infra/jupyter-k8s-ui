import { describe, expect, test } from 'bun:test';
import {
  clamp,
  parseQuantity,
  parseResourceValue,
  parseMemoryGi,
  parseCpuCores,
  isOwner,
  getWorkspaceState,
  isValidK8sName,
  sanitizeK8sName,
  getStatusColor,
  getStatusText,
} from './workspace';

describe('clamp', () => {
  test.each([
    [-5, 0, 10, 0],
    [20, 0, 10, 10],
    [5, 0, 10, 5],
    [5, 3, 3, 3],
  ])('clamp(%s, %s, %s) → %s', (v, lo, hi, expected) => {
    expect(clamp(v, lo, hi)).toBe(expected);
  });
});

describe('parseQuantity', () => {
  // One example per suffix class — each exercises a distinct branch of the suffix map
  test.each([
    ['42', 42, 'plain number'],
    ['0.5', 0.5, 'decimal'],
    ['500m', 0.5, 'decimal sub-unit'],
    ['1k', 1000, 'decimal prefix'],
    ['1Ki', 1024, 'binary prefix'],
    ['2Gi', 2 * 1024 ** 3, 'binary Gi'],
    ['  2Gi  ', 2 * 1024 ** 3, 'whitespace trimmed'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(parseQuantity(input)).toBe(expected);
  });

  // Longest-first suffix matching is the one tricky invariant — test directly.
  test('matches Ki before k (longest-suffix-first)', () => {
    expect(parseQuantity('1Ki')).toBe(1024);
    expect(parseQuantity('1k')).toBe(1000);
  });

  test.each(['', '  ', 'abc', 'Gi'])('returns null for invalid input: "%s"', (input) => {
    expect(parseQuantity(input)).toBeNull();
  });
});

describe('parseResourceValue / parseMemoryGi / parseCpuCores', () => {
  // These are thin wrappers over parseQuantity. One happy-path + one fallback each.
  test('parseResourceValue returns parsed value or fallback', () => {
    expect(parseResourceValue('500m', 1)).toBe(0.5);
    expect(parseResourceValue(undefined, 2)).toBe(2);
    expect(parseResourceValue('abc', 3)).toBe(3);
  });

  test('parseMemoryGi converts bytes to GiB', () => {
    expect(parseMemoryGi('512Mi', 0)).toBe(0.5);
    expect(parseMemoryGi(undefined, 4)).toBe(4);
  });

  test('parseCpuCores parses millicores to cores', () => {
    expect(parseCpuCores('500m', 0)).toBe(0.5);
    expect(parseCpuCores(undefined, 1)).toBe(1);
  });
});

describe('isOwner', () => {
  // Each branch represents a different OIDC provider format seen in the wild.
  test.each([
    ['alice', 'alice', true, 'exact'],
    ['github:alice', 'alice', true, 'github: prefix'],
    ['dex/alice', 'alice', true, 'provider/user'],
    ['oidc:alice', 'alice', true, 'provider:user'],
    ['alice', 'bob', false, 'mismatch'],
    [undefined, 'alice', false, 'missing owner'],
    ['alice', undefined, false, 'missing username'],
  ])('isOwner(%s, %s) → %s (%s)', (owner, user, expected) => {
    expect(isOwner(owner, user)).toBe(expected);
  });
});

describe('getWorkspaceState', () => {
  test('running + Available=True → isAvailable, not pending', () => {
    const s = getWorkspaceState({
      spec: { desiredStatus: 'Running' },
      status: { conditions: [{ type: 'Available', status: 'True' }] },
    });
    expect(s).toMatchObject({ isRunning: true, isAvailable: true, isPending: false, isStopped: false });
  });

  test('running + Progressing=True → pending', () => {
    const s = getWorkspaceState({
      spec: { desiredStatus: 'Running' },
      status: { conditions: [{ type: 'Progressing', status: 'True' }] },
    });
    expect(s).toMatchObject({ isPending: true, isProgressing: true, isAvailable: false });
  });

  test('stopped + no Progressing → isStopped', () => {
    const s = getWorkspaceState({ spec: { desiredStatus: 'Stopped' }, status: { conditions: [] } });
    expect(s.isStopped).toBe(true);
  });

  // Edge case: "stopping" — desired Stopped but controller still shutting down.
  // Must NOT report isStopped, or UI would claim work is done prematurely.
  test('stopped + Progressing=True → NOT yet stopped', () => {
    const s = getWorkspaceState({
      spec: { desiredStatus: 'Stopped' },
      status: { conditions: [{ type: 'Progressing', status: 'True' }] },
    });
    expect(s.isStopped).toBe(false);
    expect(s.isProgressing).toBe(true);
  });

  test('handles missing status object', () => {
    const s = getWorkspaceState({ spec: { desiredStatus: 'Running' } });
    expect(s.isAvailable).toBe(false);
  });
});

describe('isValidK8sName', () => {
  test.each(['my-workspace', 'a', 'ws1', 'a'.repeat(63)])('accepts: %s', (name) => {
    expect(isValidK8sName(name)).toBe(true);
  });

  test.each([
    ['', 'empty'],
    ['UPPER', 'uppercase'],
    ['-start', 'leading hyphen'],
    ['end-', 'trailing hyphen'],
    ['under_score', 'underscore'],
    ['a'.repeat(64), '64 chars (over 63 limit)'],
  ])('rejects: %s (%s)', (name) => {
    expect(isValidK8sName(name)).toBe(false);
  });
});

describe('sanitizeK8sName', () => {
  test('lowercases and keeps only [a-z0-9-]', () => {
    expect(sanitizeK8sName('My Workspace!')).toBe('myworkspace');
    expect(sanitizeK8sName('Foo_Bar.Baz')).toBe('foobarbaz');
    expect(sanitizeK8sName('my-ws-123')).toBe('my-ws-123');
  });
});

describe('getStatusColor / getStatusText', () => {
  // These are a 3-way branch on (running, available, pending). Exhaustive == 3 cases.
  test.each([
    [true, true, false, 'var(--color-success)', 'Running'],
    [true, false, true, 'var(--color-warning)', 'Starting'],
    [false, false, false, 'var(--color-neutral)', 'Stopped'],
  ])('running=%s available=%s pending=%s → %s / %s', (run, avail, pending, color, text) => {
    expect(getStatusColor(run, avail, pending)).toBe(color);
    expect(getStatusText(run, avail, pending)).toBe(text);
  });
});
