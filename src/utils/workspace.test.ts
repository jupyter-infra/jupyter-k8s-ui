import { describe, expect, test } from 'bun:test';
import {
  clamp,
  parseQuantity,
  parseResourceValue,
  parseMemoryGi,
  parseCpuCores,
  isOwner,
  getWorkspaceStatus,
  getStatusChipColor,
  isValidK8sName,
  sanitizeK8sName,
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

describe('getWorkspaceStatus', () => {
  test('Available=True → Running', () => {
    expect(getWorkspaceStatus({ spec: { desiredStatus: 'Running' }, status: { conditions: [{ type: 'Available', status: 'True' }] } })).toBe('Running');
  });

  test('Progressing=True + desiredStatus Running → Starting', () => {
    expect(getWorkspaceStatus({ spec: { desiredStatus: 'Running' }, status: { conditions: [{ type: 'Progressing', status: 'True' }] } })).toBe('Starting');
  });

  test('Progressing=True + desiredStatus Stopped → Stopping', () => {
    expect(getWorkspaceStatus({ spec: { desiredStatus: 'Stopped' }, status: { conditions: [{ type: 'Progressing', status: 'True' }] } })).toBe('Stopping');
  });

  test('Stopped=True → Stopped', () => {
    expect(getWorkspaceStatus({ spec: { desiredStatus: 'Stopped' }, status: { conditions: [{ type: 'Stopped', status: 'True' }] } })).toBe('Stopped');
  });

  test('Degraded=True → Degraded (overrides Available)', () => {
    expect(
      getWorkspaceStatus({
        spec: { desiredStatus: 'Running' },
        status: {
          conditions: [
            { type: 'Available', status: 'True' },
            { type: 'Degraded', status: 'True' },
          ],
        },
      }),
    ).toBe('Degraded');
  });

  test('Deleting=True → Deleting (overrides everything)', () => {
    expect(
      getWorkspaceStatus({
        spec: { desiredStatus: 'Running' },
        status: {
          conditions: [
            { type: 'Available', status: 'True' },
            { type: 'Deleting', status: 'True' },
          ],
        },
      }),
    ).toBe('Deleting');
  });

  test('no conditions + Running → Starting (pre-reconcile)', () => {
    expect(getWorkspaceStatus({ spec: { desiredStatus: 'Running' } })).toBe('Starting');
  });

  test('no conditions + Stopped → Stopped (pre-reconcile)', () => {
    expect(getWorkspaceStatus({ spec: { desiredStatus: 'Stopped' }, status: { conditions: [] } })).toBe('Stopped');
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

describe('getStatusChipColor', () => {
  test.each([
    ['Running', 'success'],
    ['Starting', 'info'],
    ['Stopping', 'info'],
    ['Stopped', 'default'],
    ['Degraded', 'warning'],
    ['Deleting', 'error'],
    ['Unknown', 'default'],
  ] as const)('%s → %s', (status, expected) => {
    expect(getStatusChipColor(status)).toBe(expected);
  });
});
