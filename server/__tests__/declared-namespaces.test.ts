import { describe, test, expect } from 'bun:test';
import { declaredNamespaces } from '../k8s/config';

// declaredNamespaces(defaultNamespace, knownNamespaces) — the stable front-of-list order:
// default first, then the declared list in order, deduped and blank-filtered. Pure fn.
describe('declaredNamespaces', () => {
  test('default first, then declared list in declared order', () => {
    expect(declaredNamespaces('default', ['team-a', 'team-b'])).toEqual(['default', 'team-a', 'team-b']);
  });

  test('preserves declared order (not alphabetical — admin priority)', () => {
    expect(declaredNamespaces('default', ['zeta', 'alpha', 'mu'])).toEqual(['default', 'zeta', 'alpha', 'mu']);
  });

  test('default is pinned once even if it also appears in the declared list', () => {
    expect(declaredNamespaces('default', ['team-a', 'default', 'team-b'])).toEqual(['default', 'team-a', 'team-b']);
  });

  test('default appearing NOT first in the list is still pinned to index 0', () => {
    expect(declaredNamespaces('team-a', ['team-b', 'team-a', 'team-c'])).toEqual(['team-a', 'team-b', 'team-c']);
  });

  test('de-duplicates repeated declared entries, keeping first occurrence', () => {
    expect(declaredNamespaces('default', ['team-a', 'team-a', 'team-b', 'team-a'])).toEqual(['default', 'team-a', 'team-b']);
  });

  test('empty declared list → just the default', () => {
    expect(declaredNamespaces('default', [])).toEqual(['default']);
  });

  test('a non-default default (custom NAMESPACE) leads', () => {
    expect(declaredNamespaces('prod-ns', ['team-a'])).toEqual(['prod-ns', 'team-a']);
  });

  test('trims whitespace and drops blank / whitespace-only entries', () => {
    expect(declaredNamespaces('default', [' team-a ', '', '   ', 'team-b'])).toEqual(['default', 'team-a', 'team-b']);
  });

  test('trimming causes a collision with the default → deduped', () => {
    expect(declaredNamespaces('default', [' default ', 'team-a'])).toEqual(['default', 'team-a']);
  });

  test('does not mutate the input array', () => {
    const input = ['team-a', 'team-b'];
    declaredNamespaces('default', input);
    expect(input).toEqual(['team-a', 'team-b']);
  });

  test('result order is a stable total order (idempotent across calls)', () => {
    const a = declaredNamespaces('default', ['team-b', 'team-a']);
    const b = declaredNamespaces('default', ['team-b', 'team-a']);
    expect(a).toEqual(b);
    // declared order retained — team-b before team-a despite alphabetical would swap them
    expect(a).toEqual(['default', 'team-b', 'team-a']);
  });
});
