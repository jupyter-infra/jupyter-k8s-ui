// CRD API coordinates — single source of truth for all handlers.
export const CRD_GROUP = 'workspace.jupyter.org';
export const CRD_VERSION = 'v1alpha1';
export const CRD_API_VERSION = `${CRD_GROUP}/${CRD_VERSION}`;
export const WORKSPACE_PLURAL = 'workspaces';
export const TEMPLATE_PLURAL = 'workspacetemplates';
export const ACCESS_STRATEGY_PLURAL = 'workspaceaccessstrategies';

// Template metadata label an admin sets to flag the cluster/namespace default template.
// The operator injects this template's ref onto any workspace submitted without one
// (own namespace first, then shared); the UI's preselection mirrors that precedence.
export const DEFAULT_TEMPLATE_LABEL = 'workspace.jupyter.org/default-template';
