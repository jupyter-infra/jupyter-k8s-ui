import { serverConfig } from '../k8s/config';
import { isValidK8sName } from '../guards';
import { jsonResponse, errorResponse } from '../responses';

export function handleGetClusterAccess(): Response {
  const { clusterName, apiServer, oidcIssuerUrl, oidcClientId } = serverConfig.clusterAccess;

  if (!clusterName || !apiServer || !oidcIssuerUrl || !oidcClientId) {
    return errorResponse(404, 'Cluster access configuration not available');
  }

  if (!isValidK8sName(clusterName)) {
    return errorResponse(500, 'Invalid cluster name configuration');
  }

  try {
    new URL(apiServer);
    new URL(oidcIssuerUrl);
  } catch {
    return errorResponse(500, 'Invalid cluster access URL configuration');
  }

  const { caCertBase64, oidcClientSecret, oidcCallbackPort } = serverConfig.clusterAccess;
  return jsonResponse({
    clusterName,
    apiServer,
    caCertBase64,
    oidcIssuerUrl,
    oidcClientId,
    oidcClientSecret,
    oidcCallbackPort,
  });
}
