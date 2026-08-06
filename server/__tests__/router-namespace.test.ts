import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';

// Router-level namespace wiring — the branches that live in router.ts itself, not in the
// handlers/resolver it delegates to (those are covered in resolve-namespace / namespaces-
// handler tests). Specifically:
//   - a namespaced route gates on resolveNamespace: DENY short-circuits to 403 BEFORE the
//     handler runs; ALLOW invokes the handler with the resolved namespace;
//   - /health reports the universe readiness flag;
//   - /namespaces/:ns/access rejects an invalid namespace name with 400 (pre-SSAR);
//   - /my-namespace dispatches GET vs PATCH and 405s an unsupported method.
//
// We drive the REAL router + real resolveNamespace through mocked LEAF deps (bun's
// mock.module is process-global, so we never module-mock resolve-namespace / the handlers
// that sibling files test directly). Auth uses the dev-token path; CSRF passes with an
// empty expectedDomain. Re-assert mocks in beforeEach so a sibling file's mocks don't win.

import * as configModule from '../k8s/config';

let ssarVerdict = true; // controls resolveNamespace's live SSAR (allow/deny)
// The namespace the REAL workspaces handler ends up listing against — captured from the
// mocked K8s client's listNamespacedCustomObject(group, version, NAMESPACE, ...) call. This
// is how we observe what the router resolved, without module-mocking the handler (a
// process-global handler mock would clobber workspaces.test.ts).
const listedNamespaces: string[] = [];

function installMocks() {
  // Dev mode + a devAccessToken so extractAuth returns a jwt without cookie machinery;
  // empty expectedDomain so validateCSRF passes. serverConfig.namespace is the exempt default.
  mock.module('../k8s/config', () => ({
    ...configModule,
    isLocalDevelopment: () => true,
    serverConfig: {
      ...configModule.serverConfig,
      namespace: 'default-ns',
      devAccessToken: 'dev-jwt',
      session: { ...configModule.serverConfig.session, enabled: false, expectedDomain: '' },
    },
  }));
  // The SSAR client resolveNamespace calls for a non-default namespace. Superset export set:
  // sibling real modules loaded via the router (templates/access-strategies handlers) import
  // reuseOrCreateUserK8sClient, so the winning mock must satisfy every ../k8s/client import.
  mock.module('../k8s/client', () => ({
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateUserK8sClient: async () => ({
      // Capture the namespace arg (3rd positional) so we can assert what the router resolved.
      listNamespacedCustomObject: async (_group: string, _version: string, namespace: string) => {
        listedNamespaces.push(namespace);
        return { body: { items: [] } };
      },
    }),
    reuseOrCreateAuthnClient: async () => ({}),
    reuseOrCreateAuthClient: async () => ({
      createSelfSubjectAccessReview: async (body: { spec: { resourceAttributes?: { namespace?: string } } }) => ({
        body: { ...body, status: { allowed: ssarVerdict } },
      }),
    }),
  }));
  // NOTE: we module-mock NEITHER ../middleware/namespace-preference, ../k8s/namespace-universe,
  // NOR ../handlers/* — sibling files test those directly and bun's process-global mock.module
  // would clobber them (a subset mock even breaks their own imports, e.g. NS_PREF_COOKIE_NAME),
  // failing under CI's file ordering. We drive the REAL router → REAL resolveNamespace → REAL
  // preference reader (test requests carry NO cookie → empty preference → the live-SSAR branch
  // we're steering) → REAL handlers → mocked ../k8s/client leaf; the universe uses the dev
  // short-circuit (isLocalDevelopment → static list), seeded in beforeEach.
}
installMocks();

const { handleRequest } = await import('../middleware/router');
const { initNamespaceUniverse } = await import('../k8s/namespace-universe');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

beforeEach(async () => {
  installMocks();
  listedNamespaces.length = 0;
  ssarVerdict = true;
  await initNamespaceUniverse(); // dev short-circuit → universe ready (static list + default)
});

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

describe('router — namespace gating', () => {
  test('non-default ?namespace= denied by SSAR → 403 and the handler never runs', async () => {
    ssarVerdict = false;
    const res = await handleRequest(get('/api/v1/workspaces?namespace=team-secret'));
    expect(res.status).toBe(403);
    expect(listedNamespaces).toEqual([]); // short-circuited before dispatch
  });

  test('non-default ?namespace= allowed by SSAR → handler runs with the resolved namespace', async () => {
    ssarVerdict = true;
    const res = await handleRequest(get('/api/v1/workspaces?namespace=team-a'));
    expect(res.status).toBe(200);
    expect(listedNamespaces).toEqual(['team-a']);
  });

  test('the configured default namespace is exempt — no SSAR, handler runs with it', async () => {
    ssarVerdict = false; // would 403 IF an SSAR ran; the default must skip it
    const res = await handleRequest(get('/api/v1/workspaces?namespace=default-ns'));
    expect(res.status).toBe(200);
    expect(listedNamespaces).toEqual(['default-ns']);
  });

  test('absent ?namespace= falls back to the configured default (no SSAR)', async () => {
    ssarVerdict = false;
    const res = await handleRequest(get('/api/v1/workspaces'));
    expect(res.status).toBe(200);
    expect(listedNamespaces).toEqual(['default-ns']);
  });
});

describe('router — namespace endpoints', () => {
  test('/health reports the universe readiness flag (seeded ready in dev)', async () => {
    const res = await handleRequest(get('/api/v1/health'));
    expect(res.status).toBe(200);
    // The real universe was seeded via initNamespaceUniverse's dev short-circuit → ready.
    // Asserting the field is present + reflects real state (not a hardcoded literal).
    expect(await res.json()).toEqual({ status: 'ok', ready: true });
  });

  test('/namespaces/:ns/access rejects an invalid namespace name with 400 (before any SSAR)', async () => {
    const res = await handleRequest(get('/api/v1/namespaces/Invalid_NS/access'));
    expect(res.status).toBe(400);
  });

  test('/my-namespace 405s an unsupported method (only GET/PATCH dispatch)', async () => {
    const res = await handleRequest(new Request('http://localhost/api/v1/my-namespace', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });
});
