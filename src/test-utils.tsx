/* eslint-disable react-refresh/only-export-components */
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Workspace } from './types';
import { OWNER_ANNOTATION } from './utils/workspace';
import { NamespaceProvider, namespaceKeys } from './context/NamespaceContext';

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
  // Seeds the active namespace so namespaced hooks resolve without a network bootstrap.
  namespace?: string;
}

export function TestProviders({
  children,
  queryClient = makeQueryClient(),
  initialEntries = ['/'],
  namespace = 'default',
}: TestProvidersOptions & { children: ReactNode }) {
  // Pre-seed the cheap bootstrap query so NamespaceProvider resolves activeNamespace
  // synchronously (no fetch to /api/v1/my-namespace in unit tests).
  queryClient.setQueryData(namespaceKeys.active, { active: namespace });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <NamespaceProvider>{children}</NamespaceProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function makeWorkspace(overrides?: Partial<Workspace> & { owner?: string; name?: string }): Workspace {
  const name = overrides?.name ?? 'test-ws';
  const annotations: Record<string, string> = {};
  if (overrides?.owner) {
    annotations[OWNER_ANNOTATION] = overrides.owner;
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
