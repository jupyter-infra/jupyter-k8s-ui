import { describe, test, expect, mock, beforeEach } from 'bun:test';

// resolveNamespace's exemption boundary is the key new contract: the configured default
// (and absent) MUST skip SSAR (back-compat, token-enforced), while a non-default namespace
// is gated — in the fresh visible snapshot first, else exactly one live checkNamespaceAccess.

import * as configModule from '../k8s/config';

// We drive the REAL checkNamespaceAccess (no ../k8s/access mock — that module is tested
// directly in access.test.ts and mocking it here would clobber that file's registry entry
// for the whole run). Instead we mock the SSAR client it calls, and record the namespaces.
const ssarCalls: Array<{ jwt: string; ns: string }> = [];
let ssarVerdict = true;
// Mock the preference cookie reader: tests set the visible snapshot + its freshness.
let prefVisible: string[] = [];
let prefVisibleFresh = true;

// bun's mock.module is process-global + import-time; re-assert in beforeEach so a sibling
// file's mocks of these shared modules don't win during our tests.
function installMocks() {
  mock.module('../k8s/config', () => ({
    ...configModule,
    serverConfig: { ...configModule.serverConfig, namespace: 'default-ns' },
  }));
  mock.module('../k8s/client', () => ({
    // Superset: sibling test files statically import different exports from ../k8s/client,
    // and whichever mock wins at import time must satisfy all of them.
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateAuthClient: async (jwt: string | null) => ({
      createSelfSubjectAccessReview: async (body: { spec: { resourceAttributes?: { namespace?: string } } }) => {
        ssarCalls.push({ jwt: jwt ?? '', ns: body.spec.resourceAttributes?.namespace ?? '' });
        return { body: { status: { allowed: ssarVerdict } } };
      },
    }),
  }));
  mock.module('../middleware/namespace-preference', () => ({
    readNamespacePreference: () => ({ activeNs: null, visible: prefVisible, visibleExp: prefVisibleFresh ? 9_999_999_999 : 0 }),
    freshVisible: (pref: { visible: string[] }) => (prefVisibleFresh ? pref.visible : []),
  }));
}
installMocks();

const { resolveNamespace } = await import('../k8s/resolve-namespace');

function req(ns?: string): Request {
  const url = ns ? `http://x/api/v1/workspaces?namespace=${ns}` : 'http://x/api/v1/workspaces';
  return new Request(url);
}

beforeEach(() => {
  installMocks();
  ssarCalls.length = 0;
  ssarVerdict = true;
  prefVisible = [];
  prefVisibleFresh = true;
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
    prefVisible = ['team-a'];
    const res = await resolveNamespace(req('team-a'), 'jwt');
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

  test('expired snapshot → visible membership is ignored, live SSAR runs', async () => {
    prefVisible = ['team-a'];
    prefVisibleFresh = false;
    await resolveNamespace(req('team-a'), 'jwt');
    expect(ssarCalls).toEqual([{ jwt: 'jwt', ns: 'team-a' }]);
  });

  test('malformed namespace → 400 before any SSAR', async () => {
    const res = await resolveNamespace(req('Bad_NS'), 'jwt');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
    expect(ssarCalls).toEqual([]);
  });
});
