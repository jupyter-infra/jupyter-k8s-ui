import { describe, test, expect, beforeEach } from 'bun:test';
import { handleGetMe } from '../handlers/me';
import { serverConfig } from '../k8s';
import { buildJWT } from './test-helpers';

function makeReqWithBearer(jwt: string): Request {
  return new Request('http://x/api/v1/me', {
    headers: { 'X-Auth-Request-Access-Token': jwt },
  });
}

// Make sure the test environment doesn't fall into the dev-token shortcut
const originalNodeEnv = process.env.NODE_ENV;
const originalDevToken = serverConfig.devAccessToken;

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  serverConfig.devAccessToken = '';
  serverConfig.session.enabled = false;
});

describe('handleGetMe', () => {
  test('returns unauthenticated shape when no token present', async () => {
    const res = await handleGetMe(new Request('http://x/api/v1/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, user: null });
  });

  test('returns 401 when token is malformed', async () => {
    const res = await handleGetMe(makeReqWithBearer('not.a.jwt'));
    expect(res.status).toBe(401);
  });

  test('uses preferred_username when present, otherwise falls back to sub', async () => {
    const withPreferred = await handleGetMe(makeReqWithBearer(buildJWT({ sub: 'sub-id', preferred_username: 'alice', email: 'a@x.com' })));
    const body1 = (await withPreferred.json()) as { user: { username: string } };
    expect(body1.user.username).toBe('alice');

    const withoutPreferred = await handleGetMe(makeReqWithBearer(buildJWT({ sub: 'sub-id' })));
    const body2 = (await withoutPreferred.json()) as { user: { username: string } };
    expect(body2.user.username).toBe('sub-id');
  });

  test('defaults missing email to null and missing groups to []', async () => {
    const res = await handleGetMe(makeReqWithBearer(buildJWT({ sub: 'u' })));
    const body = (await res.json()) as { user: { email: null | string; groups: string[] } };
    expect(body.user.email).toBeNull();
    expect(body.user.groups).toEqual([]);
  });

  test('passes groups claim through', async () => {
    const res = await handleGetMe(makeReqWithBearer(buildJWT({ sub: 'u', groups: ['devs', 'admins'] })));
    const body = (await res.json()) as { user: { groups: string[] } };
    expect(body.user.groups).toEqual(['devs', 'admins']);
  });
});

// Restore env after all tests in this file
process.env.NODE_ENV = originalNodeEnv;
serverConfig.devAccessToken = originalDevToken;
