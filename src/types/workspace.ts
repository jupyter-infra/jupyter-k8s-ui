// Workspace domain types

// --- Domain Value Types ---
export type DesiredStatus = 'Running' | 'Stopped';
export type AccessType = 'Public' | 'Private';
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

export interface WorkspaceSpec {
  displayName?: string;
  image?: string;
  desiredStatus?: DesiredStatus;
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  resources?: ResourceRequirements;
  storage?: StorageSpec;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: { enabled: boolean; idleTimeoutInMinutes?: number };
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
  resourceBounds?: {
    resources?: {
      cpu?: { min?: string; max?: string };
      memory?: { min?: string; max?: string };
      'nvidia.com/gpu'?: { min?: string; max?: string };
    };
  };
  defaultResources?: {
    requests?: { cpu?: string; memory?: string };
  };
  primaryStorage?: {
    defaultSize?: string;
    minSize?: string;
    maxSize?: string;
    defaultMountPath?: string;
  };
  defaultIdleShutdown?: {
    enabled?: boolean;
    idleTimeoutInMinutes?: number;
  };
  idleShutdownOverrides?: {
    minIdleTimeoutInMinutes?: number;
    maxIdleTimeoutInMinutes?: number;
  };
  defaultAccessStrategy?: { name: string; namespace?: string };
}

export interface WorkspaceTemplate {
  metadata: { name: string; namespace: string };
  spec: WorkspaceTemplateSpec;
}

export interface CreateWorkspaceRequest {
  name: string;
  displayName: string;
  resources?: ResourceRequirements;
  storage?: { size: string };
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
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
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
  podSecurityContext?: Record<string, unknown>;
  accessStrategy?: { name: string; namespace?: string };
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
