import { describe, expect, test } from 'bun:test';
import type { CustomObjectsApi } from '@kubernetes/client-node';
import { discoverAcrossNamespaces } from '../k8s/discovery';

interface Item {
  metadata: { name: string };
}

// Build a mock client whose list behavior is keyed by namespace: a value returns
// items, an Error is thrown (to simulate 403/404 or transport failures).
function mockClient(byNamespace: Record<string, Item[] | Error>): CustomObjectsApi {
  return {
    listNamespacedCustomObject: async (_g: string, _v: string, namespace: string) => {
      const entry = byNamespace[namespace];
      if (entry instanceof Error) throw entry;
      return { body: { items: entry ?? [] } };
    },
  } as unknown as CustomObjectsApi;
}

function forbidden(): Error {
  return Object.assign(new Error('forbidden'), { statusCode: 403 });
}

describe('discoverAcrossNamespaces', () => {
  test('merges items from user and shared namespaces, tagging source', async () => {
    const client = mockClient({
      'user-ns': [{ metadata: { name: 'local' } }],
      shared: [{ metadata: { name: 'org-default' } }],
    });
    const result = await discoverAcrossNamespaces<Item>(client, 'plural', 'user-ns', 'shared');
    const byName = Object.fromEntries(result.items.map((i) => [i.metadata.name, i.sourceNamespace]));
    expect(byName).toEqual({ local: 'user-ns', 'org-default': 'shared' });
    expect(result.access).toEqual({ user: 'ok', shared: 'ok' });
  });

  test('user-namespace entry overrides a same-named shared entry', async () => {
    const client = mockClient({
      'user-ns': [{ metadata: { name: 'dup' } }],
      shared: [{ metadata: { name: 'dup' } }],
    });
    const result = await discoverAcrossNamespaces<Item>(client, 'plural', 'user-ns', 'shared');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceNamespace).toBe('user-ns');
  });

  // The headline graceful-degradation contract: a 403 on the shared namespace is
  // "empty from that source", not a failure. Returns the user's items.
  test('treats a 403 on the shared namespace as empty, not an error', async () => {
    const client = mockClient({
      'user-ns': [{ metadata: { name: 'local' } }],
      shared: forbidden(),
    });
    const result = await discoverAcrossNamespaces<Item>(client, 'plural', 'user-ns', 'shared');
    expect(result.items.map((i) => i.metadata.name)).toEqual(['local']);
    expect(result.access).toEqual({ user: 'ok', shared: 'denied' });
  });

  test('treats a 403 on BOTH namespaces as empty with denied access, no throw', async () => {
    const client = mockClient({ 'user-ns': forbidden(), shared: forbidden() });
    const result = await discoverAcrossNamespaces<Item>(client, 'plural', 'user-ns', 'shared');
    expect(result.items).toEqual([]);
    expect(result.access).toEqual({ user: 'denied', shared: 'denied' });
  });

  test('re-throws non-access errors (e.g. auth/transport) so they surface', async () => {
    const client = mockClient({ 'user-ns': Object.assign(new Error('boom'), { statusCode: 500 }) });
    await expect(discoverAcrossNamespaces<Item>(client, 'plural', 'user-ns', 'shared')).rejects.toThrow('boom');
  });

  test('lists only once when user and shared namespaces are the same', async () => {
    let calls = 0;
    const client = {
      listNamespacedCustomObject: async () => {
        calls++;
        return { body: { items: [{ metadata: { name: 'x' } }] } };
      },
    } as unknown as CustomObjectsApi;
    const result = await discoverAcrossNamespaces<Item>(client, 'plural', 'same', 'same');
    expect(calls).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});
