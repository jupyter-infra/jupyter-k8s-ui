import { KubeConfig, makeInformer, CoreV1Api, V1Secret } from '@kubernetes/client-node';
import { randomBytes } from 'crypto';
import type { KeyEntry, KeyMap } from './session';
import type { SessionConfig } from './types';
import { log } from './logger';
import { KEY_LENGTH } from './crypto';

// --- In-memory key store ---

let currentKeyMap: KeyMap = { keys: new Map() };

export function getKeyMap(): KeyMap {
  return currentKeyMap;
}

// --- Initialization ---

/**
 * Initialize the secret watcher.
 * In dev mode, generates an ephemeral key so no K8s secret is needed.
 * In production, uses a SharedInformer (list+watch) on the K8s Secret.
 */
export async function initSecretWatcher(config: SessionConfig): Promise<void> {
  if (process.env.NODE_ENV === 'development') {
    initDevKeys();
    return;
  }

  await startInformer(config);
}

// --- Dev Mode ---

function initDevKeys(): void {
  const kid = `dev-${Math.floor(Date.now() / 1000)}`;
  const key = randomBytes(KEY_LENGTH);
  currentKeyMap = {
    keys: new Map([[kid, { kid, key, addedTime: Date.now() - 120_000 }]]),
  };
  log('info', `Dev mode: generated ephemeral session key (kid=${kid})`);
}

// --- SharedInformer ---

let informerStop: (() => Promise<void>) | null = null;

async function startInformer(config: SessionConfig): Promise<void> {
  const kc = new KubeConfig();

  try {
    kc.loadFromCluster();
  } catch {
    try {
      kc.loadFromDefault();
    } catch {
      log('error', 'Cannot load kubeconfig for secret watcher, using dev keys as fallback');
      initDevKeys();
      return;
    }
  }

  const namespace = config.secretNamespace;

  if (!namespace || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(namespace)) {
    log('error', `Invalid secret namespace: ${namespace}`);
    return;
  }

  const k8sApi = kc.makeApiClient(CoreV1Api);
  const path = `/api/v1/namespaces/${namespace}/secrets`;
  const fieldSelector = `metadata.name=${config.secretName}`;

  const informer = makeInformer<V1Secret>(
    kc,
    path,
    () => k8sApi.listNamespacedSecret(namespace, undefined, undefined, undefined, fieldSelector),
    undefined,
    fieldSelector,
  );

  const handleSecret = (secret: V1Secret) => {
    updateKeysFromSecret(secret.data ?? {}, config.keyPrefix);
  };

  informer.on('add', handleSecret);
  informer.on('update', handleSecret);
  informer.on('delete', () => {
    log('warn', `Secret ${config.secretName} was deleted`);
    currentKeyMap = { keys: new Map() };
  });
  informer.on('error', (err: unknown) => {
    log('warn', `Secret informer error: ${err instanceof Error ? err.message : String(err)}`);
  });
  informer.on('connect', () => {
    log('info', `Secret informer connected for ${config.secretName} in namespace ${namespace}`);
  });

  informerStop = () => informer.stop();

  log('info', `Starting informer on secret ${config.secretName} in namespace ${namespace}`);
  await informer.start();
}

function updateKeysFromSecret(data: Record<string, string>, keyPrefix: string): void {
  const newKeys = new Map<string, KeyEntry>();

  for (const [name, value] of Object.entries(data)) {
    if (!name.startsWith(keyPrefix)) continue;

    const kid = name.slice(keyPrefix.length);
    const key = Buffer.from(value, 'base64');

    if (key.length !== KEY_LENGTH) {
      log('warn', `Skipping key ${name}: expected ${KEY_LENGTH} bytes, got ${key.length}`);
      continue;
    }

    // Preserve addedTime if we already know this key
    const existing = currentKeyMap.keys.get(kid);
    newKeys.set(kid, {
      kid,
      key,
      addedTime: existing?.addedTime ?? Date.now(),
    });
  }

  currentKeyMap = { keys: newKeys };
  log('info', `Updated session keys: ${newKeys.size} key(s) loaded`);
}

/**
 * Stop the secret informer (for graceful shutdown).
 */
export async function stopSecretWatcher(): Promise<void> {
  await informerStop?.();
  informerStop = null;
}
