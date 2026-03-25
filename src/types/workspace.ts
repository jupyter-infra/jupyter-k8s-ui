// Workspace domain types

export interface WorkspaceMetadata {
  name: string;
  namespace: string;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
}

export interface WorkspaceResources {
  limits: { cpu: string; memory: string };
  requests: { cpu: string; memory: string };
}

export interface WorkspaceSpec {
  displayName: string;
  image: string;
  desiredStatus: 'Running' | 'Stopped';
  accessType: 'Public' | 'OwnerOnly';
  ownershipType: 'Public' | 'OwnerOnly';
  resources: WorkspaceResources;
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

export interface WorkspaceTemplate {
  name: string;
  namespace: string;
  displayName: string;
  description?: string;
  defaultImage: string;
  allowedImages?: string[];
  allowCustomImages: boolean;
  resourceBounds?: {
    cpu?: { min: string; max: string };
    memory?: { min: string; max: string };
    gpu?: { min: string; max: string };
  };
  defaultResources?: {
    cpu?: string;
    memory?: string;
  };
  storageConfig?: {
    defaultSize?: string;
    minSize?: string;
    maxSize?: string;
    mountPath?: string;
  };
  defaultAccessType?: string;
  defaultOwnershipType?: string;
  idleShutdown?: {
    enabled: boolean;
    defaultTimeoutMinutes?: number;
    minTimeoutMinutes?: number;
    maxTimeoutMinutes?: number;
  };
}

export interface CreateWorkspaceRequest {
  name: string;
  displayName: string;
  templateRef?: { name: string; namespace?: string };
  image?: string;
  resources?: WorkspaceResources;
  storage?: { size?: string; mountPath?: string; storageClassName?: string };
  accessType?: string;
  ownershipType?: string;
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
  podSecurityContext?: { fsGroup?: number };
  accessStrategy?: { name: string; namespace?: string };
}
