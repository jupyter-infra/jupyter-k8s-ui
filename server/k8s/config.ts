import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ServerConfig } from '../types';

/** Parse a non-negative int from an env value; fall back on undefined/blank/NaN/negative. */
export function parseIntSafe(value: string | undefined, fallback: number): number {
  const n = parseInt(value || String(fallback), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Use a single object reference — mutate properties, never reassign.
// This ensures all importers share the same config instance.
export const serverConfig: ServerConfig = {
  namespace: 'default',
  sharedNamespace: 'jupyter-k8s-shared',
  staticDir: './dist',
  devUser: '',
  devAccessToken: '',
  port: 8090,
  logLevel: 'info',
  session: {
    enabled: false,
    cookieName: 'workspace_console_session',
    cookiePath: '/api/',
    cookieMaxAgeSecs: 2700,
    maxSessionLifetimeSecs: 3600,
    nearExpiryThresholdSecs: 600,
    secretName: 'web-app-session-secret',
    secretNamespace: '',
    keyPrefix: 'session-key-',
    newKeyUseDelaySecs: 60,
    cookieSizeWarnBytes: 3800,
    cookieSizeMaxBytes: 4096,
    expectedDomain: '',
  },
  clusterAccess: {
    clusterName: '',
    apiServer: '',
    caCertBase64: '',
    oidcIssuerUrl: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcCallbackPort: 9800,
  },
  namespaceSelection: {
    labelSelector: 'workspace.jupyter.org/workspaces-enabled=true',
    staticNamespaces: ['default'],
    candidateCap: 20,
    visiblePersistCap: 100,
    pollIntervalSecs: 60,
  },
};

/** Split a comma-separated env value into a trimmed, de-duplicated, non-empty list. */
export function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * The admin-declared namespaces, in their stable front-of-list order:
 *   1. `defaultNamespace` (the configured NAMESPACE) — always first, always present.
 *   2. `knownNamespaces` (WORKSPACE_NAMESPACES) in declared order, with the default and any
 *      duplicates filtered out.
 * These pin to the front of the candidate ordering; being config-derived they are
 * drift-proof (unlike the alphabetical tail of discovered namespaces), which keeps a
 * paginated `checkedUpTo` index stable across universe changes.
 *
 * Pure — no serverConfig access — so it's trivially testable. Ignores empty/blank entries
 * defensively (callers may pass unsanitized lists).
 */
export function declaredNamespaces(defaultNamespace: string, knownNamespaces: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ns of [defaultNamespace, ...knownNamespaces]) {
    const trimmed = ns?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function initializeConfig(): void {
  const isDev = process.env.NODE_ENV === 'development';

  serverConfig.namespace = process.env.NAMESPACE || 'default';
  serverConfig.sharedNamespace = process.env.SHARED_TEMPLATE_NAMESPACE || 'jupyter-k8s-shared';
  serverConfig.staticDir = process.env.STATIC_DIR || './dist';
  serverConfig.devUser = process.env.DEV_USER || '';
  serverConfig.devAccessToken = isDev ? process.env.DEV_ACCESS_TOKEN || '' : '';
  serverConfig.port = parseIntSafe(process.env.PORT, 8090);
  serverConfig.logLevel = (process.env.LOG_LEVEL as ServerConfig['logLevel']) || (isDev ? 'debug' : 'info');

  if (!isDev && process.env.DEV_ACCESS_TOKEN) {
    console.warn('⚠️  WARNING: DEV_ACCESS_TOKEN is set but will be ignored in production mode');
  }

  // Session config
  serverConfig.session.enabled = process.env.SESSION_ENABLED !== 'false';
  serverConfig.session.cookieName = process.env.SESSION_COOKIE_NAME || 'workspace_console_session';
  serverConfig.session.cookiePath = process.env.SESSION_COOKIE_PATH || '/api/';
  serverConfig.session.cookieMaxAgeSecs = parseIntSafe(process.env.SESSION_COOKIE_MAX_AGE_SECS, 2700);
  serverConfig.session.maxSessionLifetimeSecs = parseIntSafe(process.env.SESSION_MAX_LIFETIME_SECS, 3600);
  serverConfig.session.nearExpiryThresholdSecs = parseIntSafe(process.env.SESSION_NEAR_EXPIRY_THRESHOLD_SECS, 600);
  serverConfig.session.secretName = process.env.SESSION_SECRET_NAME || 'web-app-session-secret';
  serverConfig.session.secretNamespace = process.env.SESSION_SECRET_NAMESPACE || serverConfig.namespace;
  serverConfig.session.keyPrefix = process.env.SESSION_KEY_PREFIX || 'session-key-';
  serverConfig.session.newKeyUseDelaySecs = parseIntSafe(process.env.SESSION_NEW_KEY_USE_DELAY_SECS, 60);
  serverConfig.session.expectedDomain = process.env.SESSION_EXPECTED_DOMAIN || '';

  // Namespace-selection config. The label selector is either given verbatim
  // (WORKSPACE_NAMESPACE_LABEL_SELECTOR) or derived from a single key
  // (WORKSPACE_NAMESPACE_LABEL, matched against "true"); the default marks
  // workspace-enabled namespaces. The static list always unions in the configured
  // `namespace`, so the universe (and thus the switcher) is never empty.
  const nsLabelKey = process.env.WORKSPACE_NAMESPACE_LABEL || 'workspace.jupyter.org/workspaces-enabled';
  serverConfig.namespaceSelection.labelSelector = process.env.WORKSPACE_NAMESPACE_LABEL_SELECTOR || `${nsLabelKey}=true`;
  const staticNs = parseCsv(process.env.WORKSPACE_NAMESPACES);
  serverConfig.namespaceSelection.staticNamespaces = staticNs.length > 0 ? staticNs : [serverConfig.namespace];
  serverConfig.namespaceSelection.candidateCap = parseIntSafe(process.env.NAMESPACE_CANDIDATE_CAP, 20);
  serverConfig.namespaceSelection.visiblePersistCap = parseIntSafe(process.env.NAMESPACE_VISIBLE_PERSIST_CAP, 100);
  serverConfig.namespaceSelection.pollIntervalSecs = parseIntSafe(process.env.NAMESPACE_POLL_INTERVAL_SECS, 60);

  // Cluster access config (for kubectl access page)
  serverConfig.clusterAccess.clusterName = process.env.CLUSTER_NAME || '';
  serverConfig.clusterAccess.apiServer = process.env.CLUSTER_API_SERVER || '';
  serverConfig.clusterAccess.caCertBase64 = process.env.CLUSTER_CA_CERT_BASE64 || '';
  serverConfig.clusterAccess.oidcIssuerUrl = process.env.OIDC_ISSUER_URL || '';
  serverConfig.clusterAccess.oidcClientId = process.env.OIDC_CLIENT_ID || '';
  serverConfig.clusterAccess.oidcClientSecret = process.env.OIDC_CLIENT_SECRET || '';
  serverConfig.clusterAccess.oidcCallbackPort = parseIntSafe(process.env.OIDC_CALLBACK_PORT, 9800);
}

export function hasKubeconfig(): boolean {
  try {
    const kubeconfigPath = process.env.KUBECONFIG || join(homedir(), '.kube', 'config');
    return existsSync(kubeconfigPath);
  } catch {
    return false;
  }
}

export function isLocalDevelopment(): boolean {
  if (process.env.KUBERNETES_SERVICE_HOST) return false;
  if (hasKubeconfig()) return false;
  return true;
}
