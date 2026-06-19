import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ServerConfig } from '../types';

function parseIntSafe(value: string | undefined, fallback: number): number {
  const n = parseInt(value || String(fallback), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Use a single object reference — mutate properties, never reassign.
// This ensures all importers share the same config instance.
export const serverConfig: ServerConfig = {
  namespace: 'default',
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
};

export function initializeConfig(): void {
  const isDev = process.env.NODE_ENV === 'development';

  serverConfig.namespace = process.env.NAMESPACE || 'default';
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
