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
  round2,
  formatCpuCores,
  formatMemoryGiB,
  findTemplateByRef,
  effectiveResources,
} from './workspace';

describe('round2', () => {
  test('rounds to 2 decimals for display', () => {
    expect(round2(0.9313)).toBe('0.93');
    expect(round2(1.5)).toBe('1.5');
  });

  test('never collapses a nonzero quantity to 0, and true zero stays 0', () => {
    expect(round2(0.001)).toBe('<0.01');
    expect(round2(0)).toBe('0');
  });
});

describe('shared quantity formatters', () => {
  test('formatCpuCores parses and rounds', () => {
    expect(formatCpuCores('1500m')).toBe('1.5');
  });
  test('formatMemoryGiB parses, rounds, and carries the unit', () => {
    expect(formatMemoryGiB('1G')).toBe('0.93 GiB');
  });
});

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
  // The `created-by` annotation holds the authoritative K8s username (<prefix>:<claim>) and
  // /me resolves that exact string into user.k8sUser, so matching is plain equality — no
  // provider-shaped fuzzy branches. Each case is a distinct contract of that equality.
  test.each([
    // The annotation the API server stamps IS the prefixed username; k8sUser is that same
    // prefixed string. Exact match.
    ['github:alice', 'github:alice', true, 'prefixed exact match'],
    ['alice', 'alice', true, 'unprefixed exact match'],
    // The old fuzz matched the raw claim against a prefixed owner; that mismatch is the bug.
    ['github:alice', 'alice', false, 'raw claim must NOT match prefixed owner'],
    // The false positive the old substring fuzz allowed: a service account whose name ends
    // in the username. Plain equality rejects it.
    ['system:serviceaccount:kube-system:bob', 'bob', false, 'service account is not user bob'],
    ['dex/alice', 'alice', false, 'provider/user no longer fuzzy-matches'],
    ['github:alice', 'github:bob', false, 'different user'],
    [undefined, 'github:alice', false, 'missing owner'],
    ['github:alice', undefined, false, 'missing k8sUser (undefined)'],
    ['github:alice', null, false, 'unresolved k8sUser (null) matches nothing'],
  ])('isOwner(%s, %s) → %s (%s)', (owner, k8sUser, expected) => {
    expect(isOwner(owner, k8sUser)).toBe(expected);
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

describe('findTemplateByRef', () => {
  const items = [
    { metadata: { name: 'tmpl-a', namespace: 'shared' }, spec: {}, sourceNamespace: 'shared' },
    { metadata: { name: 'tmpl-a', namespace: 'user-ns' }, spec: {}, sourceNamespace: 'user-ns' },
    { metadata: { name: 'tmpl-b', namespace: 'shared' }, spec: {}, sourceNamespace: 'shared' },
  ];

  test('matches on name and namespace when the ref carries one', () => {
    expect(findTemplateByRef(items, { name: 'tmpl-a', namespace: 'user-ns' })?.metadata.namespace).toBe('user-ns');
  });

  test('a namespace-less ref matches the first name hit', () => {
    expect(findTemplateByRef(items, { name: 'tmpl-b' })?.metadata.namespace).toBe('shared');
  });

  test('no ref, no items, or no match resolve to null', () => {
    expect(findTemplateByRef(items, undefined)).toBeNull();
    expect(findTemplateByRef(undefined, { name: 'tmpl-a' })).toBeNull();
    expect(findTemplateByRef(items, { name: 'ghost' })).toBeNull();
  });
});

describe('effectiveResources', () => {
  const template = {
    metadata: { name: 't', namespace: 'shared' },
    spec: { defaultResources: { requests: { cpu: '3' }, limits: { cpu: '3', 'nvidia.com/gpu': '1' } } },
    sourceNamespace: 'shared',
  };

  test('absent spec.resources falls back to the template defaults', () => {
    expect(effectiveResources({}, template)).toEqual(template.spec.defaultResources);
  });

  test('an empty {} block does NOT fall back (mirrors the operator nil check)', () => {
    expect(effectiveResources({ resources: {} }, template)).toEqual({});
  });

  test('stored resources win over template defaults', () => {
    const stored = { limits: { cpu: '2' } };
    expect(effectiveResources({ resources: stored }, template)).toBe(stored);
  });

  test('no template and no stored block resolve to undefined', () => {
    expect(effectiveResources({}, null)).toBeUndefined();
  });
});
