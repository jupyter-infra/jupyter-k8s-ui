import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { randomBytes } from 'crypto';
import { KEY_LENGTH } from '../crypto';
import type { KeyEntry, KeyMap } from '../middleware/session';
import { serverConfig } from '../k8s/config';
import { buildJWT } from './test-helpers';

// handleGetMe is the read-through cache for the authoritative K8s username: it decodes the
// JWT for display fields, then resolves `k8sUser` from the signed ns-preference cookie if
// cached, else via ONE SelfSubjectReview which it mints back into the cookie. We drive the
// REAL cookie module (namespace-preference.test.ts owns its unit tests; a module-mock here
// would leak process-globally) through a mocked signing-key leaf, and mock the k8s client's
// SelfSubjectReview so no cluster is touched.

let testKeyMap: KeyMap = { keys: new Map() };
// Scripted SelfSubjectReview: the username the API server "returns", and a call counter to
// assert the read-through hit skips the cluster entirely.
let ssReviewUsername: string | null = 'github:alice';
let ssReviewCalls = 0;

function installMocks() {
  mock.module('../k8s/client', () => ({
    // Superset so sibling static imports resolve under any file ordering.
    reuseOrCreateUserK8sClient: async () => ({}),
    reuseOrCreateAuthClient: async () => ({ createSelfSubjectAccessReview: async () => ({ body: { status: { allowed: true } } }) }),
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateAuthnClient: async () => ({
      createSelfSubjectReview: async () => {
        ssReviewCalls++;
        return { body: { status: { userInfo: ssReviewUsername ? { username: ssReviewUsername } : {} } } };
      },
    }),
  }));
  mock.module('../secret-watcher', () => ({ getKeyMap: () => testKeyMap }));
}
installMocks();

const { handleGetMe } = await import('../handlers/me');
const { NS_PREF_COOKIE_NAME } = await import('../middleware/namespace-preference');

function keyMapWith(kid = 'k1'): KeyMap {
  const entry: KeyEntry = { kid, key: randomBytes(KEY_LENGTH), addedTime: Date.now() - 120_000 };
  return { keys: new Map([[kid, entry]]) };
}

interface PrefPayload {
  k8sUser: string | null;
}

/** Decode the preference the handler PERSISTED, from the Set-Cookie on its response. */
function decodePersisted(res: Response): PrefPayload | null {
  const setCookie = res.headers.get('Set-Cookie');
  if (!setCookie) return null;
  const value = setCookie.split(';')[0].slice(NS_PREF_COOKIE_NAME.length + 1);
  return JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf-8')) as PrefPayload;
}

// A /me request bearing `jwt` and, optionally, a pre-seeded ns-preference cookie.
function meReq(jwt?: string, prefCookie?: string): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers['X-Auth-Request-Access-Token'] = jwt;
  if (prefCookie) headers.Cookie = `${NS_PREF_COOKIE_NAME}=${prefCookie}`;
  return new Request('http://x/api/v1/me', { headers });
}

const originalNodeEnv = process.env.NODE_ENV;
const originalDevToken = serverConfig.devAccessToken;

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  serverConfig.devAccessToken = '';
  serverConfig.session.enabled = false;
  installMocks();
  testKeyMap = keyMapWith();
  ssReviewUsername = 'github:alice';
  ssReviewCalls = 0;
});

describe('handleGetMe — auth shape', () => {
  test('returns unauthenticated shape when no token present', async () => {
    const res = await handleGetMe(meReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, user: null });
    expect(ssReviewCalls).toBe(0); // no token → no cluster call
  });

  test('returns 401 when token is malformed', async () => {
    const res = await handleGetMe(meReq('not.a.jwt'));
    expect(res.status).toBe(401);
  });

  test('displayUser uses preferred_username, else falls back to sub', async () => {
    const withPreferred = await handleGetMe(meReq(buildJWT({ sub: 'sub-id', preferred_username: 'alice' })));
    expect(((await withPreferred.json()) as { user: { displayUser: string } }).user.displayUser).toBe('alice');

    const withoutPreferred = await handleGetMe(meReq(buildJWT({ sub: 'sub-id' })));
    expect(((await withoutPreferred.json()) as { user: { displayUser: string } }).user.displayUser).toBe('sub-id');
  });

  test('defaults missing email to null and missing groups to []', async () => {
    const res = await handleGetMe(meReq(buildJWT({ sub: 'u' })));
    const body = (await res.json()) as { user: { email: null | string; groups: string[] } };
    expect(body.user.email).toBeNull();
    expect(body.user.groups).toEqual([]);
  });

  test('passes groups claim through', async () => {
    const res = await handleGetMe(meReq(buildJWT({ sub: 'u', groups: ['devs', 'admins'] })));
    expect(((await res.json()) as { user: { groups: string[] } }).user.groups).toEqual(['devs', 'admins']);
  });
});

describe('handleGetMe — k8sUser read-through cache', () => {
  test('cache miss: resolves via SelfSubjectReview and mints it into the cookie', async () => {
    const res = await handleGetMe(meReq(buildJWT({ sub: 'alice', preferred_username: 'alice' })));
    const body = (await res.json()) as { user: { displayUser: string; k8sUser: string } };

    // The AUTHORITATIVE username (prefixed), distinct from the raw display claim.
    expect(body.user.k8sUser).toBe('github:alice');
    expect(body.user.displayUser).toBe('alice');
    expect(ssReviewCalls).toBe(1);

    // Minted into the signed cookie for the next load / other replicas.
    expect(decodePersisted(res)?.k8sUser).toBe('github:alice');
  });

  test('cache hit: reads k8sUser from the cookie and issues NO SelfSubjectReview', async () => {
    const jwt = buildJWT({ sub: 'alice', preferred_username: 'alice' });
    // First call mints the cookie; reuse its Set-Cookie value as the inbound cookie.
    const first = await handleGetMe(meReq(jwt));
    const cookieValue = first.headers
      .get('Set-Cookie')!
      .split(';')[0]
      .slice(NS_PREF_COOKIE_NAME.length + 1);
    ssReviewCalls = 0;

    const second = await handleGetMe(meReq(jwt, cookieValue));
    const body = (await second.json()) as { user: { k8sUser: string } };
    expect(body.user.k8sUser).toBe('github:alice');
    expect(ssReviewCalls).toBe(0); // served from cookie — no cluster round-trip
    expect(second.headers.get('Set-Cookie')).toBeNull(); // already cached → no re-mint
  });

  test('unresolved identity: k8sUser is null and is NEVER cached (allows later retry)', async () => {
    ssReviewUsername = null; // API server returns no userInfo.username
    const res = await handleGetMe(meReq(buildJWT({ sub: 'alice' })));
    const body = (await res.json()) as { user: { k8sUser: string | null } };
    expect(body.user.k8sUser).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull(); // must not pin "matches nothing"
  });
});

process.env.NODE_ENV = originalNodeEnv;
serverConfig.devAccessToken = originalDevToken;
