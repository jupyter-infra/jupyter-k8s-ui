// Shared server-side types for K8s resources and API responses

// --- Domain Value Types ---

// CRD enum values — must mirror the `workspace.jupyter.org/v1alpha1` CRD. The
// unions are derived from these arrays so the runtime allow-list (used by the
// request guards) and the compile-time type can never drift apart: add a member
// here and both update together.
export const DESIRED_STATUSES = ['Running', 'Stopped'] as const;
export const ACCESS_TYPES = ['Public', 'OwnerOnly'] as const;
export const OWNERSHIP_TYPES = ['OwnerOnly', 'Public'] as const;

export type DesiredStatus = (typeof DESIRED_STATUSES)[number];
export type AccessType = (typeof ACCESS_TYPES)[number];
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

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
    desiredStatus?: DesiredStatus;
    accessType?: AccessType;
    ownershipType?: OwnershipType;
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
  desiredStatus?: DesiredStatus;
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  resources?: K8sResourceRequirements;
  storage?: { size: string };
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
}

export interface UpdateWorkspaceBody {
  displayName?: string;
  image?: string;
  desiredStatus?: DesiredStatus;
  accessType?: AccessType;
  ownershipType?: OwnershipType;
  resources?: K8sResourceRequirements;
  storage?: Record<string, unknown>;
  templateRef?: { name: string; namespace?: string };
  idleShutdown?: { enabled: boolean; timeoutInMinutes?: number };
  podSecurityContext?: Record<string, unknown>;
  accessStrategy?: { name: string; namespace?: string };
}

// Advanced YAML editor payload: a raw spec plus name + optional templateRef (the
// latter edited via a control above the editor, not in the buffer). Distinguished
// from the form bodies by the presence of `spec`. The editor owns the whole spec, so
// an update is a full-spec replace rather than a field merge.
export interface AdvancedWorkspaceBody {
  name: string;
  templateRef?: { name: string; namespace?: string };
  spec: Record<string, unknown>;
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
  // Shared namespace where admins publish cluster-wide templates / access
  // strategies (operator's --default-template-namespace, default jupyter-k8s-shared).
  sharedNamespace: string;
  staticDir: string;
  devUser: string;
  devAccessToken: string;
  port: number;
  logLevel: LogLevel;
  session: SessionConfig;
  clusterAccess: ClusterAccessConfig;
}
