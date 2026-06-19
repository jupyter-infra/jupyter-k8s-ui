// CRD API coordinates — single source of truth for all handlers.
export const CRD_GROUP = 'workspace.jupyter.org';
export const CRD_VERSION = 'v1alpha1';
export const CRD_API_VERSION = `${CRD_GROUP}/${CRD_VERSION}`;
export const WORKSPACE_PLURAL = 'workspaces';
export const TEMPLATE_PLURAL = 'workspacetemplates';

// K8s name validation — single regex, parameterized by max length.
const K8S_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Default 253: K8s resource name limit. Frontend uses 63 (DNS label / label-value safe).
export function isValidK8sName(name: unknown, maxLength = 253): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= maxLength && K8S_NAME_PATTERN.test(name);
}
