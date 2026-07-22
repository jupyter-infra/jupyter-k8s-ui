import { serverConfig } from '../k8s/config';
import { createUserK8sClient } from '../k8s/client';
import { templateToResponse } from '../k8s/mappers';
import { TEMPLATE_PLURAL } from '../k8s/constants';
import { discoverAcrossNamespaces } from '../k8s/discovery';
import type { K8sWorkspaceTemplate } from '../types';
import { log } from '../logger';
import { jsonResponse, handleK8sError } from '../responses';

export async function handleListTemplates(jwt: string): Promise<Response> {
  try {
    const k8sClient = await createUserK8sClient(jwt);
    const result = await discoverAcrossNamespaces<K8sWorkspaceTemplate>(k8sClient, TEMPLATE_PLURAL, serverConfig.namespace, serverConfig.sharedNamespace);
    const items = result.items.map((tmpl) => ({ ...templateToResponse(tmpl), sourceNamespace: tmpl.sourceNamespace }));
    log('info', `Listed ${items.length} templates (user: ${result.access.user}, shared: ${result.access.shared})`);
    // Report which namespace is the user's own vs. shared so the client can mirror the
    // operator's default-template injection precedence (own-ns default beats shared-ns).
    return jsonResponse({ items, access: result.access, namespaces: { own: serverConfig.namespace, shared: serverConfig.sharedNamespace } });
  } catch (error) {
    return handleK8sError(error, 'Failed to list templates');
  }
}
