import { serverConfig } from '../k8s/config';
import { log } from '../logger';
import { validateSessionCookie, createSessionCookie, parseCookieValue, buildSetCookieHeader } from './session';
import { getKeyMap } from '../secret-watcher';

// --- Token Source ---

export type TokenSource = 'dev' | 'cookie' | 'header' | null;

export interface ExtractedAuth {
  jwt: string;
  source: TokenSource;
}

/**
 * Extract JWT token from an incoming request.
 *
 * Resolution order:
 * 1. DEV_ACCESS_TOKEN env var (development only)
 * 2. workspace_console_session cookie → decrypt → extract Dex token
 * 3. X-Auth-Request-Access-Token header (OAuth2 Proxy)
 */
export function extractAuth(req: Request): ExtractedAuth | null {
  // 1. Dev token
  if (process.env.NODE_ENV === 'development' && serverConfig.devAccessToken) {
    return { jwt: serverConfig.devAccessToken, source: 'dev' };
  }

  // 2. Session cookie (fast path)
  if (serverConfig.session.enabled) {
    const cookieHeader = req.headers.get('Cookie');
    if (cookieHeader) {
      const cookieValue = parseCookieValue(cookieHeader, serverConfig.session.cookieName);
      if (cookieValue) {
        const payload = validateSessionCookie(cookieValue, getKeyMap());
        if (payload) {
          log('debug', 'Using token from session cookie (fast path)');
          return { jwt: payload.token, source: 'cookie' };
        }
        log('debug', 'Session cookie present but invalid');
      }
    }
  }

  // 3. OAuth2 Proxy header (auth path)
  const accessToken = req.headers.get('X-Auth-Request-Access-Token');
  if (accessToken) {
    log('debug', 'Using access token from X-Auth-Request-Access-Token header');
    return { jwt: accessToken, source: 'header' };
  }

  log('warn', 'No JWT token found in request');
  return null;
}

/**
 * Backward-compatible extractJWT for existing handlers.
 */
export function extractJWT(req: Request): string | null {
  const auth = extractAuth(req);
  return auth?.jwt ?? null;
}

/**
 * Build Set-Cookie header based on token source.
 * - From header (first auth): create new cookie
 * - From cookie (fast path): refresh cookie (sliding expiration)
 * - From dev: no cookie
 * Returns null if no cookie should be set.
 */
export function getSessionCookieHeader(jwt: string, source: TokenSource): string | null {
  if (!serverConfig.session.enabled || source === 'dev') return null;

  if (source === 'header' || source === 'cookie') {
    const cookieValue = createSessionCookie(jwt, getKeyMap(), serverConfig.session);
    if (!cookieValue) return null;
    return buildSetCookieHeader(cookieValue, serverConfig.session);
  }

  return null;
}

export { decodeJWTPayload } from '../jwt';
