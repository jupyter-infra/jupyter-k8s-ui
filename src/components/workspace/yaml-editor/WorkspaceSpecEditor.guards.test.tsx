import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StrictMode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../../context/AuthContext';
import { OWNER_ANNOTATION } from '../../../utils/workspace';
import type { Workspace } from '../../../types';

// Edit-page render guards (owner + Stopped) and the load-error card. Uses real hooks +
// AuthProvider (user = alice); only the network layer is stubbed. `current` is the
// workspace getWorkspace returns, or a thrown error, set per test.
let current: { ws?: Workspace; err?: Error } = {};

function ws(overrides: Partial<Workspace['spec']> & { owner?: string } = {}): Workspace {
  const { owner = 'alice', ...spec } = overrides;
  return {
    metadata: { name: 'my-ws', namespace: 'default', annotations: { [OWNER_ANNOTATION]: owner }, creationTimestamp: '' },
    spec: { displayName: 'My Cool WS', desiredStatus: 'Stopped', image: 'nginx:latest', ...spec },
    status: undefined,
  } as Workspace;
}

mock.module('../../../api/client', () => ({
  apiClient: {
    getWorkspace: mock(async () => {
      if (current.err) throw current.err;
      return current.ws;
    }),
    listTemplates: mock(async () => ({ items: [], access: { user: 'ok', shared: 'ok' } })),
    getCrdSchema: mock(async () => ({ type: 'object', required: ['displayName'], properties: {} })),
  },
}));

mock.module('./YamlEditor', () => ({
  YamlEditor: ({ value }: { value: string }) => <textarea data-testid="yaml-editor" value={value} readOnly />,
}));

const { WorkspaceAdvancedEditor } = await import('../../../pages/WorkspaceAdvancedEditor');

const realFetch = globalThis.fetch;

function renderEditPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
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
    </StrictMode>,
  );
}

describe('WorkspaceSpecEditor edit-page guards', () => {
  beforeEach(() => {
    cleanup();
    current = {};
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ authenticated: true, username: 'alice' }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('shows an error card (not the editor) when the workspace fails to load', async () => {
    current = { err: new Error('Workspace not found') };
    renderEditPage();
    expect(await screen.findByText(/workspace not found/i)).toBeDefined();
    // The editor must not render behind the error.
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
  });

  test('blocks editing a Running workspace with an explanatory notice', async () => {
    current = { ws: ws({ desiredStatus: 'Running' }) };
    renderEditPage();
    expect(await screen.findByText(/stop the workspace before editing/i)).toBeDefined();
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
  });

  test('blocks editing a workspace owned by someone else', async () => {
    current = { ws: ws({ owner: 'bob' }) };
    renderEditPage();
    expect(await screen.findByText(/only the workspace owner can edit/i)).toBeDefined();
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
  });

  test('renders the editor for an owned, Stopped workspace', async () => {
    current = { ws: ws() };
    renderEditPage();
    const field = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('My Cool WS'));
  });
});
