import { describe, expect, test } from 'bun:test';
import { isValidK8sName, isAccessType, isOwnershipType, isDesiredStatus, validateWorkspaceEnums } from '../guards';

describe('isValidK8sName', () => {
  test.each(['my-workspace', 'a', 'abc-123-def', '0-abc', 'a'.repeat(253)])('accepts valid name: %s', (name) => {
    expect(isValidK8sName(name)).toBe(true);
  });

  test.each([
    ['', 'empty'],
    ['My-Workspace', 'uppercase'],
    ['-start', 'leading hyphen'],
    ['end-', 'trailing hyphen'],
    ['has space', 'whitespace'],
    ['under_score', 'underscore'],
    ['dot.separated', 'dot'],
    ['a'.repeat(254), 'over 253 chars'],
  ])('rejects %s (%s)', (name) => {
    expect(isValidK8sName(name)).toBe(false);
  });

  test('rejects null', () => {
    expect(isValidK8sName(null)).toBe(false);
  });
});

// The enum guards mirror the CRD's allowed values. #39 shipped a stale "Private"
// literal the CRD rejected with a 422 — these lock the accepted set.
describe('isAccessType', () => {
  test.each(['Public', 'OwnerOnly'])('accepts %s', (v) => {
    expect(isAccessType(v)).toBe(true);
  });

  test.each([['Private'], ['public'], [''], [null], [undefined], [42]])('rejects %p', (v) => {
    expect(isAccessType(v)).toBe(false);
  });
});

describe('isOwnershipType', () => {
  test.each(['Public', 'OwnerOnly'])('accepts %s', (v) => {
    expect(isOwnershipType(v)).toBe(true);
  });

  test.each([['Private'], ['Everyone'], [null]])('rejects %p', (v) => {
    expect(isOwnershipType(v)).toBe(false);
  });
});

describe('isDesiredStatus', () => {
  test.each(['Running', 'Stopped'])('accepts %s', (v) => {
    expect(isDesiredStatus(v)).toBe(true);
  });

  test.each([['Paused'], ['running'], [null]])('rejects %p', (v) => {
    expect(isDesiredStatus(v)).toBe(false);
  });
});

describe('validateWorkspaceEnums', () => {
  test('returns null when no enum fields are present', () => {
    expect(validateWorkspaceEnums({})).toBeNull();
  });

  test('returns null when all present fields are valid', () => {
    expect(validateWorkspaceEnums({ accessType: 'OwnerOnly', ownershipType: 'Public', desiredStatus: 'Running' })).toBeNull();
  });

  // The stale literal from #39 — the whole reason this validation exists.
  test('rejects the "Private" accessType regression', () => {
    // @ts-expect-error — "Private" is not assignable to AccessType; the guard is what catches it at runtime.
    expect(validateWorkspaceEnums({ accessType: 'Private' })).toMatch(/accessType/);
  });

  test('names the first invalid field', () => {
    // @ts-expect-error — invalid literal on purpose to exercise the runtime guard
    expect(validateWorkspaceEnums({ ownershipType: 'Everyone' })).toMatch(/ownershipType/);
  });
});
