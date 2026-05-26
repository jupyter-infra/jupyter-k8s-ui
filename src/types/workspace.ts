// Workspace domain types

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

export interface WorkspaceSpec {
  displayName?: string;
  image?: string;
  desiredStatus?: string;
  accessType?: string;
  ownershipType?: string;
  resources?: ResourceRequirements;
  storage?: Record<string, unknown>;
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
  templateRef?: { name: string; namespace?: string };
  image?: string;
  resources?: ResourceRequirements;
  storage?: { size?: string; mountPath?: string; storageClassName?: string };
  accessType?: string;
  ownershipType?: string;
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
  podSecurityContext?: { fsGroup?: number };
  accessStrategy?: { name: string; namespace?: string };
}

export interface UpdateWorkspaceRequest {
  displayName?: string;
  image?: string;
  desiredStatus?: string;
  accessType?: string;
  ownershipType?: string;
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
