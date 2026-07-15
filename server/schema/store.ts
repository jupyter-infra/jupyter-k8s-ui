// In-memory CRD spec-schema store.
//
// The CRD schema is immutable for the pod's lifetime — it only changes on an operator
// upgrade, which redeploys us. So we read it ONCE at startup into a process-lifetime
// singleton (no TTL, no per-request re-fetch) and serve the in-memory copy.
//
// Source precedence:
//   1. Live read of the deployed CRD via the pod's service-account creds. The schema
//      is cluster-scoped, non-sensitive, and identical for every user, so reading it
//      with the SA (rather than the per-user token used for resource discovery) is a
//      deliberate, safe exception — it never leaks tenant data.
//   2. Vendored schema shipped in the image (server/schema/vendored/*.json) if the
//      live read fails (RBAC / CRD absent / cluster unreachable) or in local dev.
//
// The endpoint (GET /api/v1/crd-schema/:crd) just returns what's in the singleton.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ApiextensionsV1Api } from '@kubernetes/client-node';
import { loadKubeConfigBestEffort } from '../k8s/client';
import { CRD_GROUP } from '../k8s/constants';
import { extractSpecSchema, type JsonSchema } from './normalize';
import { log } from '../logger';

const VENDORED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vendored');

// Short key -> CRD metadata. The plural is the CRD name prefix
// (`<plural>.workspace.jupyter.org`) used to read the CRD object.
const CRD_REGISTRY = {
  workspaces: { plural: 'workspaces' },
  workspacetemplates: { plural: 'workspacetemplates' },
  workspaceaccessstrategies: { plural: 'workspaceaccessstrategies' },
} as const;

export type CrdKey = keyof typeof CRD_REGISTRY;

export function isCrdKey(value: string): value is CrdKey {
  return Object.prototype.hasOwnProperty.call(CRD_REGISTRY, value);
}

interface SchemaEntry {
  schema: JsonSchema;
  source: 'live' | 'vendored';
}

// The singleton. Populated by initSchemaStore() at startup; read by getSpecSchema().
const store = new Map<CrdKey, SchemaEntry>();

// Sync read is intentional: this only runs on cold paths (startup fallback + lazy
// test seeding), never per request, so it keeps getSpecSchema synchronous without any
// hot-path event-loop cost.
function loadVendored(key: CrdKey): JsonSchema {
  const path = join(VENDORED_DIR, `${key}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as JsonSchema;
}

interface CrdReadDoc {
  spec?: { versions?: Array<{ name: string; schema?: { openAPIV3Schema?: JsonSchema } }> };
}

async function readLiveSchema(api: ApiextensionsV1Api, key: CrdKey): Promise<JsonSchema | null> {
  const { plural } = CRD_REGISTRY[key];
  const crdName = `${plural}.${CRD_GROUP}`;
  try {
    const res = await api.readCustomResourceDefinition(crdName);
    const doc = (res as { body?: CrdReadDoc }).body ?? (res as CrdReadDoc);
    const versions = doc.spec?.versions ?? [];
    const version = versions.find((v) => v.name === 'v1alpha1') ?? versions[0];
    const openAPISchema = version?.schema?.openAPIV3Schema;
    if (!openAPISchema) return null;
    return extractSpecSchema(openAPISchema);
  } catch (err) {
    log('warn', `Live CRD read failed for ${crdName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Read every registered CRD's spec schema once, preferring the live cluster read and
 * falling back to the vendored copy. Called at server startup. Never throws — a
 * failed live read degrades to vendored; a failed vendored read (should never happen,
 * it's shipped in the image) logs and skips that CRD.
 */
export async function initSchemaStore(): Promise<void> {
  let api: ApiextensionsV1Api | null = null;
  const kc = loadKubeConfigBestEffort();
  if (kc) {
    try {
      api = kc.makeApiClient(ApiextensionsV1Api);
    } catch (err) {
      log('warn', `Could not build ApiextensionsV1Api client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const key of Object.keys(CRD_REGISTRY) as CrdKey[]) {
    let entry: SchemaEntry | null = null;

    if (api) {
      const live = await readLiveSchema(api, key);
      if (live) entry = { schema: live, source: 'live' };
    }

    if (!entry) {
      try {
        entry = { schema: loadVendored(key), source: 'vendored' };
      } catch (err) {
        log('error', `No schema available for ${key} (vendored load failed): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    store.set(key, entry);
    log('info', `Loaded ${key} spec schema (source: ${entry.source})`);
  }
}

/**
 * Return the normalized spec schema for a CRD, or null if none is loaded. In
 * production this is a pure in-memory Map lookup (the store is populated at startup),
 * so the sync vendored read below only fires when the store is empty — i.e. tests, or
 * a request landing before initSchemaStore() finishes.
 */
export function getSpecSchema(key: CrdKey): JsonSchema | null {
  const entry = store.get(key);
  if (entry) return entry.schema;
  try {
    const schema = loadVendored(key);
    store.set(key, { schema, source: 'vendored' });
    return schema;
  } catch {
    return null;
  }
}

// Test-only: reset the singleton between cases.
export function __resetSchemaStore(): void {
  store.clear();
}
