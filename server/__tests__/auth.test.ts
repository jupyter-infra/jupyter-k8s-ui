import { describe, expect, test } from 'bun:test';
import { decodeJWTPayload } from '../auth';

function buildJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('decodeJWTPayload', () => {
  test('decodes the JSON payload from a well-formed JWT', () => {
    const jwt = buildJWT({ sub: 'user@example.com', exp: 9999999999, groups: ['admins'] });
    expect(decodeJWTPayload(jwt)).toEqual({
      sub: 'user@example.com',
      exp: 9999999999,
      groups: ['admins'],
    });
  });

  // The function's whole purpose is to be safe on bad input, so covering the
  // failure paths is where the value is.
  test.each([
    ['', 'empty'],
    ['only.two', 'two parts'],
    ['a.b.c.d', 'four parts'],
    [`header.${Buffer.from('not json').toString('base64url')}.sig`, 'non-JSON payload'],
  ])('returns null for malformed JWT (%s)', (jwt) => {
    expect(decodeJWTPayload(jwt)).toBeNull();
  });
});
