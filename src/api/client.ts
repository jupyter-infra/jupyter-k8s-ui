import type {
  Workspace,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  ClusterAccessInfo,
  AdvancedWorkspacePayload,
  DiscoveryResponse,
  DiscoveredTemplate,
  DiscoveredAccessStrategy,
} from '../types';
import { handleUnauthorized, clearAuthReloadFlag, AuthError, ApiError } from './auth-interceptor';

const API_BASE = '/api/v1';

// JSON Schema handed to monaco-yaml — opaque to us, just forwarded to the language
// service. `unknown`-keyed to avoid pretending we know its internal shape.
export type CrdSpecSchema = Record<string, unknown>;

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options?.headers) {
      Object.assign(headers, options.headers as Record<string, string>);
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: 'include',
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        handleUnauthorized();
        const error = await response.text();
        throw new AuthError(error || 'Unauthorized');
      }
      // The server sends a structured `{ error, details }` body (see server/responses.ts).
      // Parse it so callers get a friendly message plus the per-field webhook `details`,
      // rather than a raw JSON blob as the error message.
      const raw = await response.text();
      let message = raw;
      let details: string | undefined;
      try {
        const body = JSON.parse(raw) as { error?: string; details?: string };
        message = body.error ?? raw;
        details = body.details;
      } catch {
        // Non-JSON body — fall back to the raw text as the message.
      }
      throw new ApiError(message || `Request failed: ${response.status}`, response.status, details);
    }

    clearAuthReloadFlag();
    return response.json();
  }

  listWorkspaces = () => this.request<Workspace[]>('/workspaces');

  listTemplates = () => this.request<DiscoveryResponse<DiscoveredTemplate>>('/templates');

  listAccessStrategies = () => this.request<DiscoveryResponse<DiscoveredAccessStrategy>>('/access-strategies');

  getWorkspace = (name: string) => this.request<Workspace>(`/workspaces/${name}`);

  createWorkspace = (data: CreateWorkspaceRequest) => this.request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(data) });

  // Field-shaped selective update: the server reads the live spec and overlays only the
  // fields present in the body (`if (body.x !== undefined) spec.x = body.x`), so untouched
  // fields — including stored requests — survive. Used by the simple-edit page. PATCH is
  // the appropriate verb for a partial update; the overlay is driven by the body shape,
  // not the verb (the raw-spec advanced editor uses PUT for a full-spec replace).
  updateWorkspace = (name: string, data: UpdateWorkspaceRequest) =>
    this.request<Workspace>(`/workspaces/${name}`, { method: 'PATCH', body: JSON.stringify(data) });

  deleteWorkspace = (name: string) => this.request<void>(`/workspaces/${name}`, { method: 'DELETE' });

  startWorkspace = (name: string) =>
    this.request<Workspace>(`/workspaces/${name}`, {
      method: 'PATCH',
      body: JSON.stringify({ desiredStatus: 'Running' }),
    });

  stopWorkspace = (name: string) =>
    this.request<Workspace>(`/workspaces/${name}`, {
      method: 'PATCH',
      body: JSON.stringify({ desiredStatus: 'Stopped' }),
    });

  getClusterAccess = () => this.request<ClusterAccessInfo>('/cluster-access');

  // --- Advanced YAML editor ---

  getCrdSchema = (crd: string) => this.request<CrdSpecSchema>(`/crd-schema/${crd}`);

  // Raw create/replace: the advanced editor owns the whole spec (WYSIWYG full-spec
  // replace). Distinct from the simple form's field-shaped create/update.
  createWorkspaceAdvanced = (data: AdvancedWorkspacePayload) => this.request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(data) });

  replaceWorkspaceAdvanced = (name: string, data: AdvancedWorkspacePayload) =>
    this.request<Workspace>(`/workspaces/${name}`, { method: 'PUT', body: JSON.stringify(data) });

  // Dry-run validate against the cluster. A 422/409/403 is an EXPECTED outcome here,
  // not an exception — return a structured result so the editor can render the
  // webhook's message. Only 401 still throws (handled by the interceptor).
  validateWorkspace = async (data: AdvancedWorkspacePayload, mode: 'create' | 'edit'): Promise<ValidationResult> => {
    const path = mode === 'edit' ? `/workspaces/${data.name}?dryRun=All` : `/workspaces?dryRun=All`;
    const method = mode === 'edit' ? 'PUT' : 'POST';
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (response.status === 401) {
      handleUnauthorized();
      throw new AuthError((await response.text()) || 'Unauthorized');
    }

    clearAuthReloadFlag();
    if (response.ok) {
      return { valid: true };
    }
    const body = await response.json().catch(() => ({}) as Record<string, unknown>);
    const message = (body as { error?: string; details?: string }).error ?? `Validation failed (${response.status})`;
    const details = (body as { details?: string }).details;
    return { valid: false, status: response.status, message, details };
  };
}

export interface ValidationResult {
  valid: boolean;
  status?: number;
  message?: string;
  details?: string;
}

export const apiClient = new ApiClient();
