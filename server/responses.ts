import { log } from './logger';

// --- JSON Response Helpers ---

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
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
  log('error', fallbackMessage, err.message || error);

  const mapped = err.statusCode ? K8S_STATUS_MAP.get(err.statusCode) : undefined;
  if (mapped) {
    return errorResponse(mapped.status, mapped.message);
  }

  return errorResponse(500, fallbackMessage, err.message);
}

// --- Input Validation ---

// K8s resource names: lowercase alphanumeric, hyphens, 1-253 chars
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

export function isValidK8sName(name: unknown): name is string {
  return typeof name === 'string' && K8S_NAME_RE.test(name);
}
