import { extractJWT, decodeJWTPayload } from '../middleware/auth';
import { resolveK8sUsername } from '../k8s/identity';
import { readNamespacePreference, buildNamespacePreferenceCookie } from '../middleware/namespace-preference';
import { buildClearCookieHeader, parseCookieValue } from '../middleware/session';
import { serverConfig } from '../k8s/config';
import { jsonResponse, errorResponse } from '../responses';

// True when the request still carries a session cookie that yielded no usable token —
// i.e. it's stale/unvalidatable (e.g. its signing key rotated out of retention).
function hasSessionCookie(req: Request): boolean {
  if (!serverConfig.session.enabled) return false;
  const cookieHeader = req.headers.get('Cookie');
  if (!cookieHeader) return false;
  return parseCookieValue(cookieHeader, serverConfig.session.cookieName) !== null;
}

// GET /me is the read-through cache for the authoritative K8s username. The cookie holds it
// (signed, user-bound, no expiry — it's stable per identity); on a miss we resolve it ONCE
// via SelfSubjectReview and mint it back, so /me stays a pure-JWT response on every
// subsequent load and — since the cookie travels with the request — across ALL web-app
// replicas without any shared server-side cache.
export async function handleGetMe(req: Request): Promise<Response> {
  const jwt = extractJWT(req);
  if (!jwt) {
    const response = jsonResponse({ authenticated: false, user: null });
    // A tokenless /me that still carries a session cookie means the cookie is
    // stale/unvalidatable. A deployment may front the app with an auth proxy that routes
    // on session-cookie *presence*, in which case a stale-but-present cookie keeps
    // hitting this already-authenticated path and never reaches the unauthenticated flow
    // that could re-issue a token — trapping the user. Clear it (mirroring the
    // authenticated /api/* 401 path) so the next request takes the unauthenticated path
    // and can self-heal.
    if (hasSessionCookie(req)) {
      response.headers.append('Set-Cookie', buildClearCookieHeader(serverConfig.session));
    }
    return response;
  }

  const payload = decodeJWTPayload(jwt);
  if (!payload) {
    return errorResponse(401, 'Invalid token');
  }

  // `displayUser` is the raw OIDC claim — for display (avatar, default workspace names).
  // `k8sUser` is the authoritative Kubernetes username the API server enforces against
  // (<username-prefix>:<claim>) — the string the operator stamps into `created-by`, so it,
  // not `displayUser`, is what ownership must compare against. null when unresolvable (dev
  // no-cluster, transient error); ownership then matches nothing (fail-closed display hint).
  const pref = readNamespacePreference(req, jwt);
  const cachedK8sUser = pref.k8sUser;
  // Only pay for SelfSubjectReview on a cache miss — the sole cluster call this handler makes.
  const k8sUser = cachedK8sUser ?? (await resolveK8sUsername(jwt));

  const response = jsonResponse({
    authenticated: true,
    user: {
      displayUser: payload.preferred_username || payload.sub,
      k8sUser,
      email: payload.email || null,
      groups: payload.groups || [],
    },
    claims: payload,
  });

  // Mint the resolved identity into the cookie only when it's newly learned. Never cache a
  // null (unresolved) result — that would pin "matches nothing" and block a later retry.
  // `preserveVisibleExp` carries the visible-set snapshot verbatim: /me owns k8sUser, never
  // the RBAC freshness window (that's GET /namespaces').
  if (!cachedK8sUser && k8sUser) {
    const cookie = buildNamespacePreferenceCookie({ ...pref, k8sUser }, jwt, { preserveVisibleExp: true });
    if (cookie) response.headers.append('Set-Cookie', cookie);
  }

  return response;
}
