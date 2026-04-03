import { log } from './logger';
import { extractJWT } from './auth';
import { jsonResponse, errorResponse } from './responses';
import { serveStatic } from './static';
import { handleListWorkspaces, handleGetWorkspace, handleCreateWorkspace, handleUpdateWorkspace, handleDeleteWorkspace } from './handlers/workspaces';
import { handleListTemplates } from './handlers/templates';
import { handleGetMe } from './handlers/me';

// --- Route paths ---

const API_PREFIX = '/api/v1';

const ROUTES = {
  health: `${API_PREFIX}/health`,
  me: `${API_PREFIX}/me`,
  workspaces: `${API_PREFIX}/workspaces`,
  workspace: new RegExp(`^${API_PREFIX}/workspaces/([^/]+)$`),
  templates: `${API_PREFIX}/templates`,
} as const;

// --- Request Handler ---

export async function handleRequest(req: Request): Promise<Response> {
  try {
    return await routeRequest(req);
  } catch (error) {
    log('error', `Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(500, 'Internal server error');
  }
}

async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  log('debug', `${method} ${pathname}`);

  // Public endpoints
  if (pathname === ROUTES.health && method === 'GET') {
    return jsonResponse({ status: 'ok' });
  }

  if (pathname === ROUTES.me && method === 'GET') {
    return handleGetMe(req);
  }

  // Authenticated endpoints
  if (pathname.startsWith(`${API_PREFIX}/`)) {
    const jwt = extractJWT(req);
    if (!jwt) return errorResponse(401, 'Authentication required');

    if (pathname === ROUTES.workspaces) {
      const handlers: Record<string, () => Promise<Response>> = {
        GET: () => handleListWorkspaces(jwt),
        POST: () => handleCreateWorkspace(jwt, req),
      };
      return handlers[method]?.() ?? errorResponse(405, 'Method not allowed');
    }

    const workspaceMatch = pathname.match(ROUTES.workspace);
    if (workspaceMatch) {
      const name = workspaceMatch[1];
      const handlers: Record<string, () => Promise<Response>> = {
        GET: () => handleGetWorkspace(jwt, name),
        PUT: () => handleUpdateWorkspace(jwt, name, req),
        PATCH: () => handleUpdateWorkspace(jwt, name, req),
        DELETE: () => handleDeleteWorkspace(jwt, name),
      };
      return handlers[method]?.() ?? errorResponse(405, 'Method not allowed');
    }

    if (pathname === ROUTES.templates) {
      const handlers: Record<string, () => Promise<Response>> = {
        GET: () => handleListTemplates(jwt),
      };
      return handlers[method]?.() ?? errorResponse(405, 'Method not allowed');
    }

    return errorResponse(404, 'API endpoint not found');
  }

  // Static files
  const staticResponse = await serveStatic(pathname);
  if (staticResponse) return staticResponse;

  if (pathname !== '/' && !pathname.includes('.')) {
    const indexResponse = await serveStatic('/');
    if (indexResponse) return indexResponse;
  }

  return errorResponse(404, 'Not found');
}
