/* eslint-disable react-refresh/only-export-components */
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Workspace } from './types';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export interface TestProvidersOptions {
  queryClient?: QueryClient;
  initialEntries?: string[];
}

export function TestProviders({ children, queryClient = makeQueryClient(), initialEntries = ['/'] }: TestProvidersOptions & { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

export function makeWorkspace(overrides?: Partial<Workspace> & { owner?: string; name?: string }): Workspace {
  const name = overrides?.name ?? 'test-ws';
  const annotations: Record<string, string> = {};
  if (overrides?.owner) {
    annotations['workspace.jupyter.org/created-by'] = overrides.owner;
  }

  return {
    metadata: {
      name,
      namespace: 'default',
      annotations,
      creationTimestamp: '2024-01-01T00:00:00Z',
      ...overrides?.metadata,
    },
    spec: {
      displayName: 'Test WS',
      image: 'jupyter/minimal',
      desiredStatus: 'Running',
      accessType: 'Public',
      ownershipType: 'OwnerOnly',
      resources: { limits: { cpu: '2', memory: '4Gi' } },
      ...overrides?.spec,
    },
    status: overrides?.status ?? {
      accessURL: 'https://ws.example.com',
      conditions: [{ type: 'Available', status: 'True', reason: 'Ready', message: '' }],
    },
  } as Workspace;
}
