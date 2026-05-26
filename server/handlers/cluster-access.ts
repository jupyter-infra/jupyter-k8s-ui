import { serverConfig } from '../k8s';
import { jsonResponse, errorResponse } from '../responses';

const CLUSTER_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function handleGetClusterAccess(): Response {
  const { clusterName, apiServer, oidcIssuerUrl, oidcClientId } = serverConfig.clusterAccess;

  if (!clusterName || !apiServer || !oidcIssuerUrl || !oidcClientId) {
    return errorResponse(404, 'Cluster access configuration not available');
  }

  if (!CLUSTER_NAME_RE.test(clusterName)) {
    return errorResponse(500, 'Invalid cluster name configuration');
  }

  try {
    new URL(apiServer);
    new URL(oidcIssuerUrl);
  } catch {
    return errorResponse(500, 'Invalid cluster access URL configuration');
  }

  return jsonResponse(serverConfig.clusterAccess);
}
