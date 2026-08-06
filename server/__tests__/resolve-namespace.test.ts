import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { randomBytes } from 'crypto';
import { KEY_LENGTH, deriveKeys, sign } from '../crypto';
import type { KeyEntry, KeyMap } from '../middleware/session';

// resolveNamespace's exemption boundary is the key new contract: the configured default
// (and absent) MUST skip SSAR (back-compat, token-enforced), while a non-default namespace
// is gated — in the fresh visible snapshot first, else exactly one live checkNamespaceAccess.

import * as configModule from '../k8s/config';

// We drive the REAL checkNamespaceAccess (no ../k8s/access mock — that module is tested
// directly in access.test.ts and mocking it here would clobber that file's registry entry
// for the whole run). Instead we mock the SSAR client it calls, and record the namespaces.
const ssarCalls: Array<{ jwt: string; ns: string }> = [];
let ssarVerdict = true;
// When set, the mocked SSAR throws instead of returning a verdict (transient failure).
let ssarThrows = false;

// We DON'T module-mock ../middleware/namespace-preference: namespace-preference.test.ts
// tests it directly, and bun's mock.module is process-global, so a mock here (even a subset)
// leaks into that file's import under CI's ordering — breaking it. Instead we drive the REAL
// module via a real signed cookie, mocking only its leaf (secret-watcher's getKeyMap).
let testKeyMap: KeyMap = { keys: new Map() };
mock.module('../secret-watcher', () => ({ getKeyMap: () => testKeyMap }));

// bun's mock.module is process-global + import-time; re-assert in beforeEach so a sibling
// file's mocks of these shared modules don't win during our tests.
function installMocks() {
  mock.module('../k8s/config', () => ({
    ...configModule,
    serverConfig: { ...configModule.serverConfig, namespace: 'default-ns' },
  }));
  mock.module('../k8s/client', () => ({
    // Superset: sibling test files statically import different exports from ../k8s/client,
    // and whichever mock wins at import time must satisfy all of them — incl.
    // reuseOrCreateUserK8sClient (handlers/workspaces.ts), else `bun run test:server` fails
    // on the file that loads after us.
    reuseOrCreateUserK8sClient: async () => ({}),
    reuseOrCreateAuthnClient: async () => ({}),
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateAuthClient: async (jwt: string | null) => ({
      createSelfSubjectAccessReview: async (body: { spec: { resourceAttributes?: { namespace?: string } } }) => {
        ssarCalls.push({ jwt: jwt ?? '', ns: body.spec.resourceAttributes?.namespace ?? '' });
        if (ssarThrows) throw Object.assign(new Error('ssar blip'), { statusCode: 503 });
        return { body: { status: { allowed: ssarVerdict } } };
      },
    }),
  }));
  mock.module('../secret-watcher', () => ({ getKeyMap: () => testKeyMap }));
}
installMocks();

const { resolveNamespace } = await import('../k8s/resolve-namespace');
const { NS_PREF_COOKIE_NAME } = await import('../middleware/namespace-preference');

function keyMapWith(kid = 'k1'): KeyMap {
  const entry: KeyEntry = { kid, key: randomBytes(KEY_LENGTH), addedTime: Date.now() - 120_000 };
  return { keys: new Map([[kid, entry]]) };
}

/**
 * Sign a preference payload into a cookie value, exactly matching the module's on-wire format
 * (`base64url(payload).kid.base64url(sig)`) — so the REAL readNamespacePreference parses it.
 * Unlike buildNamespacePreferenceCookie (which always re-stamps visibleExp to "now + TTL"),
 * this lets us set an ALREADY-EXPIRED `visibleExp` to exercise the stale-snapshot branch.
 */
function signPref(over: { visible?: string[]; visibleExp: number }): string {
  const entry = [...testKeyMap.keys.values()][0];
  const { signingKey } = deriveKeys(entry.key);
  // boundUser: '' matches userTag('jwt') (the test jwt is unparseable → '') so the identity
  // gate in readNamespacePreference honors this cookie for resolveNamespace's 'jwt' caller.
  const payload = {
    activeNs: null,
    visible: over.visible ?? [],
    checkedUpTo: (over.visible ?? []).length,
    universeFp: 'fp',
    visibleExp: over.visibleExp,
    boundUser: '',
  };
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = sign(payloadBuf, signingKey, entry.kid);
  return `${payloadBuf.toString('base64url')}.${entry.kid}.${signature.toString('base64url')}`;
}

/**
 * A request whose signed preference cookie carries a `visible` snapshot; the real
 * readNamespacePreference parses it (no module mock). `fresh: false` stamps an expired
 * `visibleExp` so freshVisible must ignore the snapshot and fall to the live SSAR.
 */
function req(ns?: string, opts: { visible?: string[]; fresh?: boolean } = {}): Request {
  const url = ns ? `http://x/api/v1/workspaces?namespace=${ns}` : 'http://x/api/v1/workspaces';
  const headers: Record<string, string> = {};
  if (opts.visible && opts.visible.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const value = signPref({ visible: opts.visible, visibleExp: opts.fresh === false ? now - 60 : now + 3600 });
    headers.Cookie = `${NS_PREF_COOKIE_NAME}=${value}`;
  }
  return new Request(url, { headers });
}

beforeEach(() => {
  installMocks();
  testKeyMap = keyMapWith();
  ssarCalls.length = 0;
  ssarVerdict = true;
  ssarThrows = false;
});

describe('resolveNamespace exemption boundary', () => {
  test('absent ?namespace= → configured default, NO SSAR', async () => {
    const res = await resolveNamespace(req(), 'jwt');
    expect(res).toEqual({ ok: true, namespace: 'default-ns' });
    expect(ssarCalls).toEqual([]);
  });

  test('?namespace=<default> → used, NO SSAR (back-compat exempt)', async () => {
    const res = await resolveNamespace(req('default-ns'), 'jwt');
    expect(res).toEqual({ ok: true, namespace: 'default-ns' });
    expect(ssarCalls).toEqual([]);
  });

  test('non-default in fresh visible → used, NO live SSAR', async () => {
    const res = await resolveNamespace(req('team-a', { visible: ['team-a'], fresh: true }), 'jwt');
    expect(res).toEqual({ ok: true, namespace: 'team-a' });
    expect(ssarCalls).toEqual([]);
  });

  test('non-default not in visible → exactly one live SSAR; allowed → used', async () => {
    ssarVerdict = true;
    const res = await resolveNamespace(req('team-b'), 'jwt');
    expect(res).toEqual({ ok: true, namespace: 'team-b' });
    expect(ssarCalls).toEqual([{ jwt: 'jwt', ns: 'team-b' }]);
  });

  test('non-default not in visible → SSAR denies → 403', async () => {
    ssarVerdict = false;
    const res = await resolveNamespace(req('team-c'), 'jwt');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(ssarCalls).toEqual([{ jwt: 'jwt', ns: 'team-c' }]);
  });

  test('non-default, SSAR errors (transient) → NOT a 403; defer to the user token downstream', async () => {
    // A blip must not manufacture a 403 the API server wouldn't. The SSAR is a display hint;
    // an indeterminate verdict lets the request through so the user's own token is the gate.
    ssarThrows = true;
    const res = await resolveNamespace(req('team-d'), 'jwt');
    expect(res).toEqual({ ok: true, namespace: 'team-d' });
    expect(ssarCalls).toEqual([{ jwt: 'jwt', ns: 'team-d' }]);
  });

  test('expired snapshot → visible membership is ignored, live SSAR runs', async () => {
    await resolveNamespace(req('team-a', { visible: ['team-a'], fresh: false }), 'jwt');
    expect(ssarCalls).toEqual([{ jwt: 'jwt', ns: 'team-a' }]);
  });

  test('malformed namespace → 400 before any SSAR', async () => {
    const res = await resolveNamespace(req('Bad_NS'), 'jwt');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
    expect(ssarCalls).toEqual([]);
  });
});
