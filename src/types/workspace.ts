// Workspace domain types

// --- Domain Value Types ---
export type DesiredStatus = 'Running' | 'Stopped';
export type AccessType = 'Public' | 'OwnerOnly';
export type OwnershipType = 'OwnerOnly' | 'Public';

export interface WorkspaceMetadata {
  name: string;
  namespace: string;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
}

export interface ResourceRequirements {
  limits?: Record<string, string>;
  requests?: Record<string, string>;
}

export interface StorageSpec {
  size?: string;
  mountPath?: string;
  storageClassName?: string;
}

// Idle detection is app-specific and opaque to the UI — we only relay it verbatim
// (never parse or author it). Mirrors the server's IdleDetection passthrough.
export type IdleDetection = Record<string, unknown>;

export interface WorkspaceSpec {
  displayName?: string;
  image?: string;
  appType?: string;
  desiredStatus?: DesiredStatus;
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  resources?: ResourceRequirements;
  storage?: StorageSpec;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: { enabled: boolean; idleTimeoutInMinutes?: number; detection?: IdleDetection };
  podSecurityContext?: Record<string, unknown>;
  accessStrategy?: { name: string; namespace?: string };
}

export interface WorkspaceCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
}

export interface WorkspaceStatus {
  accessURL?: string;
  conditions?: WorkspaceCondition[];
}

export interface Workspace {
  metadata: WorkspaceMetadata;
  spec: WorkspaceSpec;
  status?: WorkspaceStatus;
}

export interface WorkspaceTemplateSpec {
  displayName?: string;
  description?: string;
  defaultImage?: string;
  allowedImages?: string[];
  allowCustomImages?: boolean;
  defaultAccessType?: string;
  defaultOwnershipType?: string;
  baseEnv?: Array<{ name: string; value?: string }>;
  resourceBounds?: {
    resources?: {
      cpu?: { min?: string; max?: string };
      memory?: { min?: string; max?: string };
      'nvidia.com/gpu'?: { min?: string; max?: string };
    };
  };
  defaultResources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  primaryStorage?: {
    defaultSize?: string;
    minSize?: string;
    maxSize?: string;
    defaultMountPath?: string;
    defaultStorageClassName?: string;
  };
  defaultIdleShutdown?: {
    enabled?: boolean;
    idleTimeoutInMinutes?: number;
    detection?: IdleDetection;
  };
  idleShutdownOverrides?: {
    allow?: boolean;
    minIdleTimeoutInMinutes?: number;
    maxIdleTimeoutInMinutes?: number;
  };
  appType?: string;
  defaultAccessStrategy?: { name: string; namespace?: string };
}

export interface WorkspaceTemplate {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: WorkspaceTemplateSpec;
}

// Complete idleShutdown block the client sends when idle is present — echoes `detection`
// verbatim, never a partial block.
export interface IdleShutdownRequest {
  enabled: boolean;
  timeoutInMinutes?: number;
  detection?: IdleDetection;
}

export interface CreateWorkspaceRequest {
  name: string;
  displayName: string;
  image?: string;
  resources?: ResourceRequirements;
  storage?: { size: string };
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: IdleShutdownRequest;
}

export interface UpdateWorkspaceRequest {
  displayName?: string;
  image?: string;
  desiredStatus?: DesiredStatus;
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  resources?: ResourceRequirements;
  storage?: Record<string, unknown>;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: IdleShutdownRequest;
  podSecurityContext?: Record<string, unknown>;
  accessStrategy?: { name: string; namespace?: string };
}

// --- Advanced YAML editor ---

// The advanced editor submits a raw spec object (a full-spec replace on update) plus a
// name and optional templateRef — the latter two are edited via structured controls
// above the editor, not in the YAML buffer.
export interface AdvancedWorkspacePayload {
  name: string;
  templateRef?: { name: string; namespace?: string };
  spec: WorkspaceSpec;
}

// Discovery (templates / access strategies) fans out to the user's namespace and the
// shared namespace. `access` reports which sources the user's RBAC could list, so the
// UI can show a graceful-degradation notice without treating denial as an error.
export interface DiscoveryAccess {
  user: 'ok' | 'denied';
  shared: 'ok' | 'denied';
}

export interface DiscoveredTemplate extends WorkspaceTemplate {
  sourceNamespace: string;
}

export interface DiscoveredAccessStrategy {
  name: string;
  sourceNamespace: string;
  displayName?: string;
  description?: string;
}

export interface DiscoveryResponse<T> {
  items: T[];
  access: DiscoveryAccess;
  // Present on the templates response: which namespace is the user's own vs. the shared
  // one, so the picker can mirror the operator's own-ns-beats-shared default precedence (A8).
  namespaces?: { own: string; shared: string };
}

export interface ClusterAccessInfo {
  clusterName: string;
  apiServer: string;
  caCertBase64: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcCallbackPort: number;
}
