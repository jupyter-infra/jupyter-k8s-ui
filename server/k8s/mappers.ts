import type { K8sWorkspace, K8sWorkspaceTemplate, WorkspaceResponse, TemplateResponse } from '../types';

export function workspaceToResponse(ws: K8sWorkspace): WorkspaceResponse {
  return {
    metadata: {
      name: ws.metadata?.name ?? '',
      namespace: ws.metadata?.namespace ?? '',
      annotations: ws.metadata?.annotations ?? {},
      creationTimestamp: ws.metadata?.creationTimestamp ?? '',
    },
    spec: ws.spec ?? {},
    status: ws.status
      ? {
          accessURL: ws.status.accessURL ?? '',
          conditions: (ws.status.conditions ?? []).map((c) => ({
            type: c.type ?? '',
            status: c.status ?? '',
            reason: c.reason ?? '',
            message: c.message ?? '',
          })),
        }
      : undefined,
  };
}

export function templateToResponse(tmpl: K8sWorkspaceTemplate): TemplateResponse {
  return {
    metadata: {
      name: tmpl.metadata?.name ?? '',
      namespace: tmpl.metadata?.namespace ?? '',
    },
    spec: tmpl.spec ?? {},
  };
}
