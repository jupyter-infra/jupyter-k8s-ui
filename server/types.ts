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
    defaultAccessStrategy?: { name: string; namespace?: string };
  };
}

export interface K8sListResponse<T> {
  items: T[];
  metadata?: { resourceVersion?: string };
}

// --- API Response Types ---

// Response types now pass through the K8s spec/status directly
// instead of cherry-picking fields. This ensures GPU resources,
// env vars, templateRef, and any future CRD fields are preserved.

export interface WorkspaceResponse {
  metadata: {
    name: string;
    namespace: string;
    annotations: Record<string, string>;
    creationTimestamp: string;
  };
  spec: K8sWorkspace['spec'];
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
  metadata: {
    name: string;
    namespace: string;
  };
  spec: K8sWorkspaceTemplate['spec'];
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
  accessType?: string;
  ownershipType?: string;
  resources?: K8sResourceRequirements;
  storage?: Record<string, unknown>;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
  podSecurityContext?: Record<string, unknown>;
  accessStrategy?: { name: string; namespace?: string };
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

export interface SessionConfig {
  enabled: boolean;
  cookieName: string;
  cookiePath: string;
  cookieMaxAgeSecs: number;
  maxSessionLifetimeSecs: number;
  nearExpiryThresholdSecs: number;
  secretName: string;
  secretNamespace: string;
  keyPrefix: string;
  newKeyUseDelaySecs: number;
  cookieSizeWarnBytes: number;
  cookieSizeMaxBytes: number;
  expectedDomain: string;
}

export interface ClusterAccessConfig {
  clusterName: string;
  apiServer: string;
  caCertBase64: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcCallbackPort: number;
}

export interface ServerConfig {
  namespace: string;
  staticDir: string;
  devUser: string;
  devAccessToken: string;
  port: number;
  logLevel: LogLevel;
  session: SessionConfig;
  clusterAccess: ClusterAccessConfig;
}
