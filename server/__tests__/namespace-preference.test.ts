import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { randomBytes } from 'crypto';
import { KEY_LENGTH } from '../crypto';
import type { KeyEntry, KeyMap } from '../middleware/session';

// The preference cookie carries an authz-shaped `visible` set, so signing is MANDATORY:
// a tampered/forged/expired cookie must never be trusted. We drive the module's key
// source (the secret-watcher singleton) via a mock so we control signing keys.
let testKeyMap: KeyMap = { keys: new Map() };
mock.module('../secret-watcher', () => ({
  getKeyMap: () => testKeyMap,
}));

const { readNamespacePreference, isVisibleExpired, freshVisible, buildNamespacePreferenceCookie, NS_PREF_COOKIE_NAME } =
  await import('../middleware/namespace-preference');

function keyMapWith(kid = 'k1'): KeyMap {
  const entry: KeyEntry = { kid, key: randomBytes(KEY_LENGTH), addedTime: Date.now() - 120_000 };
  return { keys: new Map([[kid, entry]]) };
}

// Extract the cookie value (before attributes) from a Set-Cookie header.
function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0].slice(NS_PREF_COOKIE_NAME.length + 1);
}

function reqWithCookie(value: string): Request {
  return new Request('http://x/api/v1/namespaces', { headers: { Cookie: `${NS_PREF_COOKIE_NAME}=${value}` } });
}

// Build a full preference from partial fields (defaults for the scan-cache metadata).
function pref(over: { activeNs?: string | null; visible?: string[]; checkedUpTo?: number; universeFp?: string }) {
  return {
    activeNs: over.activeNs ?? null,
    visible: over.visible ?? [],
    checkedUpTo: over.checkedUpTo ?? 0,
    universeFp: over.universeFp ?? 'fp',
    visibleExp: 0,
  };
}

const EMPTY = { activeNs: null, visible: [], checkedUpTo: 0, universeFp: '', visibleExp: 0 };

beforeEach(() => {
  testKeyMap = keyMapWith();
});

describe('namespace preference cookie', () => {
  test('round-trips activeNs + visible + checkedUpTo + universeFp; visibleExp stamped fresh', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a', 'team-x'], checkedUpTo: 5, universeFp: 'abc' }))!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)));
    expect(parsed.activeNs).toBe('team-a');
    expect(parsed.visible).toEqual(['team-a', 'team-x']);
    expect(parsed.checkedUpTo).toBe(5);
    expect(parsed.universeFp).toBe('abc');
    expect(isVisibleExpired(parsed)).toBe(false);
    expect(freshVisible(parsed)).toEqual(['team-a', 'team-x']);
  });

  test('a tampered visible set fails verification and is treated as empty', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }))!;
    const value = cookieValue(setCookie);
    // Forge membership by rewriting the payload segment (keep sig/kid).
    const [, kid, sig] = value.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ activeNs: 'team-a', visible: ['evil'], checkedUpTo: 1, universeFp: 'fp', visibleExp: 9999999999 }),
      'utf-8',
    ).toString('base64url');
    const forged = `${forgedPayload}.${kid}.${sig}`;

    const parsed = readNamespacePreference(reqWithCookie(forged));
    expect(parsed.activeNs).toBeNull();
    expect(parsed.visible).toEqual([]);
  });

  test('visibleExp is stamped inside the signed payload (client cannot extend via Max-Age)', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a' }))!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)));
    // Fresh cookie: server-stamped expiry is in the future.
    expect(parsed.visibleExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('absent / malformed cookie → empty preference', () => {
    expect(readNamespacePreference(new Request('http://x/'))).toEqual(EMPTY);
    expect(readNamespacePreference(reqWithCookie('not.a.cookie'))).toEqual(EMPTY);
  });

  test('unknown signing kid (rotated out) → treated as empty', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }))!;
    const value = cookieValue(setCookie);
    // Rotate the keymap entirely — the kid that signed the cookie is gone.
    testKeyMap = keyMapWith('k2');
    const parsed = readNamespacePreference(reqWithCookie(value));
    expect(parsed.activeNs).toBeNull();
    expect(parsed.visible).toEqual([]);
  });

  test('no signing key available → no cookie built (degrade, do not persist)', () => {
    testKeyMap = { keys: new Map() };
    expect(buildNamespacePreferenceCookie(pref({ activeNs: 'team-a' }))).toBeNull();
  });

  test('freshVisible returns [] once the snapshot is expired', () => {
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'team-a', visible: ['team-a'] }))!;
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie)));
    // Force-expire by mutating the parsed copy (freshVisible reads visibleExp).
    const expired = { ...parsed, visibleExp: 1 };
    expect(isVisibleExpired(expired)).toBe(true);
    expect(freshVisible(expired)).toEqual([]);
  });

  test('size pressure resets the scan cache TOGETHER (visible + checkedUpTo + fp), keeps activeNs', () => {
    const visible = Array.from({ length: 400 }, (_, i) => `ns-with-a-fairly-long-name-${i}`);
    const setCookie = buildNamespacePreferenceCookie(pref({ activeNs: 'my-active-ns', visible, checkedUpTo: 400, universeFp: 'abc' }));
    expect(setCookie).not.toBeNull();
    const parsed = readNamespacePreference(reqWithCookie(cookieValue(setCookie!)));
    expect(parsed.activeNs).toBe('my-active-ns');
    // visible + checkedUpTo + universeFp reset together (invariant: never a high checkedUpTo
    // with an emptied visible, which would falsely mark unscanned indices as denied).
    expect(parsed.visible).toEqual([]);
    expect(parsed.checkedUpTo).toBe(0);
    expect(parsed.universeFp).toBe('');
  });
});
