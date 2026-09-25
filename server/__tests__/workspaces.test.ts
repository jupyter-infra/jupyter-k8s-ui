import { describe, test, expect, beforeEach, mock } from 'bun:test';

// --- K8s client mock ---
// Each handler invocation talks to the cached mock. Tests can set return
// values or error responses per-test by reassigning the mock implementations.
const mockedK8s = {
  list: mock(async () => ({ body: { items: [] as Record<string, unknown>[] } })),
  get: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  create: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  replace: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  patch: mock(async () => ({ body: buildK8sWorkspace('ws-1') })),
  del: mock(async () => ({ body: {} })),
};

// Mock the specific modules that handlers now import from directly.
import * as configModule from '../k8s/config';
mock.module('../k8s/config', () => ({
  ...configModule,
  serverConfig: { ...configModule.serverConfig, namespace: 'test-ns' },
}));

mock.module('../k8s/client', () => ({
  reuseOrCreateUserK8sClient: async () => ({
    listNamespacedCustomObject: mockedK8s.list,
    getNamespacedCustomObject: mockedK8s.get,
    createNamespacedCustomObject: mockedK8s.create,
    replaceNamespacedCustomObject: mockedK8s.replace,
    patchNamespacedCustomObject: mockedK8s.patch,
    deleteNamespacedCustomObject: mockedK8s.del,
  }),
  reuseOrCreateAuthnClient: async () => ({}),
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

interface CreatedObj {
  metadata: Record<string, unknown>;
  spec: Record<string, unknown>;
}
// Bun's mock types return `[] | undefined` for `.calls.at(-1)`, which TS won't
// allow casting directly to a typed tuple. The `any` here is contained to these
// two helpers — call sites get full type safety via the return types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastCreated = (): CreatedObj => (mockedK8s.create.mock.calls.at(-1) as any)[4];
 
type PatchOp = { op: string; path: string; value?: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastPatch = (): PatchOp[] => (mockedK8s.patch.mock.calls.at(-1) as any)[5];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastPatchHeaders = (): Record<string, string> => (mockedK8s.patch.mock.calls.at(-1) as any)[9]?.headers;
const patchValue = (path: string): unknown => lastPatch().find((o) => o.path === path)?.value;

beforeEach(() => {
  mockedK8s.list.mockClear();
  mockedK8s.get.mockClear();
  mockedK8s.create.mockClear();
  mockedK8s.replace.mockClear();
  mockedK8s.patch.mockClear();
  mockedK8s.del.mockClear();
});

describe('handleCreateWorkspace', () => {
  test('rejects invalid workspace names with 400 before calling K8s', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'Invalid_Name' }));
    expect(res.status).toBe(400);
    expect(mockedK8s.create).not.toHaveBeenCalled();
  });

  test('defaults missing spec fields to Running/Public/OwnerOnly and uses name as displayName fallback', async () => {
    await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'my-ws' }));

    const obj = lastCreated();
    expect(obj.spec.displayName).toBe('my-ws');
    expect(obj.spec.desiredStatus).toBe('Running');
    expect(obj.spec.accessType).toBe('Public');
    expect(obj.spec.ownershipType).toBe('OwnerOnly');
  });

  test('only includes optional spec fields when provided', async () => {
    await handleCreateWorkspace(
      'jwt',
      'test-ns',
      jsonRequest({
        name: 'ws',
        resources: { limits: { cpu: '2' } },
        storage: { size: '20Gi' },
      }),
    );

    const obj = lastCreated();
    expect(obj.spec.resources).toEqual({ limits: { cpu: '2' } });
    expect(obj.spec.storage).toEqual({ size: '20Gi' });
    // unset fields must not appear
    expect(obj.spec).not.toHaveProperty('idleShutdown');
  });

  // idleShutdown renames `timeoutInMinutes` → `idleTimeoutInMinutes` because the
  // CRD spec uses the longer name. Catching a regression here is the whole point.
  test('renames idleShutdown.timeoutInMinutes to idleTimeoutInMinutes', async () => {
    await handleCreateWorkspace(
      'jwt',
      'test-ns',
      jsonRequest({
        name: 'ws',
        idleShutdown: { enabled: true, timeoutInMinutes: 30 },
      }),
    );

    const obj = lastCreated();
    expect(obj.spec.idleShutdown).toEqual({ enabled: true, idleTimeoutInMinutes: 30 });
  });

  test('sends workspace into configured namespace', async () => {
    await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws' }));
    const obj = lastCreated();
    expect(obj.metadata.namespace).toBe('test-ns');
  });

  // The simple-create branch must spread templateRef + image into the spec (it
  // previously spread templateRef on the advanced branch only).
  test('spreads templateRef and image from the simple-form body into the spec', async () => {
    await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws', templateRef: { name: 'gpu', namespace: 'shared' }, image: 'custom:2' }));
    const obj = lastCreated();
    expect(obj.spec.templateRef).toEqual({ name: 'gpu', namespace: 'shared' });
    expect(obj.spec.image).toBe('custom:2');
  });

  test('omits templateRef and image when the simple-form body lacks them', async () => {
    await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws' }));
    const obj = lastCreated();
    expect(obj.spec).not.toHaveProperty('templateRef');
    expect(obj.spec).not.toHaveProperty('image');
  });

  // A complete idleShutdown block (incl. detection) must round-trip verbatim through
  // create — the CRD requires detection whenever idleShutdown is present.
  test('passes idleShutdown.detection through create verbatim', async () => {
    const detection = { httpGet: { path: '/api/status', port: 8888, transport: 'network' } };
    await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws', idleShutdown: { enabled: true, timeoutInMinutes: 30, detection } }));
    const obj = lastCreated();
    expect(obj.spec.idleShutdown).toEqual({ enabled: true, idleTimeoutInMinutes: 30, detection });
  });

  test('returns 201 on success', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws' }));
    expect(res.status).toBe(201);
  });

  // Regression guard for #39: the UI once sent accessType "Private", a value the
  // CRD rejects with a 422. We now reject invalid enums with a 400 at our boundary
  // and never forward them to K8s.
  test('rejects invalid accessType with 400 before calling K8s', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws', accessType: 'Private' }));
    expect(res.status).toBe(400);
    expect(mockedK8s.create).not.toHaveBeenCalled();
  });

  test('rejects invalid ownershipType with 400 before calling K8s', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws', ownershipType: 'Everyone' }));
    expect(res.status).toBe(400);
    expect(mockedK8s.create).not.toHaveBeenCalled();
  });

  test('accepts the valid OwnerOnly accessType', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws', accessType: 'OwnerOnly' }));
    expect(res.status).toBe(201);
    expect(lastCreated().spec.accessType).toBe('OwnerOnly');
  });

  test('maps K8s errors to the correct HTTP status', async () => {
    mockedK8s.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error('conflict'), { statusCode: 409 });
    });
    const res = await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'ws' }));
    expect(res.status).toBe(409);
  });
});

describe('handleUpdateWorkspace', () => {
  test('patches only the fields the body carries, without reading the object first', async () => {
    await handleUpdateWorkspace('jwt', 'test-ns', 'ws', jsonRequest({ displayName: 'new' }, 'PUT'));

    expect(mockedK8s.get).not.toHaveBeenCalled();
    expect(lastPatch()).toEqual([{ op: 'add', path: '/spec/displayName', value: 'new' }]);
  });

  // A JSON Patch carries no resourceVersion, so the operator's status writes on the same
  // object cannot make it fail with a conflict.
  test('sends the patch with the json-patch content type', async () => {
    await handleUpdateWorkspace('jwt', 'test-ns', 'ws', jsonRequest({ desiredStatus: 'Stopped' }, 'PATCH'));

    expect(lastPatchHeaders()).toEqual({ 'Content-Type': 'application/json-patch+json' });
    expect(patchValue('/spec/desiredStatus')).toBe('Stopped');
  });

  test('renames idleShutdown.timeoutInMinutes on update too', async () => {
    await handleUpdateWorkspace('jwt', 'test-ns', 'ws', jsonRequest({ idleShutdown: { enabled: true, timeoutInMinutes: 45 } }, 'PATCH'));
    expect(patchValue('/spec/idleShutdown')).toEqual({ enabled: true, idleTimeoutInMinutes: 45 });
  });

  // The wholesale idleShutdown replace must carry detection through on update, since
  // the client echoes the workspace's own detection verbatim (no server-side merge).
  test('passes idleShutdown.detection through update verbatim', async () => {
    const detection = { httpGet: { path: '/api/status', port: 8888 } };
    await handleUpdateWorkspace('jwt', 'test-ns', 'ws', jsonRequest({ idleShutdown: { enabled: true, timeoutInMinutes: 45, detection } }, 'PATCH'));
    expect(patchValue('/spec/idleShutdown')).toEqual({ enabled: true, idleTimeoutInMinutes: 45, detection });
  });

  test('rejects invalid accessType with 400 before touching K8s', async () => {
    const res = await handleUpdateWorkspace('jwt', 'test-ns', 'ws', jsonRequest({ accessType: 'Private' }, 'PATCH'));
    expect(res.status).toBe(400);
    expect(mockedK8s.patch).not.toHaveBeenCalled();
  });

  test('returns 404 when workspace does not exist', async () => {
    mockedK8s.patch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    });
    const res = await handleUpdateWorkspace('jwt', 'test-ns', 'missing', jsonRequest({ displayName: 'x' }, 'PUT'));
    expect(res.status).toBe(404);
  });
});

describe('handleListWorkspaces / handleGetWorkspace / handleDeleteWorkspace', () => {
  test('list returns mapped array from K8s items', async () => {
    mockedK8s.list.mockImplementationOnce(async () => ({
      body: { items: [buildK8sWorkspace('a'), buildK8sWorkspace('b')] },
    }));

    const res = await handleListWorkspaces('jwt', 'test-ns');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ metadata: { name: string } }>;
    expect(body.map((w) => w.metadata.name)).toEqual(['a', 'b']);
  });

  test('get returns 404 when K8s returns 404', async () => {
    mockedK8s.get.mockImplementationOnce(async () => {
      throw Object.assign(new Error('nf'), { statusCode: 404 });
    });
    const res = await handleGetWorkspace('jwt', 'test-ns', 'ghost');
    expect(res.status).toBe(404);
  });

  test('delete returns 200 with success message', async () => {
    const res = await handleDeleteWorkspace('jwt', 'test-ns', 'ws');
    expect(res.status).toBe(200);
    expect(mockedK8s.del).toHaveBeenCalled();
  });
});

// --- Advanced editor: raw-spec payload + dry-run ---

function advancedRequest(body: unknown, method = 'POST', dryRun = false) {
  const url = dryRun ? 'http://x/api/v1/workspaces?dryRun=All' : 'http://x/api/v1/workspaces';
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// dryRun is the 7th positional arg (index 6) on both create and patch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastCreateDryRun = (): unknown => (mockedK8s.create.mock.calls.at(-1) as any)[6];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastPatchDryRun = (): unknown => (mockedK8s.patch.mock.calls.at(-1) as any)[6];

describe('advanced create (raw spec)', () => {
  test('uses the raw spec verbatim instead of building from form fields', async () => {
    await handleCreateWorkspace(
      'jwt',
      'test-ns',
      advancedRequest({ name: 'adv-ws', spec: { displayName: 'Adv', image: 'custom:1', env: [{ name: 'X', value: 'y' }] } }),
    );
    const obj = lastCreated();
    expect(obj.spec.image).toBe('custom:1');
    expect(obj.spec.env).toEqual([{ name: 'X', value: 'y' }]);
    // No form defaults injected — the advanced spec is authoritative.
    expect(obj.spec).not.toHaveProperty('ownershipType');
  });

  test('merges the hoisted templateRef into the spec', async () => {
    await handleCreateWorkspace('jwt', 'test-ns', advancedRequest({ name: 'adv-ws', templateRef: { name: 'gpu-small' }, spec: { displayName: 'Adv' } }));
    const obj = lastCreated();
    expect(obj.spec.templateRef).toEqual({ name: 'gpu-small' });
  });

  test('still validates the workspace name', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', advancedRequest({ name: 'Bad_Name', spec: { displayName: 'x' } }));
    expect(res.status).toBe(400);
    expect(mockedK8s.create).not.toHaveBeenCalled();
  });
});

describe('dry-run threading', () => {
  test('create passes dryRun=All to the client and returns {valid:true} without a resource', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', advancedRequest({ name: 'adv-ws', spec: { displayName: 'x' } }, 'POST', true));
    expect(lastCreateDryRun()).toBe('All');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  test('create without dryRun passes undefined and returns the created resource (201)', async () => {
    const res = await handleCreateWorkspace('jwt', 'test-ns', advancedRequest({ name: 'adv-ws', spec: { displayName: 'x' } }));
    expect(lastCreateDryRun()).toBeUndefined();
    expect(res.status).toBe(201);
  });

  test('update passes dryRun=All and returns {valid:true}', async () => {
    const res = await handleUpdateWorkspace('jwt', 'test-ns', 'ws-1', advancedRequest({ name: 'ws-1', spec: { displayName: 'x' } }, 'PUT', true));
    expect(lastPatchDryRun()).toBe('All');
    expect(await res.json()).toEqual({ valid: true });
  });
});

describe('advanced update replaces the whole spec', () => {
  test('patches /spec as one value so removed fields disappear', async () => {
    // The editor buffer is the desired spec: a field absent from it must not survive.
    await handleUpdateWorkspace('jwt', 'test-ns', 'ws-1', advancedRequest({ name: 'ws-1', spec: { displayName: 'only-this' } }, 'PUT'));
    expect(lastPatch()).toEqual([{ op: 'add', path: '/spec', value: { displayName: 'only-this' } }]);
  });

  test('merges the hoisted templateRef into the replaced spec', async () => {
    await handleUpdateWorkspace(
      'jwt',
      'test-ns',
      'ws-1',
      advancedRequest({ name: 'ws-1', templateRef: { name: 'gpu-small' }, spec: { displayName: 'x' } }, 'PUT'),
    );
    expect(patchValue('/spec')).toEqual({ displayName: 'x', templateRef: { name: 'gpu-small' } });
  });

  test('a field-shaped body touches only its own paths', async () => {
    // Contrast: nothing else in the spec is written, so desiredStatus is preserved.
    await handleUpdateWorkspace('jwt', 'test-ns', 'ws-1', jsonRequest({ displayName: 'merged' }, 'PUT'));
    expect(lastPatch().map((o) => o.path)).toEqual(['/spec/displayName']);
  });
});

describe('accelerator keys relay verbatim', () => {
  test('create passes extended-resource limits through untouched', async () => {
    await handleCreateWorkspace('jwt', 'test-ns', jsonRequest({ name: 'gpu-ws', resources: { limits: { cpu: '1', memory: '2Gi', 'nvidia.com/gpu': '2' } } }));
    const spec = lastCreated().spec as { resources?: { limits?: Record<string, string> } };
    expect(spec.resources?.limits?.['nvidia.com/gpu']).toBe('2');
  });

  test('update passes extended-resource limits through untouched', async () => {
    await handleUpdateWorkspace(
      'jwt',
      'test-ns',
      'ws-1',
      jsonRequest({ resources: { limits: { cpu: '1', memory: '2Gi', 'nvidia.com/mig-1g.5gb': '1' } } }, 'PATCH'),
    );
    const resources = patchValue('/spec/resources') as { limits?: Record<string, string> };
    expect(resources.limits?.['nvidia.com/mig-1g.5gb']).toBe('1');
  });
});
