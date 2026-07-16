import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { StrictMode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Workspace } from '../../../types';

// Faithful reproduction of the real edit flow: REAL React Query hooks + StrictMode
// (the app wraps in StrictMode) + real router params. Only the network layer
// (apiClient) is stubbed, so the query goes through the actual in-flight -> resolved
// lifecycle the component's seeding effect must handle.

const WS: Workspace = {
  metadata: { name: 'my-ws', namespace: 'default', annotations: {}, creationTimestamp: '' },
  spec: { displayName: 'My Cool WS', desiredStatus: 'Stopped', image: 'nginx:latest' },
  status: undefined,
} as Workspace;

mock.module('../../../api/client', () => ({
  apiClient: {
    getWorkspace: mock(async () => WS),
    listTemplates: mock(async () => ({ items: [], access: { user: 'ok', shared: 'ok' } })),
    getCrdSchema: mock(async () => ({ type: 'object', required: ['displayName'], properties: {} })),
  },
}));

// Stub the lazy Monaco editor (happy-dom can't run the worker).
mock.module('./YamlEditor', () => ({
  YamlEditor: ({ value }: { value: string }) => <textarea data-testid="yaml-editor" value={value} readOnly />,
}));

const { WorkspaceAdvancedEditor } = await import('../../../pages/WorkspaceAdvancedEditor');

function renderEditPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/workspace/my-ws/edit']}>
          <Routes>
            <Route path="/workspace/:name/edit" element={<WorkspaceAdvancedEditor />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe('edit flow — real hooks + StrictMode', () => {
  beforeEach(() => cleanup());

  test('Display name field is populated from the fetched spec', async () => {
    renderEditPage();
    const field = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('My Cool WS'));
  });

  test('Display name is populated when the detail query cache is already warm', async () => {
    // The real navigation is detail/card -> Edit, so useWorkspace(name) resolves from
    // cache and `existing` is present on the FIRST render. Prime the cache, then mount.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(['workspaces', 'my-ws'], WS);
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/workspace/my-ws/edit']}>
            <Routes>
              <Route path="/workspace/:name/edit" element={<WorkspaceAdvancedEditor />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    const field = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('My Cool WS'));
  });
});
