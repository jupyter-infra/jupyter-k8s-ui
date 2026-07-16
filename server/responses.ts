import { log } from './logger';

// --- Security Headers ---

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'self'",
    // Monaco's language services (incl. monaco-yaml's YAML worker) instantiate web
    // workers from blob: URLs — that's baked into Monaco's worker loader, not a Vite
    // choice. `worker-src` scopes this to workers only; the blob content is still our
    // own bundled, same-origin script, so script-src stays 'self' with no blob:.
    "worker-src 'self' blob:",
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

// The K8s API server returns a metav1.Status body on errors. For validation (422)
// and admission-webhook rejections, `message` carries the human-readable reason
// (e.g. "image X not permitted by template gpu-small") and `details.causes[]` the
// per-field breakdown. The advanced editor's dry-run validation depends on surfacing
// this verbatim — the generic mapped status string alone is useless there.
interface K8sStatusBody {
  message?: string;
  reason?: string;
  details?: {
    causes?: Array<{ field?: string; message?: string; reason?: string }>;
  };
}

function extractK8sStatusBody(error: unknown): K8sStatusBody | undefined {
  const raw = (error as { body?: unknown })?.body;
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as K8sStatusBody;
    } catch {
      return { message: raw };
    }
  }
  if (typeof raw === 'object') return raw as K8sStatusBody;
  return undefined;
}

/**
 * Format the K8s Status body into a readable `details` string: the top-level message,
 * plus any per-field causes. Returns undefined when there's nothing useful to add.
 */
function formatK8sDetails(body: K8sStatusBody | undefined): string | undefined {
  if (!body) return undefined;
  const parts: string[] = [];
  if (body.message) parts.push(body.message);
  for (const cause of body.details?.causes ?? []) {
    const field = cause.field ? `${cause.field}: ` : '';
    if (cause.message) parts.push(`${field}${cause.message}`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function handleK8sError(error: unknown, fallbackMessage: string): Response {
  const err = error as K8sError;
  const statusBody = extractK8sStatusBody(error);
  log('error', fallbackMessage, err.message || error, ...(statusBody ? [JSON.stringify(statusBody)] : []));

  const details = formatK8sDetails(statusBody);
  const mapped = err.statusCode ? K8S_STATUS_MAP.get(err.statusCode) : undefined;
  if (mapped) {
    // Surface the webhook/API-server message as `details` alongside the mapped
    // human-friendly `error`. Existing consumers ignore `details`; the advanced
    // editor renders it.
    return errorResponse(mapped.status, mapped.message, details);
  }

  return errorResponse(500, fallbackMessage, details ?? err.message);
}
