import { log } from './logger';

// --- Security Headers ---

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// --- JSON Response Helpers ---

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS },
  });
}

export function errorResponse(status: number, message: string, details?: string): Response {
  return jsonResponse({ error: message, details }, status);
}

// --- K8s Error Mapping ---

// Open/Closed: add new status codes by extending the map, not modifying a switch.
const K8S_STATUS_MAP: ReadonlyMap<number, { status: number; message: string }> = new Map([
  [401, { status: 401, message: 'Unauthorized — invalid or expired token' }],
  [403, { status: 403, message: 'Forbidden — insufficient permissions' }],
  [404, { status: 404, message: 'Resource not found' }],
  [409, { status: 409, message: 'Resource already exists' }],
  [422, { status: 422, message: 'Unprocessable entity — validation failed' }],
]);

interface K8sError {
  statusCode?: number;
  message?: string;
}

export function handleK8sError(error: unknown, fallbackMessage: string): Response {
  const err = error as K8sError;
  const body = (error as { body?: unknown })?.body;
  log('error', fallbackMessage, err.message || error, ...(body ? [JSON.stringify(body)] : []));

  const mapped = err.statusCode ? K8S_STATUS_MAP.get(err.statusCode) : undefined;
  if (mapped) {
    return errorResponse(mapped.status, mapped.message);
  }

  return errorResponse(500, fallbackMessage, err.message);
}
