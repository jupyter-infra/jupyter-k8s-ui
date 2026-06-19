import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
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

// Simple LRU-ish cache: one client per JWT, with a short TTL.
// Avoids re-creating KubeConfig + API client on every single request.
const clientCache = new Map<string, { client: CustomObjectsApi; expiresAt: number }>();
const CLIENT_CACHE_TTL_MS = 10 * 60_000; // 10 minutes
const CLIENT_CACHE_MAX_SIZE = 100;
const CLIENT_CACHE_KEY_NO_JWT = '__service_account__';

function getCachedClient(cacheKey: string): CustomObjectsApi | null {
  const entry = clientCache.get(cacheKey);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.client;
  }
  if (entry) {
    clientCache.delete(cacheKey);
  }
  return null;
}

function setCachedClient(cacheKey: string, client: CustomObjectsApi): void {
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

export async function createUserK8sClient(jwt: string | null): Promise<CustomObjectsApi> {
  if (isLocalDevelopment()) {
    return createMockK8sClient();
  }

  const cacheKey = jwt ? hashJWT(jwt) : CLIENT_CACHE_KEY_NO_JWT;
  const cached = getCachedClient(cacheKey);
  if (cached) return cached;

  const kc = createKubeConfig(jwt);
  const client = kc.makeApiClient(CustomObjectsApi);
  setCachedClient(cacheKey, client);
  return client;
}

// --- Shared KubeConfig Loader ---

export function loadKubeConfigBestEffort(): KubeConfig | null {
  const kc = new KubeConfig();
  try {
    kc.loadFromCluster();
    return kc;
  } catch {
    try {
      kc.loadFromDefault();
      return kc;
    } catch {
      return null;
    }
  }
}
