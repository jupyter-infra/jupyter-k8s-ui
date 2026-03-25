import { resolve, join } from 'path';
import { serverConfig } from './k8s';
import { errorResponse } from './responses';
import { log } from './logger';

const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css',
  js: 'application/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/**
 * Serve a static file from the configured static directory.
 * Returns null if the file doesn't exist.
 */
export function serveStatic(pathname: string): Response | null {
  const staticDir = resolve(serverConfig.staticDir);
  const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const fullPath = resolve(join(staticDir, filePath));

  // Prevent directory traversal
  if (!fullPath.startsWith(staticDir)) {
    log('warn', `Path traversal attempt blocked: ${fullPath}`);
    return errorResponse(403, 'Forbidden');
  }

  const file = Bun.file(fullPath);

  // Bun.file doesn't throw on missing files — check size
  if (file.size === 0 && !fullPath.endsWith('.html')) {
    return null;
  }

  try {
    const ext = filePath.split('.').pop() || '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    return new Response(file, {
      headers: { 'Content-Type': contentType },
    });
  } catch {
    return null;
  }
}
