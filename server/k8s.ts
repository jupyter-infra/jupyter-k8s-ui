import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  K8sWorkspace,
  K8sWorkspaceTemplate,
  WorkspaceResponse,
  TemplateResponse,
  ServerConfig,
} from './types';

// --- Server Configuration ---

// Use a single object reference — mutate properties, never reassign.
// This ensures all importers share the same config instance.
export const serverConfig: ServerConfig = {
  namespace: 'default',
  staticDir: './dist',
  devUser: '',
  devAccessToken: '',
  port: 8090,
  logLevel: 'info',
};

export function initializeConfig(): void {
  const isDev = process.env.NODE_ENV === 'development';

  serverConfig.namespace = process.env.NAMESPACE || 'default';
  serverConfig.staticDir = process.env.STATIC_DIR || './dist';
  serverConfig.devUser = process.env.DEV_USER || '';
  serverConfig.devAccessToken = isDev ? (process.env.DEV_ACCESS_TOKEN || '') : '';
  serverConfig.port = parseInt(process.env.PORT || '8090', 10);
  serverConfig.logLevel = (process.env.LOG_LEVEL as ServerConfig['logLevel']) || (isDev ? 'debug' : 'info');

  if (!isDev && process.env.DEV_ACCESS_TOKEN) {
    console.warn('⚠️  WARNING: DEV_ACCESS_TOKEN is set but will be ignored in production mode');
  }
}


// --- Environment Detection ---

function hasKubeconfig(): boolean {
  try {
    const kubeconfigPath = process.env.KUBECONFIG || join(homedir(), '.kube', 'config');
    return existsSync(kubeconfigPath);
  } catch {
    return false;
  }
}

function isLocalDevelopment(): boolean {
  if (process.env.KUBERNETES_SERVICE_HOST) return false;
  if (hasKubeconfig()) return false;
  return true;
}

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
const CLIENT_CACHE_TTL_MS = 30_000; // 30 seconds
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
  if (clientCache.size > 100) {
    const now = Date.now();
    for (const [key, val] of clientCache) {
      if (now >= val.expiresAt) clientCache.delete(key);
    }
  }
}

export async function createUserK8sClient(jwt: string | null): Promise<CustomObjectsApi> {
  if (isLocalDevelopment()) {
    return createMockK8sClient();
  }

  const cacheKey = jwt || CLIENT_CACHE_KEY_NO_JWT;
  const cached = getCachedClient(cacheKey);
  if (cached) return cached;

  const kc = createKubeConfig(jwt);
  const client = kc.makeApiClient(CustomObjectsApi);
  setCachedClient(cacheKey, client);
  return client;
}

// --- Mock Client (local dev without cluster) ---

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


// --- Service Account Client (cached singleton) ---

let serviceAccountClient: CustomObjectsApi | null = null;
let serviceAccountClientError: Error | null = null;

export async function createServiceAccountK8sClient(): Promise<CustomObjectsApi> {
  if (isLocalDevelopment()) {
    return createMockK8sClient();
  }

  if (serviceAccountClient) return serviceAccountClient;
  if (serviceAccountClientError) throw serviceAccountClientError;

  const kc = new KubeConfig();

  try {
    kc.loadFromCluster();
    serviceAccountClient = kc.makeApiClient(CustomObjectsApi);
    return serviceAccountClient;
  } catch {
    try {
      kc.loadFromDefault();
      serviceAccountClient = kc.makeApiClient(CustomObjectsApi);
      return serviceAccountClient;
    } catch (err) {
      serviceAccountClientError = new Error(
        'Unable to load Kubernetes configuration — expected in local dev without kubectl configured'
      );
      serviceAccountClientError.cause = err;
      throw serviceAccountClientError;
    }
  }
}

// --- Response Mappers ---

export function workspaceToResponse(ws: K8sWorkspace): WorkspaceResponse {
  return {
    metadata: {
      name: ws.metadata?.name ?? '',
      namespace: ws.metadata?.namespace ?? '',
      annotations: ws.metadata?.annotations ?? {},
      creationTimestamp: ws.metadata?.creationTimestamp ?? '',
    },
    spec: {
      displayName: ws.spec?.displayName ?? '',
      image: ws.spec?.image ?? '',
      desiredStatus: ws.spec?.desiredStatus ?? '',
      accessType: ws.spec?.accessType ?? '',
      ownershipType: ws.spec?.ownershipType ?? '',
      resources: {
        limits: {
          cpu: ws.spec?.resources?.limits?.cpu ?? '',
          memory: ws.spec?.resources?.limits?.memory ?? '',
        },
        requests: {
          cpu: ws.spec?.resources?.requests?.cpu ?? '',
          memory: ws.spec?.resources?.requests?.memory ?? '',
        },
      },
    },
    status: ws.status
      ? {
          accessURL: ws.status.accessURL ?? '',
          conditions: (ws.status.conditions ?? []).map((c) => ({
            type: c.type ?? '',
            status: c.status ?? '',
            reason: c.reason ?? '',
            message: c.message ?? '',
          })),
        }
      : undefined,
  };
}

export function templateToResponse(tmpl: K8sWorkspaceTemplate): TemplateResponse {
  const resp: TemplateResponse = {
    name: tmpl.metadata?.name ?? '',
    namespace: tmpl.metadata?.namespace ?? '',
    displayName: tmpl.spec?.displayName ?? '',
    description: tmpl.spec?.description ?? '',
    defaultImage: tmpl.spec?.defaultImage ?? '',
    allowedImages: tmpl.spec?.allowedImages ?? [],
    allowCustomImages: tmpl.spec?.allowCustomImages ?? false,
    defaultAccessType: tmpl.spec?.defaultAccessType ?? '',
    defaultOwnershipType: tmpl.spec?.defaultOwnershipType ?? '',
  };

  const bounds = tmpl.spec?.resourceBounds?.resources;
  if (bounds) {
    resp.resourceBounds = {};
    if (bounds.cpu) {
      resp.resourceBounds.cpu = { min: bounds.cpu.min ?? '', max: bounds.cpu.max ?? '' };
    }
    if (bounds.memory) {
      resp.resourceBounds.memory = { min: bounds.memory.min ?? '', max: bounds.memory.max ?? '' };
    }
    if (bounds['nvidia.com/gpu']) {
      resp.resourceBounds.gpu = {
        min: bounds['nvidia.com/gpu'].min ?? '',
        max: bounds['nvidia.com/gpu'].max ?? '',
      };
    }
  }

  if (tmpl.spec?.defaultResources) {
    resp.defaultResources = {
      cpu: tmpl.spec.defaultResources.requests?.cpu ?? '',
      memory: tmpl.spec.defaultResources.requests?.memory ?? '',
    };
  }

  if (tmpl.spec?.primaryStorage) {
    resp.storageConfig = {
      defaultSize: tmpl.spec.primaryStorage.defaultSize ?? '',
      minSize: tmpl.spec.primaryStorage.minSize ?? '',
      maxSize: tmpl.spec.primaryStorage.maxSize ?? '',
      mountPath: tmpl.spec.primaryStorage.defaultMountPath ?? '',
    };
  }

  if (tmpl.spec?.defaultIdleShutdown) {
    resp.idleShutdown = {
      enabled: tmpl.spec.defaultIdleShutdown.enabled ?? false,
      defaultTimeoutMinutes: tmpl.spec.defaultIdleShutdown.idleTimeoutInMinutes ?? 0,
    };
    if (tmpl.spec.idleShutdownOverrides) {
      resp.idleShutdown.minTimeoutMinutes = tmpl.spec.idleShutdownOverrides.minIdleTimeoutInMinutes;
      resp.idleShutdown.maxTimeoutMinutes = tmpl.spec.idleShutdownOverrides.maxIdleTimeoutInMinutes;
    }
  }

  return resp;
}
