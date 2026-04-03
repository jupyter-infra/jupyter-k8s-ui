import { describe, expect, test } from 'bun:test';
import { createSessionCookie, validateSessionCookie, buildSetCookieHeader, parseCookieValue, getSigningKey } from '../session';
import type { KeyEntry, KeyMap } from '../session';
import type { SessionConfig } from '../types';
import { randomBytes } from 'crypto';
import { KEY_LENGTH } from '../crypto';

// --- Helpers ---

function makeKey(kid: string, addedSecsAgo = 120): KeyEntry {
  return { kid, key: randomBytes(KEY_LENGTH), addedTime: Date.now() - addedSecsAgo * 1000 };
}

function makeKeyMap(...entries: KeyEntry[]): KeyMap {
  return { keys: new Map(entries.map((e) => [e.kid, e])) };
}

function makeDexToken(expInSecs = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user', exp: Math.floor(Date.now() / 1000) + expInSecs })).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

const defaultConfig: SessionConfig = {
  enabled: true,
  cookieName: 'workspace_console_session',
  cookiePath: '/api/',
  cookieMaxAgeSecs: 2700,
  maxSessionLifetimeSecs: 3600,
  nearExpiryThresholdSecs: 600,
  secretName: 'web-app-session-secret',
  secretNamespace: 'default',
  keyPrefix: 'session-key-',
  newKeyUseDelaySecs: 60,
  cookieSizeWarnBytes: 3800,
  cookieSizeMaxBytes: 4096,
  expectedDomain: '',
};

// --- Tests ---

describe('createSessionCookie + validateSessionCookie', () => {
  test('round-trip: create then validate returns same token', () => {
    const entry = makeKey('1700000000');
    const keyMap = makeKeyMap(entry);
    const token = makeDexToken();

    const cookie = createSessionCookie(token, keyMap, defaultConfig);
    expect(cookie).not.toBeNull();

    const payload = validateSessionCookie(cookie!, keyMap);
    expect(payload).not.toBeNull();
    expect(payload!.token).toBe(token);
    expect(payload!.kid).toBe('1700000000');
  });

  test('returns null when no key past cooloff', () => {
    const entry = makeKey('1700000000', 10); // only 10s ago, cooloff is 60s
    const keyMap = makeKeyMap(entry);
    const token = makeDexToken();

    const cookie = createSessionCookie(token, keyMap, defaultConfig);
    expect(cookie).toBeNull();
  });

  test('returns null when Dex token near expiry (Thread 10)', () => {
    const entry = makeKey('1700000000');
    const keyMap = makeKeyMap(entry);
    const token = makeDexToken(300); // expires in 5 min, threshold is 10 min

    const cookie = createSessionCookie(token, keyMap, defaultConfig);
    expect(cookie).toBeNull();
  });

  test('validation fails with wrong key', () => {
    const entry1 = makeKey('1700000000');
    const entry2 = makeKey('1700000001');
    const keyMap1 = makeKeyMap(entry1);
    const keyMap2 = makeKeyMap(entry2);
    const token = makeDexToken();

    const cookie = createSessionCookie(token, keyMap1, defaultConfig);
    expect(cookie).not.toBeNull();

    const payload = validateSessionCookie(cookie!, keyMap2);
    expect(payload).toBeNull();
  });

  test('validation fails with tampered cookie', () => {
    const entry = makeKey('1700000000');
    const keyMap = makeKeyMap(entry);
    const token = makeDexToken();

    const cookie = createSessionCookie(token, keyMap, defaultConfig)!;
    const tampered = cookie.slice(0, -5) + 'XXXXX';

    const payload = validateSessionCookie(tampered, keyMap);
    expect(payload).toBeNull();
  });

  test('validation fails with expired session', async () => {
    const entry = makeKey('1700000000');
    const keyMap = makeKeyMap(entry);
    // Token expires in 1 second
    const token = makeDexToken(1);

    const cookie = createSessionCookie(token, keyMap, {
      ...defaultConfig,
      nearExpiryThresholdSecs: 0, // disable near-expiry check so cookie is created
      maxSessionLifetimeSecs: 1,
    });
    expect(cookie).not.toBeNull();

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const payload = validateSessionCookie(cookie!, keyMap);
    expect(payload).toBeNull();
  });

  test('multi-key: validate with any key that signed it', () => {
    const entry1 = makeKey('1700000000', 200);
    const entry2 = makeKey('1700000001', 120);
    const keyMapBoth = makeKeyMap(entry1, entry2);
    const token = makeDexToken();

    // Signs with newest key past cooloff (entry2)
    const cookie = createSessionCookie(token, keyMapBoth, defaultConfig);
    expect(cookie).not.toBeNull();

    // Validate with both keys available
    const payload = validateSessionCookie(cookie!, keyMapBoth);
    expect(payload).not.toBeNull();
    expect(payload!.kid).toBe('1700000001');
  });

  test('validation rejects malformed cookie strings', () => {
    const keyMap = makeKeyMap(makeKey('1700000000'));
    expect(validateSessionCookie('', keyMap)).toBeNull();
    expect(validateSessionCookie('just-one-part', keyMap)).toBeNull();
    expect(validateSessionCookie('a.b', keyMap)).toBeNull();
    expect(validateSessionCookie('a.b.c.d', keyMap)).toBeNull();
  });
});

describe('buildSetCookieHeader', () => {
  test('includes all security attributes', () => {
    const header = buildSetCookieHeader('cookie-value', defaultConfig);
    expect(header).toContain('workspace_console_session=cookie-value');
    expect(header).toContain('Path=/api/');
    expect(header).toContain('Max-Age=2700');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
  });
});

describe('parseCookieValue', () => {
  test('extracts named cookie from header', () => {
    const header = 'foo=bar; workspace_console_session=abc.def.ghi; other=123';
    expect(parseCookieValue(header, 'workspace_console_session')).toBe('abc.def.ghi');
  });

  test('returns null for missing cookie', () => {
    expect(parseCookieValue('foo=bar', 'workspace_console_session')).toBeNull();
  });

  test('handles cookie value with = signs', () => {
    expect(parseCookieValue('tok=a=b=c', 'tok')).toBe('a=b=c');
  });
});

describe('getSigningKey', () => {
  test('returns newest key past cooloff', () => {
    const old = makeKey('1700000000', 200);
    const newer = makeKey('1700000001', 120);
    const keyMap = makeKeyMap(old, newer);

    const result = getSigningKey(keyMap, 60);
    expect(result?.kid).toBe('1700000001');
  });

  test('skips keys not past cooloff', () => {
    const old = makeKey('1700000000', 120);
    const tooNew = makeKey('1700000001', 10); // 10s ago, cooloff 60s
    const keyMap = makeKeyMap(old, tooNew);

    const result = getSigningKey(keyMap, 60);
    expect(result?.kid).toBe('1700000000');
  });

  test('returns null when no keys past cooloff', () => {
    const tooNew = makeKey('1700000000', 10);
    const keyMap = makeKeyMap(tooNew);

    expect(getSigningKey(keyMap, 60)).toBeNull();
  });

  test('returns null for empty key map', () => {
    expect(getSigningKey({ keys: new Map() }, 60)).toBeNull();
  });
});
