import { serverConfig } from '../k8s/config';
import { createUserK8sClient } from '../k8s/client';
import { workspaceToResponse } from '../k8s/mappers';
import { CRD_GROUP, CRD_VERSION, CRD_API_VERSION, WORKSPACE_PLURAL, isValidK8sName } from '../k8s/constants';
import type { K8sWorkspace, K8sListResponse, CreateWorkspaceBody, UpdateWorkspaceBody } from '../types';
import { log } from '../logger';
import { jsonResponse, handleK8sError, errorResponse } from '../responses';

export async function handleListWorkspaces(jwt: string): Promise<Response> {
  const startTime = Date.now();
  try {
    const k8sClient = await createUserK8sClient(jwt);
    const response = await k8sClient.listNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, WORKSPACE_PLURAL);
    const body = response.body as K8sListResponse<K8sWorkspace>;
    const workspaces = body.items.map(workspaceToResponse);
    log('info', `Listed ${workspaces.length} workspaces in ${Date.now() - startTime}ms`);
    return jsonResponse(workspaces);
  } catch (error) {
    return handleK8sError(error, 'Failed to list workspaces');
  }
}

export async function handleGetWorkspace(jwt: string, workspaceName: string): Promise<Response> {
  try {
    const k8sClient = await createUserK8sClient(jwt);
    const response = await k8sClient.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, WORKSPACE_PLURAL, workspaceName);
    const workspace = workspaceToResponse(response.body as K8sWorkspace);
    log('info', `Retrieved workspace: ${workspaceName}`);
    return jsonResponse(workspace);
  } catch (error) {
    return handleK8sError(error, `Failed to get workspace ${workspaceName}`);
  }
}

export async function handleCreateWorkspace(jwt: string, req: Request): Promise<Response> {
  let body: CreateWorkspaceBody;
  try {
    body = (await req.json()) as CreateWorkspaceBody;
  } catch {
    return errorResponse(400, 'Invalid request body — expected valid JSON');
  }

  if (!isValidK8sName(body.name)) {
    return errorResponse(400, 'Invalid workspace name — must be a valid Kubernetes resource name (lowercase alphanumeric and hyphens, 1-253 chars)');
  }

  try {
    const k8sClient = await createUserK8sClient(jwt);

    const spec: Record<string, unknown> = {
      displayName: body.displayName || body.name,
      desiredStatus: body.desiredStatus || 'Running',
      accessType: body.accessType || 'Public',
      ownershipType: body.ownershipType || 'OwnerOnly',
    };

    if (body.resources) spec.resources = body.resources;
    if (body.storage) spec.storage = body.storage;

    if (body.idleShutdown) {
      spec.idleShutdown = {
        enabled: body.idleShutdown.enabled,
        idleTimeoutInMinutes: body.idleShutdown.timeoutInMinutes,
      };
    }

    const workspace = {
      apiVersion: CRD_API_VERSION,
      kind: 'Workspace',
      metadata: { name: body.name, namespace: serverConfig.namespace },
      spec,
    };

    const response = await k8sClient.createNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, WORKSPACE_PLURAL, workspace);

    const created = workspaceToResponse(response.body as K8sWorkspace);
    log('info', `Created workspace: ${body.name}`);
    return jsonResponse(created, 201);
  } catch (error) {
    return handleK8sError(error, 'Failed to create workspace');
  }
}

export async function handleUpdateWorkspace(jwt: string, workspaceName: string, req: Request): Promise<Response> {
  let body: UpdateWorkspaceBody;
  try {
    body = (await req.json()) as UpdateWorkspaceBody;
  } catch {
    return errorResponse(400, 'Invalid request body — expected valid JSON');
  }

  try {
    const k8sClient = await createUserK8sClient(jwt);

    const existing = await k8sClient.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, WORKSPACE_PLURAL, workspaceName);

    const updated = JSON.parse(JSON.stringify(existing.body)) as K8sWorkspace;

    if (body.displayName !== undefined) updated.spec.displayName = body.displayName;
    if (body.image !== undefined) updated.spec.image = body.image;
    if (body.desiredStatus !== undefined) updated.spec.desiredStatus = body.desiredStatus;
    if (body.accessType !== undefined) updated.spec.accessType = body.accessType;
    if (body.ownershipType !== undefined) updated.spec.ownershipType = body.ownershipType;
    if (body.resources !== undefined) updated.spec.resources = body.resources;
    if (body.storage !== undefined) updated.spec.storage = body.storage;
    if (body.templateRef !== undefined) updated.spec.templateRef = body.templateRef;
    if (body.podSecurityContext !== undefined) updated.spec.podSecurityContext = body.podSecurityContext;
    if (body.accessStrategy !== undefined) updated.spec.accessStrategy = body.accessStrategy;
    if (body.idleShutdown !== undefined) {
      updated.spec.idleShutdown = {
        enabled: body.idleShutdown.enabled,
        idleTimeoutInMinutes: body.idleShutdown.timeoutInMinutes,
      };
    }

    const response = await k8sClient.replaceNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, WORKSPACE_PLURAL, workspaceName, updated);

    const workspace = workspaceToResponse(response.body as K8sWorkspace);
    log('info', `Updated workspace: ${workspaceName}`);
    return jsonResponse(workspace);
  } catch (error) {
    return handleK8sError(error, `Failed to update workspace ${workspaceName}`);
  }
}

export async function handleDeleteWorkspace(jwt: string, workspaceName: string): Promise<Response> {
  try {
    const k8sClient = await createUserK8sClient(jwt);
    await k8sClient.deleteNamespacedCustomObject(CRD_GROUP, CRD_VERSION, serverConfig.namespace, WORKSPACE_PLURAL, workspaceName);
    log('info', `Deleted workspace: ${workspaceName}`);
    return jsonResponse({ message: 'Workspace deleted successfully' });
  } catch (error) {
    return handleK8sError(error, `Failed to delete workspace ${workspaceName}`);
  }
}
