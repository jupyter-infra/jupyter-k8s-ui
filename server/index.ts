import { serve } from 'bun';
import { initializeConfig, serverConfig } from './k8s/config';
import { log } from './logger';
import { handleRequest } from './middleware/router';
import { initSecretWatcher, stopSecretWatcher } from './secret-watcher';
import { initSchemaStore } from './schema/store';

// --- Initialize ---

initializeConfig();

// --- Start Server ---

console.log('🚀 Starting Jupyter K8s UI Backend Server (Bun)...');
console.log('📋 Configuration:');
console.log(`   NODE_ENV:  ${process.env.NODE_ENV || 'production'}`);
console.log(`   PORT:      ${serverConfig.port}`);
console.log(`   NAMESPACE: ${serverConfig.namespace}`);
console.log(`   LOG_LEVEL: ${serverConfig.logLevel}`);
console.log(`   STATIC:    ${serverConfig.staticDir}`);
console.log(`   DEV_TOKEN: ${serverConfig.devAccessToken ? '***set***' : 'not set'}`);
console.log(`   SESSION:   ${serverConfig.session.enabled ? 'enabled' : 'disabled'}`);

// Initialize session secret watcher
if (serverConfig.session.enabled) {
  initSecretWatcher(serverConfig.session).catch((err) => {
    log('error', `Failed to initialize secret watcher: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// Load CRD spec schemas once (live read + vendored fallback). Non-fatal: the store
// degrades to vendored schemas, and the editor falls back further to plain YAML.
initSchemaStore().catch((err) => {
  log('error', `Failed to initialize CRD schema store: ${err instanceof Error ? err.message : String(err)}`);
});

const server = serve({
  port: serverConfig.port,
  fetch: handleRequest,
  idleTimeout: 0,
});

log('info', `Server running at http://localhost:${server.port}`);

// Graceful shutdown on K8s/Docker terminate signals
async function shutdown() {
  log('info', 'Shutting down server...');
  await stopSecretWatcher();
  server.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
