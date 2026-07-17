import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StrictMode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../../context/AuthContext';
import { OWNER_ANNOTATION } from '../../../utils/workspace';
import type { Workspace } from '../../../types';

// Faithful reproduction of the real edit flow: REAL React Query hooks + StrictMode
// (the app wraps in StrictMode) + real router params + a real AuthProvider. Only the
// network layer (apiClient + the /me fetch) is stubbed, so the query goes through the
// actual in-flight -> resolved lifecycle the component's seeding effect must handle.

// Owner matches the mocked /me user, and status is Stopped, so the edit-page guard
// (owner + Stopped) passes and the editor renders.
const WS: Workspace = {
  metadata: { name: 'my-ws', namespace: 'default', annotations: { [OWNER_ANNOTATION]: 'alice' }, creationTimestamp: '' },
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

// AuthProvider fetches /api/v1/me; stub global fetch to report `alice` (the WS owner).
const realFetch = globalThis.fetch;

function editPageTree(client: QueryClient) {
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/workspace/my-ws/edit']}>
            <Routes>
              <Route path="/workspace/:name/edit" element={<WorkspaceAdvancedEditor />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

function renderEditPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(editPageTree(client));
}

describe('edit flow — real hooks + StrictMode', () => {
  beforeEach(() => {
    cleanup();
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ authenticated: true, username: 'alice' }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

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
    render(editPageTree(client));
    const field = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('My Cool WS'));
  });
});
