import { serve } from 'bun';
import { initializeConfig, serverConfig } from './k8s';
import { log } from './logger';
import { handleRequest } from './router';
import { initSecretWatcher, stopSecretWatcher } from './secret-watcher';

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
