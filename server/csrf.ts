import { serverConfig } from './k8s';
import { log } from './logger';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Validate CSRF for mutation requests.
 * Checks Origin or Referer header matches expected domain.
 * Returns true if request is safe (GET/HEAD/OPTIONS or origin matches).
 */
export function validateCSRF(req: Request): boolean {
  if (!MUTATION_METHODS.has(req.method)) return true;

  const expectedDomain = serverConfig.session.expectedDomain;
  if (!expectedDomain) return true;

  const origin = req.headers.get('Origin');
  const referer = req.headers.get('Referer');

  const source = origin || referer;
  if (!source) {
    log('warn', 'CSRF check failed: no Origin or Referer header on mutation request');
    return false;
  }

  try {
    const url = new URL(source);
    if (url.hostname === expectedDomain && url.protocol === 'https:') return true;
  } catch {
    // Invalid URL
  }

  log('warn', `CSRF check failed: ${source} does not match expected domain ${expectedDomain}`);
  return false;
}
