import { serverConfig } from './k8s';
import { log } from './logger';

/**
 * Extract JWT token from an incoming request.
 *
 * Resolution order:
 * 1. DEV_ACCESS_TOKEN env var (development only)
 * 2. X-Auth-Request-Access-Token header (OAuth2 Proxy)
 */
export function extractJWT(req: Request): string | null {
  if (process.env.NODE_ENV === 'development' && serverConfig.devAccessToken) {
    return serverConfig.devAccessToken;
  }

  const accessToken = req.headers.get('X-Auth-Request-Access-Token');
  if (accessToken) {
    log('debug', 'Using access token from X-Auth-Request-Access-Token header');
    return accessToken;
  }

  log('warn', 'No JWT token found in request');
  return null;
}

/**
 * Decode a JWT payload without verification (for /me endpoint).
 * Returns null if the token is malformed.
 */
export function decodeJWTPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
