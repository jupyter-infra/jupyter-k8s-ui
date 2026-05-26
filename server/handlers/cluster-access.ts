import { serverConfig } from '../k8s';
import { jsonResponse, errorResponse } from '../responses';

export function handleGetClusterAccess(): Response {
  const { clusterName, apiServer, oidcIssuerUrl, oidcClientId } = serverConfig.clusterAccess;

  if (!clusterName || !apiServer || !oidcIssuerUrl || !oidcClientId) {
    return errorResponse(404, 'Cluster access configuration not available');
  }

  return jsonResponse(serverConfig.clusterAccess);
}
