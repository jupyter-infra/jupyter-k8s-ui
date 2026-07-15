import { serverConfig } from '../k8s/config';
import { createUserK8sClient } from '../k8s/client';
import { ACCESS_STRATEGY_PLURAL } from '../k8s/constants';
import { discoverAcrossNamespaces } from '../k8s/discovery';
import { log } from '../logger';
import { jsonResponse, handleK8sError } from '../responses';

// The editor only needs enough to populate the accessStrategy dropdown; we don't ship
// the (large) full strategy spec to the client.
interface K8sAccessStrategy {
  metadata?: { name?: string; namespace?: string };
  spec?: { displayName?: string; description?: string };
}

export async function handleListAccessStrategies(jwt: string): Promise<Response> {
  try {
    const k8sClient = await createUserK8sClient(jwt);
    const result = await discoverAcrossNamespaces<K8sAccessStrategy>(k8sClient, ACCESS_STRATEGY_PLURAL, serverConfig.namespace, serverConfig.sharedNamespace);
    const items = result.items.map((as) => ({
      name: as.metadata?.name ?? '',
      sourceNamespace: as.sourceNamespace,
      displayName: as.spec?.displayName,
      description: as.spec?.description,
    }));
    log('info', `Listed ${items.length} access strategies (user: ${result.access.user}, shared: ${result.access.shared})`);
    return jsonResponse({ items, access: result.access });
  } catch (error) {
    return handleK8sError(error, 'Failed to list access strategies');
  }
}
