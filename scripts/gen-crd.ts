#!/usr/bin/env bun
// Regenerate the vendored CRD spec schemas from a live cluster.
//
// Reads the installed CRDs from whatever cluster your current kubeconfig context
// points at (i.e. wherever `kubectl` is aimed), normalizes each one's spec sub-schema,
// and writes it to server/schema/vendored/*.json. These vendored files are the
// editor's fallback schema; at runtime the server prefers a live read and only falls
// back to these when the cluster is unreachable (see server/schema/store.ts).
//
// Usage:
//   kubectl config use-context <cluster-with-jupyter-k8s-installed>
//   bun run gen:crd
//
// Refresh on operator version bumps. TS type generation is a decoupled follow-up
// (tracked in issue #10).

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { KubeConfig, ApiextensionsV1Api } from '@kubernetes/client-node';
import { CRD_GROUP } from '../server/k8s/constants';
import { extractSpecSchema, type JsonSchema } from '../server/schema/normalize';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'server', 'schema', 'vendored');

// CRDs we vendor a spec schema for. `key` is the short name used by the endpoint
// (`GET /api/v1/crd-schema/:crd`) and the output filename; `plural` forms the CRD
// object name (`<plural>.workspace.jupyter.org`). Keep in sync with the runtime
// store's registry in server/schema/store.ts.
const CRDS = [{ key: 'workspaces' }, { key: 'workspacetemplates' }, { key: 'workspaceaccessstrategies' }] as const;

interface CrdDocument {
  spec?: {
    versions?: Array<{ name: string; schema?: { openAPIV3Schema?: JsonSchema } }>;
  };
}

/**
 * Pull the `v1alpha1` (or first available) version's `openAPIV3Schema` out of a
 * fetched CRD document. Throws if the shape isn't what we expect — better a loud
 * generation failure than silently vendoring an empty schema.
 */
export function extractOpenAPISchema(doc: CrdDocument, preferredVersion = 'v1alpha1'): JsonSchema {
  const versions = doc.spec?.versions;
  if (!versions || versions.length === 0) {
    throw new Error('CRD has no spec.versions');
  }
  const version = versions.find((v) => v.name === preferredVersion) ?? versions[0];
  const schema = version.schema?.openAPIV3Schema;
  if (!schema) {
    throw new Error(`CRD version ${version.name} has no schema.openAPIV3Schema`);
  }
  return schema;
}

async function main(): Promise<void> {
  // Use the current kubeconfig context — whatever `kubectl` points at.
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const api = kc.makeApiClient(ApiextensionsV1Api);
  console.log(`Reading CRDs from cluster: ${kc.getCurrentCluster()?.server ?? '<unknown>'}`);

  mkdirSync(OUT_DIR, { recursive: true });

  for (const { key } of CRDS) {
    const crdName = `${key}.${CRD_GROUP}`;
    let doc: CrdDocument;
    try {
      const res = await api.readCustomResourceDefinition(crdName);
      doc = ((res as { body?: CrdDocument }).body ?? res) as CrdDocument;
    } catch (err) {
      console.error(`✗ Failed to read CRD ${crdName}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('  Ensure kubectl points at a cluster with the jupyter-k8s operator installed.');
      process.exit(1);
    }

    const openAPISchema = extractOpenAPISchema(doc);
    const specSchema = extractSpecSchema(openAPISchema);

    const outPath = join(OUT_DIR, `${key}.json`);
    writeFileSync(outPath, JSON.stringify(specSchema, null, 2) + '\n');
    console.log(`✓ ${key} -> ${outPath}`);
  }

  console.log('\nDone. Vendored spec schemas written to server/schema/vendored/.');
  console.log('(TS type generation is a decoupled follow-up — tracked in issue #10.)');
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.main) {
  await main();
}
