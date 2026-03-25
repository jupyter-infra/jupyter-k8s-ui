import type { Workspace, WorkspaceTemplate, CreateWorkspaceRequest } from '../types';

const API_BASE = '/api/v1';

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    // Prepare headers
    const headers: Record<string, string> = { 
      'Content-Type': 'application/json',
    };

    // Merge additional headers if provided
    if (options?.headers) {
      const additionalHeaders = options.headers as Record<string, string>;
      Object.assign(headers, additionalHeaders);
    }

    // In development, the backend reads DEV_ACCESS_TOKEN from .env
    // No need to send Authorization header from frontend

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: 'include', // For production oauth2-proxy cookies
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `Request failed: ${response.status}`);
    }

    return response.json();
  }

  listWorkspaces = () => this.request<Workspace[]>('/workspaces');

  listTemplates = () => this.request<WorkspaceTemplate[]>('/templates');

  getWorkspace = (name: string) => this.request<Workspace>(`/workspaces/${name}`);

  createWorkspace = (data: CreateWorkspaceRequest) =>
    this.request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(data) });

  deleteWorkspace = (name: string) =>
    this.request<void>(`/workspaces/${name}`, { method: 'DELETE' });

  startWorkspace = (name: string) =>
    this.request<Workspace>(`/workspaces/${name}`, { 
      method: 'PATCH', 
      body: JSON.stringify({ desiredStatus: 'Running' }) 
    });

  stopWorkspace = (name: string) =>
    this.request<Workspace>(`/workspaces/${name}`, { 
      method: 'PATCH', 
      body: JSON.stringify({ desiredStatus: 'Stopped' }) 
    });
}

export const apiClient = new ApiClient();
