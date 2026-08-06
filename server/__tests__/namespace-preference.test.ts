import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { randomBytes } from 'crypto';
import { KEY_LENGTH, deriveKeys, sign } from '../crypto';
import type { KeyEntry, KeyMap } from '../middleware/session';

// The preference cookie carries an authz-shaped `visible` set, so signing is MANDATORY:
// a tampered/forged/expired cookie must never be trusted. We drive the module's key
// source (the secret-watcher singleton) via a mock so we control signing keys.
let testKeyMap: KeyMap = { keys: new Map() };
mock.module('../secret-watcher', () => ({
  getKeyMap: () => testKeyMap,
}));

const { readNamespacePreference, isVisibleExpired, freshVisible, buildNamespacePreferenceCookie, userTag, NS_PREF_COOKIE_NAME } =
  await import('../middleware/namespace-preference');

function keyMapWith(kid = 'k1'): KeyMap {
  const entry: KeyEntry = { kid, key: randomBytes(KEY_LENGTH), addedTime: Date.now() - 120_000 };
  return { keys: new Map([[kid, entry]]) };
}

// A JWT decodeJWTPayload can parse: header.payload.sig, payload carries `sub`. userTag hashes
// `sub`, so the cookie binds to this identity. A different `sub` → a different boundUser.
function jwtFor(sub: string): string {
  return `h.${Buffer.from(JSON.stringify({ sub }), 'utf-8').toString('base64url')}.s`;
}
const JWT = jwtFor('user-a');

// Extract the cookie value (before attributes) from a Set-Cookie header.
function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0].slice(NS_PREF_COOKIE_NAME.length + 1);
}

function reqWithCookie(value: string): Request {
  return new Request('http://x/api/v1/namespaces', { headers: { Cookie: `${NS_PREF_COOKIE_NAME}=${value}` } });
}

// Build a full preference from partial fields (defaults for the scan-cache metadata). boundUser
// is irrelevant on the input — the builder always re-derives it from the jwt it's given.
function pref(over: { activeNs?: string | null; visible?: string[]; checkedUpTo?: number; universeFp?: string; k8sUser?: string | null }) {
  return {
    activeNs: over.activeNs ?? null,
    visible: over.visible ?? [],
    checkedUpTo: over.checkedUpTo ?? 0,
    universeFp: over.universeFp ?? 'fp',
    visibleExp: 0,
    boundUser: '',
    k8sUser: over.k8sUser ?? null,
  };
}

const EMPTY = { activeNs: null, visible: [], checkedUpTo: 0, universeFp: '', visibleExp: 0, boundUser: '', k8sUser: null };

beforeEach(() => {
  testKeyMap = keyMapWith();
});

describe('namespace preference cookie', () => {
  test('round-trips activeNs + visible + checkedUpTo + universeFp; visibleExp stamped fresh', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a', 'team-x'], checkedUpTo: 5, universeFp: 'abc' }), JWT)!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)), JWT);
    expect(parsed.activeNs).toBe('team-a');
    expect(parsed.visible).toEqual(['team-a', 'team-x']);
    expect(parsed.checkedUpTo).toBe(5);
    expect(parsed.universeFp).toBe('abc');
    expect(isVisibleExpired(parsed)).toBe(false);
    expect(freshVisible(parsed)).toEqual(['team-a', 'team-x']);
  });

  test('round-trips k8sUser (the cached authoritative identity)', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', k8sUser: 'github:alice' }), JWT)!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)), JWT);
    expect(parsed.k8sUser).toBe('github:alice');
  });

  test('a cookie predating k8sUser stays valid; k8sUser normalizes to null', () => {
    // Sign a legacy payload (no k8sUser field) with the real test key so it VERIFIES — this
    // exercises the normalization path, not a tamper rejection. The field was added later; an
    // older, otherwise well-formed cookie must not be discarded.
    const entry = [...testKeyMap.keys.values()][0];
    const { signingKey } = deriveKeys(entry.key);
    const legacy = { activeNs: 'team-a', visible: ['team-a'], checkedUpTo: 1, universeFp: 'fp', visibleExp: 9999999999, boundUser: userTag(JWT) };
    const buf = Buffer.from(JSON.stringify(legacy), 'utf-8');
    const value = `${buf.toString('base64url')}.${entry.kid}.${sign(buf, signingKey, entry.kid).toString('base64url')}`;

    const parsed = readNamespacePreference(reqWithCookie(value), JWT);
    expect(parsed.activeNs).toBe('team-a');
    expect(parsed.k8sUser).toBeNull();
  });

  test('a tampered visible set fails verification and is treated as empty', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }), JWT)!;
    const value = cookieValue(setCookie);
    // Forge membership by rewriting the payload segment (keep sig/kid).
    const [, kid, sig] = value.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ activeNs: 'team-a', visible: ['evil'], checkedUpTo: 1, universeFp: 'fp', visibleExp: 9999999999 }),
      'utf-8',
    ).toString('base64url');
    const forged = `${forgedPayload}.${kid}.${sig}`;

    const parsed = readNamespacePreference(reqWithCookie(forged), JWT);
    expect(parsed.activeNs).toBeNull();
    expect(parsed.visible).toEqual([]);
  });

  test('visibleExp is stamped inside the signed payload (client cannot extend via Max-Age)', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a' }), JWT)!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)), JWT);
    // Fresh cookie: server-stamped expiry is in the future.
    expect(parsed.visibleExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('absent / malformed cookie → empty preference', () => {
    expect(readNamespacePreference(new Request('http://x/'), JWT)).toEqual(EMPTY);
    expect(readNamespacePreference(reqWithCookie('not.a.cookie'), JWT)).toEqual(EMPTY);
  });

  test('unknown signing kid (rotated out) → treated as empty', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }), JWT)!;
    const value = cookieValue(setCookie);
    // Rotate the keymap entirely — the kid that signed the cookie is gone.
    testKeyMap = keyMapWith('k2');
    const parsed = readNamespacePreference(reqWithCookie(value), JWT);
    expect(parsed.activeNs).toBeNull();
    expect(parsed.visible).toEqual([]);
  });

  test('a cookie minted for user A is IGNORED under user B (shared-profile binding)', () => {
    // The confused-profile guard: A's signed cookie is valid, but B is a different `sub`, so
    // its boundUser tag won't match — B must see an empty preference (default + recompute),
    // never A's activeNs or A's visible RBAC snapshot.
    const setCookie = buildNamespacePreferenceCookie(
      pref({ activeNs: 'team-a', visible: ['team-a', 'team-secret'], checkedUpTo: 3, universeFp: 'abc' }),
      jwtFor('user-a'),
    )!;
    const value = cookieValue(setCookie);
    // Same browser, same signed cookie, different logged-in user.
    expect(readNamespacePreference(reqWithCookie(value), jwtFor('user-b'))).toEqual(EMPTY);
    // Sanity: it IS honored for the user it was minted for.
    expect(readNamespacePreference(reqWithCookie(value), jwtFor('user-a')).activeNs).toBe('team-a');
  });

  test('a tokenless request never rides a bound cookie', () => {
    // userTag(null) === '' and a bound cookie's boundUser is non-empty → no match → empty.
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }), jwtFor('user-a'))!;
    expect(readNamespacePreference(reqWithCookie(cookieValue(setCookie)), null)).toEqual(EMPTY);
  });

  test('no signing key available → no cookie built (degrade, do not persist)', () => {
    testKeyMap = { keys: new Map() };
    expect(buildNamespacePreferenceCookie(pref({ activeNs: 'team-a' }), JWT)).toBeNull();
  });

  test('freshVisible returns [] once the snapshot is expired', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }), JWT)!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)), JWT);
    // Force-expire by mutating the parsed copy (freshVisible reads visibleExp).
    const expired = { ...parsed, visibleExp: 1 };
    expect(isVisibleExpired(expired)).toBe(true);
    expect(freshVisible(expired)).toEqual([]);
  });

  test('size pressure resets the scan cache TOGETHER (visible + checkedUpTo + fp), keeps activeNs', () => {
    const visible = Array.from({ length: 400 }, (_, i) => `ns-with-a-fairly-long-name-${i}`);
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'my-active-ns', visible, checkedUpTo: 400, universeFp: 'abc' }), JWT);
    expect(setCookie).not.toBeNull();
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie!)), JWT);
    expect(parsed.activeNs).toBe('my-active-ns');
    // visible + checkedUpTo + universeFp reset together (invariant: never a high checkedUpTo
    // with an emptied visible, which would falsely mark unscanned indices as denied).
    expect(parsed.visible).toEqual([]);
    expect(parsed.checkedUpTo).toBe(0);
    expect(parsed.universeFp).toBe('');
  });
});
