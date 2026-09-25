import { reuseOrCreateUserK8sClient } from '../k8s/client';
import { workspaceToResponse } from '../k8s/mappers';
import { CRD_GROUP, CRD_VERSION, CRD_API_VERSION, WORKSPACE_PLURAL } from '../k8s/constants';
import { isValidK8sName, validateWorkspaceEnums, isAdvancedCreateOrEditWorkspaceBody } from '../guards';
import type { K8sWorkspace, K8sListResponse, CreateWorkspaceBody, UpdateWorkspaceBody } from '../types';
import { log } from '../logger';
import { jsonResponse, handleK8sError, errorResponse } from '../responses';

// dryRun=All runs the full admission chain (mutating + validating webhooks) without
// persisting — the authoritative validation layer for the advanced editor.
const DRY_RUN_ALL = 'All';

function wantsDryRun(req: Request): boolean {
  return new URL(req.url).searchParams.get('dryRun') === DRY_RUN_ALL;
}

export async function handleListWorkspaces(jwt: string, namespace: string): Promise<Response> {
  const startTime = Date.now();
  try {
    const k8sClient = await reuseOrCreateUserK8sClient(jwt);
    const response = await k8sClient.listNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, WORKSPACE_PLURAL);
    const body = response.body as K8sListResponse<K8sWorkspace>;
    const workspaces = body.items.map(workspaceToResponse);
    log('info', `Listed ${workspaces.length} workspaces in ${Date.now() - startTime}ms`);
    return jsonResponse(workspaces);
  } catch (error) {
    return handleK8sError(error, 'Failed to list workspaces');
  }
}

export async function handleGetWorkspace(jwt: string, namespace: string, workspaceName: string): Promise<Response> {
  try {
    const k8sClient = await reuseOrCreateUserK8sClient(jwt);
    const response = await k8sClient.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, WORKSPACE_PLURAL, workspaceName);
    const workspace = workspaceToResponse(response.body as K8sWorkspace);
    log('info', `Retrieved workspace: ${workspaceName}`);
    return jsonResponse(workspace);
  } catch (error) {
    return handleK8sError(error, `Failed to get workspace ${workspaceName}`);
  }
}

export async function handleCreateWorkspace(jwt: string, namespace: string, req: Request): Promise<Response> {
  let body: CreateWorkspaceBody;
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'Invalid request body — expected valid JSON');
  }

  const dryRun = wantsDryRun(req) ? DRY_RUN_ALL : undefined;

  // Build the spec from either the advanced (raw-spec) or the simple-form shape.
  let name: string;
  let spec: Record<string, unknown>;

  if (isAdvancedCreateOrEditWorkspaceBody(rawBody)) {
    name = rawBody.name;
    spec = { ...rawBody.spec };
    if (rawBody.templateRef) spec.templateRef = rawBody.templateRef;
  } else {
    body = rawBody as CreateWorkspaceBody;
    const enumError = validateWorkspaceEnums(body);
    if (enumError) return errorResponse(400, enumError);
    name = body.name;
    spec = {
      displayName: body.displayName || body.name,
      desiredStatus: body.desiredStatus || 'Running',
      accessType: body.accessType || 'Public',
      ownershipType: body.ownershipType || 'OwnerOnly',
    };
    if (body.templateRef) spec.templateRef = body.templateRef;
    if (body.image) spec.image = body.image;
    if (body.resources) spec.resources = body.resources;
    if (body.storage) spec.storage = body.storage;
    if (body.idleShutdown) {
      // Send a COMPLETE idleShutdown block, echoing `detection` verbatim — the CRD
      // requires detection whenever idleShutdown is present, and the operator does not
      // fill it for a partial block. `detection` is only omitted when the client didn't
      // supply one (idle-Unavailable paths don't send idleShutdown at all).
      spec.idleShutdown = {
        enabled: body.idleShutdown.enabled,
        idleTimeoutInMinutes: body.idleShutdown.timeoutInMinutes,
        ...(body.idleShutdown.detection !== undefined && { detection: body.idleShutdown.detection }),
      };
    }
  }

  if (!isValidK8sName(name)) {
    return errorResponse(400, 'Invalid workspace name — must be a valid Kubernetes resource name (lowercase alphanumeric and hyphens, 1-253 chars)');
  }

  try {
    const k8sClient = await reuseOrCreateUserK8sClient(jwt);

    const workspace = {
      apiVersion: CRD_API_VERSION,
      kind: 'Workspace',
      metadata: { name, namespace },
      spec,
    };

    const response = await k8sClient.createNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, WORKSPACE_PLURAL, workspace, undefined, dryRun);

    // On dry-run success we don't persist — return a lightweight ok, not a resource.
    if (dryRun) {
      log('info', `Validated (dry-run) workspace: ${name}`);
      return jsonResponse({ valid: true });
    }

    const created = workspaceToResponse(response.body as K8sWorkspace);
    log('info', `Created workspace: ${name}`);
    return jsonResponse(created, 201);
  } catch (error) {
    return handleK8sError(error, 'Failed to create workspace');
  }
}

type JsonPatchOp = { op: 'add'; path: string; value: unknown };
const JSON_PATCH_OPTIONS = { headers: { 'Content-Type': 'application/json-patch+json' } };

// Turn an update body into a JSON Patch. `add` on a spec path creates or replaces that field, so a
// field-shaped body (simple form, start and stop) touches only the fields it carries, and a raw-spec
// body (advanced editor) replaces the whole spec, so a field removed in YAML disappears. A patch
// carries no resourceVersion, so the operator's status writes on the same object cannot conflict
// with it. The path is chosen by body shape, not HTTP verb: PUT and PATCH both route here.
function buildUpdatePatch(rawBody: unknown): JsonPatchOp[] {
  if (isAdvancedCreateOrEditWorkspaceBody(rawBody)) {
    // templateRef comes from its own control, not from the YAML buffer.
    const nextSpec = { ...rawBody.spec } as K8sWorkspace['spec'];
    if (rawBody.templateRef) nextSpec.templateRef = rawBody.templateRef;
    return [{ op: 'add', path: '/spec', value: nextSpec }];
  }
  const body = rawBody as UpdateWorkspaceBody;
  const ops: JsonPatchOp[] = [];
  const set = (field: string, value: unknown) => {
    if (value !== undefined) ops.push({ op: 'add', path: `/spec/${field}`, value });
  };
  set('displayName', body.displayName);
  set('image', body.image);
  set('desiredStatus', body.desiredStatus);
  set('accessType', body.accessType);
  set('ownershipType', body.ownershipType);
  set('resources', body.resources);
  set('storage', body.storage);
  set('templateRef', body.templateRef);
  set('podSecurityContext', body.podSecurityContext);
  set('accessStrategy', body.accessStrategy);
  if (body.idleShutdown !== undefined) {
    // Wholesale replace of the idleShutdown block: the client sends the complete object,
    // echoing the workspace's own `detection` verbatim.
    set('idleShutdown', {
      enabled: body.idleShutdown.enabled,
      idleTimeoutInMinutes: body.idleShutdown.timeoutInMinutes,
      ...(body.idleShutdown.detection !== undefined && { detection: body.idleShutdown.detection }),
    });
  }
  return ops;
}

export async function handleUpdateWorkspace(jwt: string, namespace: string, workspaceName: string, req: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'Invalid request body — expected valid JSON');
  }

  const dryRun = wantsDryRun(req) ? DRY_RUN_ALL : undefined;

  if (!isAdvancedCreateOrEditWorkspaceBody(rawBody)) {
    const enumError = validateWorkspaceEnums(rawBody as UpdateWorkspaceBody);
    if (enumError) return errorResponse(400, enumError);
  }

  try {
    const k8sClient = await reuseOrCreateUserK8sClient(jwt);
    const response = await k8sClient.patchNamespacedCustomObject(
      CRD_GROUP,
      CRD_VERSION,
      namespace,
      WORKSPACE_PLURAL,
      workspaceName,
      buildUpdatePatch(rawBody),
      dryRun,
      undefined,
      undefined,
      JSON_PATCH_OPTIONS,
    );

    if (dryRun) {
      log('info', `Validated (dry-run) workspace: ${workspaceName}`);
      return jsonResponse({ valid: true });
    }

    const workspace = workspaceToResponse(response.body as K8sWorkspace);
    log('info', `Updated workspace: ${workspaceName}`);
    return jsonResponse(workspace);
  } catch (error) {
    return handleK8sError(error, `Failed to update workspace ${workspaceName}`);
  }
}

export async function handleDeleteWorkspace(jwt: string, namespace: string, workspaceName: string): Promise<Response> {
  try {
    const k8sClient = await reuseOrCreateUserK8sClient(jwt);
    await k8sClient.deleteNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, WORKSPACE_PLURAL, workspaceName);
    log('info', `Deleted workspace: ${workspaceName}`);
    return jsonResponse({ message: 'Workspace deleted successfully' });
  } catch (error) {
    return handleK8sError(error, `Failed to delete workspace ${workspaceName}`);
  }
}
