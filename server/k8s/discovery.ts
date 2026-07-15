// Two-namespace discovery fan-out for templates and access strategies.
//
// Templates and access strategies are discoverable in BOTH the user's namespace and
// the shared namespace (jupyter-k8s-shared). We list from both using the USER'S token,
// never the service account: we must never surface a resource the user's own RBAC
// can't discover. Results are merged and deduped by name.
//
// Partial success is normal, not an error: a user may legitimately lack `list` on the
// shared namespace while still being able to reference resources in it. So a per-
// namespace 403/404 is treated as "empty from that source", and we report which
// sources succeeded so the UI can degrade gracefully.

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { CRD_GROUP, CRD_VERSION } from './constants';
import type { K8sListResponse } from '../types';
import { log } from '../logger';

export type NamespaceAccess = 'ok' | 'denied';

export interface DiscoveryResult<T> {
  items: Array<T & { sourceNamespace: string }>;
  access: { user: NamespaceAccess; shared: NamespaceAccess };
}

interface HasMetadataName {
  metadata?: { name?: string };
}

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number })?.statusCode;
}

/**
 * List a namespaced custom resource, returning [] for "expected" access failures
 * (403 Forbidden / 404 Not Found — e.g. the shared namespace doesn't exist or the
 * user can't list it) and re-throwing anything else (auth, transport) so it surfaces.
 */
async function listOrEmpty<T>(client: CustomObjectsApi, namespace: string, plural: string): Promise<{ items: T[]; access: NamespaceAccess }> {
  try {
    const res = await client.listNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, plural);
    const body = res.body as K8sListResponse<T>;
    return { items: body.items ?? [], access: 'ok' };
  } catch (error) {
    const code = statusCodeOf(error);
    if (code === 403 || code === 404) {
      log('info', `Discovery: no access to ${plural} in ${namespace} (${code}) — treating as empty`);
      return { items: [], access: 'denied' };
    }
    throw error;
  }
}

/**
 * Discover a resource across the user's namespace and the shared namespace, using the
 * user's client. Merges + dedupes by name (user-namespace entries win over shared),
 * tagging each with its source namespace. When userNs === sharedNs, only lists once.
 */
export async function discoverAcrossNamespaces<T extends HasMetadataName>(
  client: CustomObjectsApi,
  plural: string,
  userNamespace: string,
  sharedNamespace: string,
): Promise<DiscoveryResult<T>> {
  const sameNs = userNamespace === sharedNamespace;

  const [userResult, sharedResult] = await Promise.all([
    listOrEmpty<T>(client, userNamespace, plural),
    sameNs ? Promise.resolve({ items: [] as T[], access: 'ok' as NamespaceAccess }) : listOrEmpty<T>(client, sharedNamespace, plural),
  ]);

  const byName = new Map<string, T & { sourceNamespace: string }>();
  // Shared first, then user — so a same-named user-namespace resource overrides.
  for (const item of sharedResult.items) {
    const name = item.metadata?.name;
    if (name) byName.set(name, { ...item, sourceNamespace: sharedNamespace });
  }
  for (const item of userResult.items) {
    const name = item.metadata?.name;
    if (name) byName.set(name, { ...item, sourceNamespace: userNamespace });
  }

  return {
    items: [...byName.values()],
    access: { user: userResult.access, shared: sameNs ? userResult.access : sharedResult.access },
  };
}
