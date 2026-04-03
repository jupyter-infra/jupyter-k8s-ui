import type { Workspace, WorkspaceTemplate, CreateWorkspaceRequest, UpdateWorkspaceRequest } from '../types';
import { handleUnauthorized, clearAuthReloadFlag } from './auth-interceptor';

const API_BASE = '/api/v1';

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
      }
      const error = await response.text();
      throw new Error(error || `Request failed: ${response.status}`);
    }

    clearAuthReloadFlag();
    return response.json();
  }

  listWorkspaces = () => this.request<Workspace[]>('/workspaces');

  listTemplates = () => this.request<WorkspaceTemplate[]>('/templates');

  getWorkspace = (name: string) => this.request<Workspace>(`/workspaces/${name}`);

  createWorkspace = (data: CreateWorkspaceRequest) => this.request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(data) });

  updateWorkspace = (name: string, data: UpdateWorkspaceRequest) =>
    this.request<Workspace>(`/workspaces/${name}`, { method: 'PUT', body: JSON.stringify(data) });

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
}

export const apiClient = new ApiClient();
