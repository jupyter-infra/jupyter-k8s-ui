// Shared server-side types for K8s resources and API responses

// --- K8s Resource Types (what comes from the API server) ---

export interface K8sMetadata {
  name: string;
  namespace: string;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  resourceVersion?: string;
}

export interface K8sResourceRequirements {
  limits?: { cpu?: string; memory?: string; 'nvidia.com/gpu'?: string };
  requests?: { cpu?: string; memory?: string; 'nvidia.com/gpu'?: string };
}

export interface K8sCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface K8sWorkspace {
  apiVersion: string;
  kind: string;
  metadata: K8sMetadata;
  spec: {
    displayName?: string;
    image?: string;
    desiredStatus?: string;
    accessType?: string;
    ownershipType?: string;
    resources?: K8sResourceRequirements;
    storage?: Record<string, unknown>;
    templateRef?: { name: string; namespace?: string };
    idleShutdown?: { enabled: boolean; idleTimeoutInMinutes?: number };
    podSecurityContext?: Record<string, unknown>;
    accessStrategy?: { name: string; namespace?: string };
  };
  status?: {
    accessURL?: string;
    conditions?: K8sCondition[];
  };
}

export interface K8sWorkspaceTemplate {
  apiVersion: string;
  kind: string;
  metadata: K8sMetadata;
  spec: {
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
  };
}

export interface K8sListResponse<T> {
  items: T[];
  metadata?: { resourceVersion?: string };
}

// --- API Response Types ---

export interface WorkspaceResponse {
  metadata: {
    name: string;
    namespace: string;
    annotations: Record<string, string>;
    creationTimestamp: string;
  };
  spec: {
    displayName: string;
    image: string;
    desiredStatus: string;
    accessType: string;
    ownershipType: string;
    resources: {
      limits: { cpu: string; memory: string };
      requests: { cpu: string; memory: string };
    };
  };
  status?: {
    accessURL: string;
    conditions: Array<{
      type: string;
      status: string;
      reason: string;
      message: string;
    }>;
  };
}

export interface TemplateResponse {
  name: string;
  namespace: string;
  displayName: string;
  description: string;
  defaultImage: string;
  allowedImages: string[];
  allowCustomImages: boolean;
  defaultAccessType: string;
  defaultOwnershipType: string;
  resourceBounds?: {
    cpu?: { min: string; max: string };
    memory?: { min: string; max: string };
    gpu?: { min: string; max: string };
  };
  defaultResources?: { cpu: string; memory: string };
  storageConfig?: {
    defaultSize: string;
    minSize: string;
    maxSize: string;
    mountPath: string;
  };
  idleShutdown?: {
    enabled: boolean;
    defaultTimeoutMinutes: number;
    minTimeoutMinutes?: number;
    maxTimeoutMinutes?: number;
  };
}

// --- Request Types ---

export interface CreateWorkspaceBody {
  name: string;
  displayName?: string;
  image?: string;
  desiredStatus?: string;
  accessType?: string;
  ownershipType?: string;
  resources?: K8sResourceRequirements;
  storage?: Record<string, unknown>;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
  podSecurityContext?: Record<string, unknown>;
  accessStrategy?: { name: string; namespace?: string };
}

export interface UpdateWorkspaceBody {
  displayName?: string;
  image?: string;
  desiredStatus?: string;
  resources?: K8sResourceRequirements;
}

// --- Log Level ---

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// --- Server Config ---

export interface ServerConfig {
  namespace: string;
  staticDir: string;
  devUser: string;
  devAccessToken: string;
  port: number;
  logLevel: LogLevel;
}
