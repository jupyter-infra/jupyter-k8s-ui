import { KubeConfig, CustomObjectsApi, AuthorizationV1Api, V1SelfSubjectAccessReview } from '@kubernetes/client-node';
import { createHash } from 'crypto';
import { isLocalDevelopment } from './config';

// --- KubeConfig Factory ---

export function createKubeConfig(jwt: string | null): KubeConfig {
  const kc = new KubeConfig();

  if (process.env.KUBERNETES_SERVICE_HOST) {
    // In-cluster
    const cluster = {
      name: 'default-cluster',
      server: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
      skipTLSVerify: false,
      caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    };
    const user = { name: 'user', token: jwt || '' };
    const context = { name: 'default-context', user: user.name, cluster: cluster.name };
    kc.loadFromOptions({ clusters: [cluster], users: [user], contexts: [context], currentContext: context.name });
    return kc;
  }

  // Local — load default kubeconfig first
  kc.loadFromDefault();

  if (jwt) {
    const cluster = kc.getCurrentCluster();
    if (!cluster) {
      throw new Error('No cluster found in kubeconfig');
    }

    const user = { name: 'jwt-user', token: jwt };
    const context = { name: 'jwt-context', user: user.name, cluster: cluster.name };
    kc.loadFromOptions({
      clusters: [cluster],
      users: [user],
      contexts: [context],
      currentContext: context.name,
    });
  }

  return kc;
}

// --- K8s Client Factory ---

// Simple LRU-ish cache: one API client per (JWT, api-kind), with a short TTL.
// Avoids re-creating KubeConfig + API client on every single request. The cache holds
// heterogeneous client types keyed by a kind-prefixed hash, e.g. `co:<hash>` for
// CustomObjectsApi and `authz:<hash>` for AuthorizationV1Api.
type CachedApi = CustomObjectsApi | AuthorizationV1Api;
const clientCache = new Map<string, { client: CachedApi; expiresAt: number }>();
const CLIENT_CACHE_TTL_MS = 10 * 60_000; // 10 minutes
const CLIENT_CACHE_MAX_SIZE = 100;
const CLIENT_CACHE_KEY_NO_JWT = '__service_account__';

function getCachedClient(cacheKey: string): CachedApi | null {
  const entry = clientCache.get(cacheKey);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.client;
  }
  if (entry) {
    clientCache.delete(cacheKey);
  }
  return null;
}

function setCachedClient(cacheKey: string, client: CachedApi): void {
  clientCache.set(cacheKey, { client, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS });

  // Evict stale entries if cache grows (unlikely but defensive)
  if (clientCache.size > CLIENT_CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [key, val] of clientCache) {
      if (now >= val.expiresAt) clientCache.delete(key);
    }
  }
}

function hashJWT(jwt: string): string {
  return createHash('sha256').update(jwt).digest('hex');
}

/** Build the per-(kind, JWT) cache key. No-JWT (service account) uses a fixed suffix. */
function cacheKeyFor(kind: string, jwt: string | null): string {
  return `${kind}:${jwt ? hashJWT(jwt) : CLIENT_CACHE_KEY_NO_JWT}`;
}

function createMockK8sClient(): CustomObjectsApi {
  return {
    listNamespacedCustomObject: async () => ({ body: { items: [] } }),
    getNamespacedCustomObject: async () => {
      throw Object.assign(new Error('Not found'), { statusCode: 404 });
    },
    createNamespacedCustomObject: async () => {
      throw Object.assign(new Error('Mock client — not implemented'), { statusCode: 501 });
    },
    replaceNamespacedCustomObject: async () => {
      throw Object.assign(new Error('Mock client — not implemented'), { statusCode: 501 });
    },
    deleteNamespacedCustomObject: async () => {
      throw Object.assign(new Error('Mock client — not implemented'), { statusCode: 501 });
    },
  } as unknown as CustomObjectsApi;
}

// Dev has no cluster to run SSARs against; the mock always allows. This is a deliberate
// dev-only shortcut (not a simulation) mirroring secret-watcher's initDevKeys — the
// confused-deputy guard is exercised for real against Kind in E2E, never here.
function createMockAuthClient(): AuthorizationV1Api {
  return {
    createSelfSubjectAccessReview: async (body: V1SelfSubjectAccessReview) => ({
      body: { ...body, status: { allowed: true } },
    }),
  } as unknown as AuthorizationV1Api;
}

/**
 * Reuse-or-create a per-user CustomObjectsApi client keyed by JWT hash (10-min TTL).
 * In dev, returns the no-cluster mock.
 */
export async function reuseOrCreateUserK8sClient(jwt: string | null): Promise<CustomObjectsApi> {
  if (isLocalDevelopment()) {
    return createMockK8sClient();
  }

  const cacheKey = cacheKeyFor('co', jwt);
  const cached = getCachedClient(cacheKey);
  if (cached) return cached as CustomObjectsApi;

  const kc = createKubeConfig(jwt);
  const client = kc.makeApiClient(CustomObjectsApi);
  setCachedClient(cacheKey, client);
  return client;
}

/**
 * Reuse-or-create a per-user AuthorizationV1Api client for SelfSubjectAccessReview.
 * Built from the SAME user KubeConfig (SSAR must check the caller's identity, never the
 * SA's), cached under a distinct `authz:<hash>` key sharing the TTL/eviction. In dev,
 * returns a mock that always allows.
 */
export async function reuseOrCreateAuthClient(jwt: string | null): Promise<AuthorizationV1Api> {
  if (isLocalDevelopment()) {
    return createMockAuthClient();
  }

  const cacheKey = cacheKeyFor('authz', jwt);
  const cached = getCachedClient(cacheKey);
  if (cached) return cached as AuthorizationV1Api;

  const kc = createKubeConfig(jwt);
  const client = kc.makeApiClient(AuthorizationV1Api);
  setCachedClient(cacheKey, client);
  return client;
}

// --- Shared KubeConfig Loader ---

export function loadKubeConfigBestEffort(): KubeConfig | null {
  const kc = new KubeConfig();
  // Only load the in-cluster config when actually in-cluster. `loadFromCluster()` does NOT
  // throw off-cluster — it happily builds a config pointing at the SA token/ca.crt file
  // paths, which then fail LAZILY at request time ("ENOENT ... ca.crt"). That would mask
  // the kubeconfig fallback below, so the namespace poll / secret watcher never reach the
  // real cluster off-cluster (e.g. the local E2E server). Gate on KUBERNETES_SERVICE_HOST,
  // mirroring createKubeConfig.
  if (process.env.KUBERNETES_SERVICE_HOST) {
    try {
      kc.loadFromCluster();
      return kc;
    } catch {
      return null;
    }
  }
  try {
    kc.loadFromDefault();
    return kc;
  } catch {
    return null;
  }
}
