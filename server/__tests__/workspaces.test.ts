import { describe, test, expect, beforeEach, mock } from 'bun:test';

// --- K8s client mock ---
// Each handler invocation talks to the cached mock. Tests can set return
// values or error responses per-test by reassigning the mock implementations.
const k8s = {
  list: mock(async () => ({ body: { items: [] as Record<string, unknown>[] } })),
  get: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  create: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  replace: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  del: mock(async () => ({ body: {} })),
};

// Only replace what we need: createUserK8sClient (so we can inject a fake
// client) and serverConfig.namespace (so handlers send to a predictable ns).
// Keep workspaceToResponse/templateToResponse as the real implementations so
// tests exercise the full mapping. Importantly, we preserve all other exports
// from the module — naming only the stubs we override would globally erase
// everything else for other test files that run in the same process.
import * as k8sModule from '../k8s';
mock.module('../k8s', () => ({
  ...k8sModule,
  serverConfig: { ...k8sModule.serverConfig, namespace: 'test-ns' },
  createUserK8sClient: async () => ({
    listNamespacedCustomObject: k8s.list,
    getNamespacedCustomObject: k8s.get,
    createNamespacedCustomObject: k8s.create,
    replaceNamespacedCustomObject: k8s.replace,
    deleteNamespacedCustomObject: k8s.del,
  }),
}));

import { handleListWorkspaces, handleGetWorkspace, handleCreateWorkspace, handleUpdateWorkspace, handleDeleteWorkspace } from '../handlers/workspaces';

function buildK8sWorkspace(name: string) {
  return {
    apiVersion: 'workspace.jupyter.org/v1alpha1',
    kind: 'Workspace',
    metadata: { name, namespace: 'test-ns' },
    spec: { displayName: name, desiredStatus: 'Running' },
  };
}

function jsonRequest(body: unknown, method = 'POST') {
  return new Request('http://x/api/v1/workspaces', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  k8s.list.mockClear();
  k8s.get.mockClear();
  k8s.create.mockClear();
  k8s.replace.mockClear();
  k8s.del.mockClear();
});

describe('handleCreateWorkspace', () => {
  test('rejects invalid workspace names with 400 before calling K8s', async () => {
    const res = await handleCreateWorkspace('jwt', jsonRequest({ name: 'Invalid_Name' }));
    expect(res.status).toBe(400);
    expect(k8s.create).not.toHaveBeenCalled();
  });

  test('defaults missing spec fields to Running/Public/OwnerOnly and uses name as displayName fallback', async () => {
    await handleCreateWorkspace('jwt', jsonRequest({ name: 'my-ws' }));

    const [, , , , obj] = k8s.create.mock.calls[0] as unknown[] as [string, string, string, string, { spec: Record<string, unknown> }];
    expect(obj.spec.displayName).toBe('my-ws');
    expect(obj.spec.desiredStatus).toBe('Running');
    expect(obj.spec.accessType).toBe('Public');
    expect(obj.spec.ownershipType).toBe('OwnerOnly');
  });

  test('only includes optional spec fields when provided', async () => {
    await handleCreateWorkspace(
      'jwt',
      jsonRequest({
        name: 'ws',
        image: 'jupyter:latest',
        resources: { limits: { cpu: '2' } },
      }),
    );

    const [, , , , obj] = k8s.create.mock.calls[0] as unknown[] as [string, string, string, string, { spec: Record<string, unknown> }];
    expect(obj.spec.image).toBe('jupyter:latest');
    expect(obj.spec.resources).toEqual({ limits: { cpu: '2' } });
    // unset fields must not appear
    expect(obj.spec).not.toHaveProperty('storage');
    expect(obj.spec).not.toHaveProperty('templateRef');
    expect(obj.spec).not.toHaveProperty('idleShutdown');
  });

  // idleShutdown renames `timeoutInMinutes` → `idleTimeoutInMinutes` because the
  // CRD spec uses the longer name. Catching a regression here is the whole point.
  test('renames idleShutdown.timeoutInMinutes to idleTimeoutInMinutes', async () => {
    await handleCreateWorkspace(
      'jwt',
      jsonRequest({
        name: 'ws',
        idleShutdown: { enabled: true, timeoutInMinutes: 30 },
      }),
    );

    const [, , , , obj] = k8s.create.mock.calls[0] as unknown[] as [string, string, string, string, { spec: { idleShutdown: Record<string, unknown> } }];
    expect(obj.spec.idleShutdown).toEqual({ enabled: true, idleTimeoutInMinutes: 30 });
  });

  test('sends workspace into configured namespace', async () => {
    await handleCreateWorkspace('jwt', jsonRequest({ name: 'ws' }));
    const [, , , , obj] = k8s.create.mock.calls[0] as unknown[] as [string, string, string, string, { metadata: { namespace: string } }];
    expect(obj.metadata.namespace).toBe('test-ns');
  });

  test('returns 201 on success', async () => {
    const res = await handleCreateWorkspace('jwt', jsonRequest({ name: 'ws' }));
    expect(res.status).toBe(201);
  });

  test('maps K8s errors to the correct HTTP status', async () => {
    k8s.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error('conflict'), { statusCode: 409 });
    });
    const res = await handleCreateWorkspace('jwt', jsonRequest({ name: 'ws' }));
    expect(res.status).toBe(409);
  });
});

describe('handleUpdateWorkspace', () => {
  test('merges body fields into existing spec, leaving unspecified fields untouched', async () => {
    k8s.get.mockImplementationOnce(async () => ({
      body: {
        apiVersion: 'workspace.jupyter.org/v1alpha1',
        kind: 'Workspace',
        metadata: { name: 'ws', namespace: 'test-ns' },
        spec: { displayName: 'old', image: 'old:img', desiredStatus: 'Running' },
      },
    }));

    await handleUpdateWorkspace('jwt', 'ws', jsonRequest({ displayName: 'new' }, 'PUT'));

    const [, , , , , updated] = k8s.replace.mock.calls[0] as unknown[] as [string, string, string, string, string, { spec: Record<string, unknown> }];
    expect(updated.spec.displayName).toBe('new');
    expect(updated.spec.image).toBe('old:img'); // preserved
    expect(updated.spec.desiredStatus).toBe('Running'); // preserved
  });

  test('renames idleShutdown.timeoutInMinutes on update too', async () => {
    k8s.get.mockImplementationOnce(async () => ({ body: buildK8sWorkspace('ws') }));

    await handleUpdateWorkspace('jwt', 'ws', jsonRequest({ idleShutdown: { enabled: true, timeoutInMinutes: 45 } }, 'PATCH'));

    const [, , , , , updated] = k8s.replace.mock.calls[0] as unknown[] as [
      string,
      string,
      string,
      string,
      string,
      { spec: { idleShutdown: Record<string, unknown> } },
    ];
    expect(updated.spec.idleShutdown).toEqual({ enabled: true, idleTimeoutInMinutes: 45 });
  });

  test('returns 404 when workspace does not exist', async () => {
    k8s.get.mockImplementationOnce(async () => {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    });
    const res = await handleUpdateWorkspace('jwt', 'missing', jsonRequest({ displayName: 'x' }, 'PUT'));
    expect(res.status).toBe(404);
    expect(k8s.replace).not.toHaveBeenCalled();
  });
});

describe('handleListWorkspaces / handleGetWorkspace / handleDeleteWorkspace', () => {
  test('list returns mapped array from K8s items', async () => {
    k8s.list.mockImplementationOnce(async () => ({
      body: { items: [buildK8sWorkspace('a'), buildK8sWorkspace('b')] },
    }));

    const res = await handleListWorkspaces('jwt');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ metadata: { name: string } }>;
    expect(body.map((w) => w.metadata.name)).toEqual(['a', 'b']);
  });

  test('get returns 404 when K8s returns 404', async () => {
    k8s.get.mockImplementationOnce(async () => {
      throw Object.assign(new Error('nf'), { statusCode: 404 });
    });
    const res = await handleGetWorkspace('jwt', 'ghost');
    expect(res.status).toBe(404);
  });

  test('delete returns 200 with success message', async () => {
    const res = await handleDeleteWorkspace('jwt', 'ws');
    expect(res.status).toBe(200);
    expect(k8s.del).toHaveBeenCalled();
  });
});
