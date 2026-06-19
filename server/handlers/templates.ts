import { serverConfig } from '../k8s/config';
import { createUserK8sClient } from '../k8s/client';
import { templateToResponse } from '../k8s/mappers';
import { CRD_GROUP, CRD_VERSION, TEMPLATE_PLURAL } from '../k8s/constants';
import type { K8sWorkspaceTemplate, K8sListResponse } from '../types';
import { log } from '../logger';
import { jsonResponse, handleK8sError } from '../responses';

export async function handleListTemplates(jwt: string): Promise<Response> {
  try {
    const k8sClient = await createUserK8sClient(jwt);
    const response = await k8sClient.listNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, TEMPLATE_PLURAL);
    const body = response.body as K8sListResponse<K8sWorkspaceTemplate>;
    const templates = body.items.map(templateToResponse);
    log('info', `Listed ${templates.length} templates`);
    return jsonResponse(templates);
  } catch (error) {
    return handleK8sError(error, 'Failed to list templates');
  }
}
