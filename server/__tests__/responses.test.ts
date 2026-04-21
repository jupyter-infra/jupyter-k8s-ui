import { describe, expect, test } from 'bun:test';
import { handleK8sError, isValidK8sName } from '../responses';

describe('handleK8sError', () => {
  // Each mapped status code is a contract with the frontend — if the map changes,
  // the UI's error handling breaks silently. One test per distinct outcome.
  test.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'not found'],
    [409, 'already exists'],
    [422, 'Unprocessable'],
  ])('maps K8s %d to matching message', async (statusCode, expectedText) => {
    const err = Object.assign(new Error('x'), { statusCode });
    const res = handleK8sError(err, 'fallback');
    expect(res.status).toBe(statusCode);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain(expectedText.toLowerCase());
  });

  test('returns 500 with fallback message for unmapped status', async () => {
    const err = Object.assign(new Error('weird'), { statusCode: 999 });
    const res = handleK8sError(err, 'Something broke');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toBe('Something broke');
    expect(body.details).toBe('weird');
  });

  test('returns 500 for non-K8s error values', async () => {
    const res = handleK8sError('string error', 'fallback');
    expect(res.status).toBe(500);
  });
});

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
