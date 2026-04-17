import { describe, expect, test } from 'bun:test';
import { workspaceToResponse, templateToResponse } from '../k8s';
import type { K8sWorkspace, K8sWorkspaceTemplate } from '../types';

describe('workspaceToResponse', () => {
  test('passes through all fields when workspace is fully populated', () => {
    const ws: K8sWorkspace = {
      apiVersion: 'workspace.jupyter.org/v1alpha1',
      kind: 'Workspace',
      metadata: {
        name: 'my-ws',
        namespace: 'default',
        annotations: { 'workspace.jupyter.org/created-by': 'alice' },
        creationTimestamp: '2024-01-01T00:00:00Z',
      },
      spec: { displayName: 'My WS', image: 'jupyter:latest', desiredStatus: 'Running' },
      status: {
        accessURL: 'https://ws.example.com',
        conditions: [{ type: 'Available', status: 'True', reason: 'Ready', message: 'ok' }],
      },
    };
    const res = workspaceToResponse(ws);
    expect(res).toEqual({
      metadata: {
        name: 'my-ws',
        namespace: 'default',
        annotations: { 'workspace.jupyter.org/created-by': 'alice' },
        creationTimestamp: '2024-01-01T00:00:00Z',
      },
      spec: ws.spec,
      status: {
        accessURL: 'https://ws.example.com',
        conditions: [{ type: 'Available', status: 'True', reason: 'Ready', message: 'ok' }],
      },
    });
  });

  // Defensive defaults matter: the frontend calls .map on conditions and reads
  // annotations as a dict. undefined → TypeError.
  test('defaults missing metadata/status fields so frontend never sees undefined', () => {
    const ws = {
      apiVersion: 'workspace.jupyter.org/v1alpha1',
      kind: 'Workspace',
      metadata: {},
      spec: {},
      status: { conditions: [{ type: 'Available', status: 'True' }] },
    } as unknown as K8sWorkspace;
    const res = workspaceToResponse(ws);
    expect(res.metadata).toEqual({ name: '', namespace: '', annotations: {}, creationTimestamp: '' });
    expect(res.status?.accessURL).toBe('');
    expect(res.status?.conditions[0]).toEqual({ type: 'Available', status: 'True', reason: '', message: '' });
  });

  test('omits status when workspace has none', () => {
    const ws: K8sWorkspace = {
      apiVersion: 'workspace.jupyter.org/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'x', namespace: 'y' },
      spec: {},
    };
    expect(workspaceToResponse(ws).status).toBeUndefined();
  });
});

describe('templateToResponse', () => {
  test('passes through metadata and spec', () => {
    const tmpl: K8sWorkspaceTemplate = {
      apiVersion: 'workspace.jupyter.org/v1alpha1',
      kind: 'WorkspaceTemplate',
      metadata: { name: 'gpu', namespace: 'jupyter' },
      spec: { displayName: 'GPU', defaultImage: 'jupyter:scipy' },
    };
    const res = templateToResponse(tmpl);
    expect(res.metadata).toEqual({ name: 'gpu', namespace: 'jupyter' });
    expect(res.spec).toEqual({ displayName: 'GPU', defaultImage: 'jupyter:scipy' });
  });

  test('defaults missing metadata to empty strings', () => {
    const tmpl = {
      apiVersion: 'workspace.jupyter.org/v1alpha1',
      kind: 'WorkspaceTemplate',
      metadata: {},
      spec: {},
    } as unknown as K8sWorkspaceTemplate;
    const res = templateToResponse(tmpl);
    expect(res.metadata).toEqual({ name: '', namespace: '' });
  });
});
