import { getSpecSchema, isCrdKey } from '../schema/store';
import { jsonResponse, errorResponse } from '../responses';

/**
 * GET /api/v1/crd-schema/:crd — serve the normalized spec JSON Schema for a CRD, for
 * the advanced editor's monaco-yaml language service. Reads the in-memory singleton
 * (loaded once at startup; see server/schema/store.ts). No cluster call per request.
 */
export function handleGetCrdSchema(crd: string): Response {
  if (!isCrdKey(crd)) {
    return errorResponse(404, `Unknown CRD schema: ${crd}`);
  }
  const schema = getSpecSchema(crd);
  if (!schema) {
    return errorResponse(503, `Schema for ${crd} is not available`);
  }
  return jsonResponse(schema);
}
