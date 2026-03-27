import { serve } from 'bun';
import { initializeConfig, serverConfig } from './k8s';
import { log } from './logger';
import { handleRequest } from './router';

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

const server = serve({
  port: serverConfig.port,
  fetch: handleRequest,
  idleTimeout: 0,
});

log('info', `Server running at http://localhost:${server.port}`);

// Graceful shutdown on K8s/Docker terminate signals
function shutdown() {
  log('info', 'Shutting down server...');
  server.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
