import { log } from '../logger';
import { serverConfig } from '../k8s/config';
import { isValidK8sName } from '../guards';
import { extractAuth, getSessionCookieHeader } from './auth';
import { validateCSRF } from './csrf';
import { jsonResponse, errorResponse } from '../responses';
import { buildClearCookieHeader } from './session';
import { serveStatic } from '../static';
import { handleListWorkspaces, handleGetWorkspace, handleCreateWorkspace, handleUpdateWorkspace, handleDeleteWorkspace } from '../handlers/workspaces';
import { handleListTemplates } from '../handlers/templates';
import { handleListAccessStrategies } from '../handlers/access-strategies';
import { handleGetMe } from '../handlers/me';
import { handleGetClusterAccess } from '../handlers/cluster-access';
import { handleGetCrdSchema } from '../handlers/crd-schema';
import { isNamespaceUniverseReady } from '../k8s/namespace-universe';
import { handleGetMyNamespace, handlePatchMyNamespace, handleListNamespaces, handleGetNamespaceAccess } from '../handlers/namespaces';
import { resolveNamespace } from '../k8s/resolve-namespace';

// --- Route paths ---

const API_PREFIX = '/api/v1';

const ROUTES = {
  health: `${API_PREFIX}/health`,
  me: `${API_PREFIX}/me`,
  myNamespace: `${API_PREFIX}/my-namespace`,
  namespaces: `${API_PREFIX}/namespaces`,
  namespaceAccess: new RegExp(`^${API_PREFIX}/namespaces/([^/]+)/access$`),
  workspaces: `${API_PREFIX}/workspaces`,
  workspace: new RegExp(`^${API_PREFIX}/workspaces/([^/]+)$`),
  templates: `${API_PREFIX}/templates`,
  accessStrategies: `${API_PREFIX}/access-strategies`,
  clusterAccess: `${API_PREFIX}/cluster-access`,
  crdSchema: new RegExp(`^${API_PREFIX}/crd-schema/([^/]+)$`),
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
  // K8s rejected the token — clear the session cookie so Traefik's fast-path
  // stops matching and the next request goes through OAuth2 Proxy for re-auth.
  if (response.status === 401) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.append('Set-Cookie', buildClearCookieHeader(serverConfig.session));
    return newResponse;
  }

  const cookieHeader = getSessionCookieHeader(jwt, source);
  if (!cookieHeader) return response;

  // Clone response to add the Set-Cookie header
  const newResponse = new Response(response.body, response);
  newResponse.headers.append('Set-Cookie', cookieHeader);
  return newResponse;
}

async function dispatch(
  method: string,
  handlers: Record<string, () => Promise<Response>>,
  jwt: string,
  source: import('./auth').TokenSource,
): Promise<Response> {
  const response = await (handlers[method]?.() ?? Promise.resolve(errorResponse(405, 'Method not allowed')));
  return withSessionCookie(response, jwt, source);
}

async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  log('debug', `${method} ${pathname}`);

  // Public endpoints
  if (pathname === ROUTES.health && method === 'GET') {
    // `ready` reflects the namespace-universe poll's initial sync. A readiness probe
    // (configured in the deployment charts) can gate traffic on it so a pod never serves
    // discovery with an empty universe; liveness should stay on `status:ok` regardless.
    return jsonResponse({ status: 'ok', ready: isNamespaceUniverseReady() });
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

    // Content-Type check for mutations
    const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH';
    if (isMutation && !req.headers.get('Content-Type')?.includes('application/json')) {
      return errorResponse(415, 'Content-Type must be application/json');
    }

    // --- Namespace selection endpoints ---

    if (pathname === ROUTES.myNamespace) {
      // GET: cheap bootstrap (cookie read, no SSAR, no cookie write).
      // PATCH: persist the active-namespace preference (writes activeNs; no SSAR).
      return dispatch(
        method,
        {
          GET: () => Promise.resolve(handleGetMyNamespace(req)),
          PATCH: () => handlePatchMyNamespace(req),
        },
        jwt,
        source,
      );
    }

    if (pathname === ROUTES.namespaces && method === 'GET') {
      // Switcher list; refreshes the `visible` snapshot cookie (?refresh=1 forces recompute).
      return withSessionCookie(await handleListNamespaces(req, jwt), jwt, source);
    }

    const namespaceAccessMatch = pathname.match(ROUTES.namespaceAccess);
    if (namespaceAccessMatch && method === 'GET') {
      const ns = namespaceAccessMatch[1];
      if (!isValidK8sName(ns)) {
        return errorResponse(400, 'Invalid namespace');
      }
      return withSessionCookie(await handleGetNamespaceAccess(jwt, ns), jwt, source);
    }

    if (pathname === ROUTES.workspaces) {
      const resolved = await resolveNamespace(req, jwt);
      if (!resolved.ok) return resolved.response;
      const ns = resolved.namespace;
      return dispatch(
        method,
        {
          GET: () => handleListWorkspaces(jwt, ns),
          POST: () => handleCreateWorkspace(jwt, ns, req),
        },
        jwt,
        source,
      );
    }

    const workspaceMatch = pathname.match(ROUTES.workspace);
    if (workspaceMatch) {
      const name = workspaceMatch[1];
      if (!isValidK8sName(name)) {
        return errorResponse(400, 'Invalid workspace name');
      }
      const resolved = await resolveNamespace(req, jwt);
      if (!resolved.ok) return resolved.response;
      const ns = resolved.namespace;
      return dispatch(
        method,
        {
          GET: () => handleGetWorkspace(jwt, ns, name),
          PUT: () => handleUpdateWorkspace(jwt, ns, name, req),
          PATCH: () => handleUpdateWorkspace(jwt, ns, name, req),
          DELETE: () => handleDeleteWorkspace(jwt, ns, name),
        },
        jwt,
        source,
      );
    }

    if (pathname === ROUTES.templates) {
      const resolved = await resolveNamespace(req, jwt);
      if (!resolved.ok) return resolved.response;
      const ns = resolved.namespace;
      return dispatch(
        method,
        {
          GET: () => handleListTemplates(jwt, ns),
        },
        jwt,
        source,
      );
    }

    if (pathname === ROUTES.accessStrategies) {
      const resolved = await resolveNamespace(req, jwt);
      if (!resolved.ok) return resolved.response;
      const ns = resolved.namespace;
      return dispatch(
        method,
        {
          GET: () => handleListAccessStrategies(jwt, ns),
        },
        jwt,
        source,
      );
    }

    if (pathname === ROUTES.clusterAccess && method === 'GET') {
      return withSessionCookie(handleGetClusterAccess(), jwt, source);
    }

    const crdSchemaMatch = pathname.match(ROUTES.crdSchema);
    if (crdSchemaMatch && method === 'GET') {
      // Served from the in-memory singleton (SA-loaded at startup); no per-user data.
      return withSessionCookie(handleGetCrdSchema(crdSchemaMatch[1]), jwt, source);
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
