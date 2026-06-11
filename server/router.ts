import { log } from './logger';
import { serverConfig } from './k8s';
import { extractAuth, getSessionCookieHeader } from './auth';
import { validateCSRF } from './csrf';
import { jsonResponse, errorResponse } from './responses';
import { buildClearCookieHeader } from './session';
import { serveStatic } from './static';
import { handleListWorkspaces, handleGetWorkspace, handleCreateWorkspace, handleUpdateWorkspace, handleDeleteWorkspace } from './handlers/workspaces';
import { handleListTemplates } from './handlers/templates';
import { handleGetMe } from './handlers/me';
import { handleGetClusterAccess } from './handlers/cluster-access';

// --- Route paths ---

const API_PREFIX = '/api/v1';

const ROUTES = {
  health: `${API_PREFIX}/health`,
  me: `${API_PREFIX}/me`,
  workspaces: `${API_PREFIX}/workspaces`,
  workspace: new RegExp(`^${API_PREFIX}/workspaces/([^/]+)$`),
  templates: `${API_PREFIX}/templates`,
  clusterAccess: `${API_PREFIX}/cluster-access`,
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

/**
 * Attach a Set-Cookie header to a response if needed.
 */
function withSessionCookie(response: Response, jwt: string, source: import('./auth').TokenSource): Response {
  const cookieHeader = getSessionCookieHeader(jwt, source);
  if (!cookieHeader) return response;

  // Clone response to add the Set-Cookie header
  const newResponse = new Response(response.body, response);
  newResponse.headers.append('Set-Cookie', cookieHeader);
  return newResponse;
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
    const auth = extractAuth(req);
    if (!auth) {
      // Clear the session cookie so the browser stops sending it. Traefik's
      // fast-path IngressRoute matches on cookie presence (HeaderRegexp); if a
      // stale cookie remains, every reload bypasses OAuth2 Proxy and lands here
      // again — the user can never re-authenticate. Clearing it lets the next
      // request fall to the auth-path route where OAuth2 Proxy triggers a fresh
      // OIDC flow with Dex.
      const resp = errorResponse(401, 'Authentication required');
      resp.headers.append('Set-Cookie', buildClearCookieHeader(serverConfig.session));
      return resp;
    }

    const { jwt, source } = auth;

    // CSRF check for mutations
    if (!validateCSRF(req)) {
      return errorResponse(403, 'CSRF validation failed');
    }

    let response: Response;

    if (pathname === ROUTES.workspaces) {
      const handlers: Record<string, () => Promise<Response>> = {
        GET: () => handleListWorkspaces(jwt),
        POST: () => handleCreateWorkspace(jwt, req),
      };
      response = await (handlers[method]?.() ?? Promise.resolve(errorResponse(405, 'Method not allowed')));
      return withSessionCookie(response, jwt, source);
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
      response = await (handlers[method]?.() ?? Promise.resolve(errorResponse(405, 'Method not allowed')));
      return withSessionCookie(response, jwt, source);
    }

    if (pathname === ROUTES.templates) {
      const handlers: Record<string, () => Promise<Response>> = {
        GET: () => handleListTemplates(jwt),
      };
      response = await (handlers[method]?.() ?? Promise.resolve(errorResponse(405, 'Method not allowed')));
      return withSessionCookie(response, jwt, source);
    }

    if (pathname === ROUTES.clusterAccess && method === 'GET') {
      response = handleGetClusterAccess();
      return withSessionCookie(response, jwt, source);
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
