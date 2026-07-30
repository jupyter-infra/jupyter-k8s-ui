import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { V1NamespaceList } from '@kubernetes/client-node';

// The poll's source decision (sa-list → static fallback) is re-evaluated statelessly each
// tick: success → labeled+default, 403 → static, transient → last-known-good. We drive
// listNamespace to return a labeled set, a 403, or a transient error and assert the
// universe each time. We force non-dev so the real poll path runs.

import * as configModule from '../k8s/config';

let listImpl: () => Promise<{ body: V1NamespaceList }>;

// bun's mock.module is process-global and evaluated at import time; re-assert this file's
// config + client mocks in beforeEach so a sibling file's mocks don't win during our tests.
function installMocks() {
  mock.module('../k8s/config', () => ({
    ...configModule,
    serverConfig: {
      ...configModule.serverConfig,
      namespace: 'default-ns',
      namespaceSelection: { ...configModule.serverConfig.namespaceSelection, staticNamespaces: ['static-a'], labelSelector: 'x=true', pollIntervalSecs: 3600 },
    },
    isLocalDevelopment: () => false,
  }));
  mock.module('../k8s/client', () => ({
    // Superset (see resolve-namespace.test.ts): satisfy all sibling static imports.
    // mock.module is process-global, so this must export EVERY name any sibling test's
    // statically-imported module needs — incl. reuseOrCreateUserK8sClient (handlers/
    // workspaces.ts), or `bun run test:server` fails on whichever file loads after us.
    reuseOrCreateUserK8sClient: async () => ({}),
    reuseOrCreateAuthClient: async () => ({ createSelfSubjectAccessReview: async () => ({ body: { status: { allowed: true } } }) }),
    loadKubeConfigBestEffort: () => ({
      makeApiClient: () => ({ listNamespace: () => listImpl() }),
    }),
  }));
}
installMocks();

const { initNamespaceUniverse, getNamespaceUniverse, isNamespaceUniverseReady, stopNamespaceUniverse } = await import('../k8s/namespace-universe');

function nsList(...names: string[]): { body: V1NamespaceList } {
  return { body: { items: names.map((name) => ({ metadata: { name } })) } as V1NamespaceList };
}

function forbidden() {
  return Object.assign(new Error('forbidden'), { statusCode: 403 });
}

beforeEach(() => {
  installMocks();
  stopNamespaceUniverse();
});

describe('namespace universe poll', () => {
  test('sa-list success → labeled set unioned with the configured default', async () => {
    listImpl = async () => nsList('team-a', 'team-b');
    await initNamespaceUniverse();
    expect(isNamespaceUniverseReady()).toBe(true);
    expect(getNamespaceUniverse().sort()).toEqual(['default-ns', 'team-a', 'team-b']);
    stopNamespaceUniverse();
  });

  test('403 on initial LIST → static fallback (with default injected)', async () => {
    listImpl = async () => {
      throw forbidden();
    };
    await initNamespaceUniverse();
    expect(getNamespaceUniverse().sort()).toEqual(['default-ns', 'static-a']);
    stopNamespaceUniverse();
  });

  test('default is always injected even when labeled set omits it', async () => {
    listImpl = async () => nsList('team-only');
    await initNamespaceUniverse();
    expect(getNamespaceUniverse()).toContain('default-ns');
    stopNamespaceUniverse();
  });

  test('transient error on first sync still becomes ready (seeded static, not blocked)', async () => {
    listImpl = async () => {
      throw Object.assign(new Error('timeout'), { statusCode: 503 });
    };
    await initNamespaceUniverse();
    expect(isNamespaceUniverseReady()).toBe(true);
    expect(getNamespaceUniverse()).toContain('default-ns');
    stopNamespaceUniverse();
  });
});
