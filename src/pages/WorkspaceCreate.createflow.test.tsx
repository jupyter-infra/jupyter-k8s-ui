import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StrictMode } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import type { AdvancedWorkspacePayload } from '../types';

// Capture what the advanced create path actually sends to the API.
const createSpy = mock(async (): Promise<unknown> => ({}));
// validateWorkspace normally turns HTTP errors into a result; here we make the request
// itself throw (server unreachable) to exercise handleValidate's catch.
const validateSpy = mock(async (): Promise<unknown> => ({ valid: true }));

mock.module('../api/client', () => ({
  apiClient: {
    listWorkspaces: mock(async () => []),
    listTemplates: mock(async () => ({ items: [], access: { user: 'ok', shared: 'ok' } })),
    getCrdSchema: mock(async () => ({ type: 'object', required: ['displayName'], properties: {} })),
    createWorkspaceAdvanced: createSpy,
    validateWorkspace: validateSpy,
  },
}));

mock.module('../components/workspace/yaml-editor/YamlEditor', () => ({
  YamlEditor: ({ value }: { value: string }) => <textarea data-testid="yaml-editor" value={value} readOnly />,
}));

const { WorkspaceCreate } = await import('./WorkspaceCreate');

// Stub only the global fetch AuthContext uses (`/api/v1/me`) rather than mocking the
// AuthContext module — bun's mock.module is process-global, and clobbering AuthContext
// leaks into AuthContext.test. This keeps the real provider and only fakes the network.
const realFetch = globalThis.fetch;

function renderCreate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/create']}>
            <WorkspaceCreate />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe('create via inline YAML toggle', () => {
  beforeEach(() => {
    cleanup();
    createSpy.mockClear();
    validateSpy.mockClear();
    validateSpy.mockResolvedValue({ valid: true });
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ authenticated: true, username: 'alice' }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('sends the typed displayName in the advanced payload spec', async () => {
    renderCreate();

    // Set a display name on the simple form, then flip to the YAML editor (fields are
    // shared above both views).
    const dnField = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    fireEvent.change(dnField, { target: { value: 'Alice Dev Box' } });

    fireEvent.click(screen.getByRole('button', { name: /^yaml editor$/i }));
    await screen.findByTestId('yaml-editor');

    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const payload = createSpy.mock.calls[0][0] as unknown as AdvancedWorkspacePayload;
    expect(payload.spec.displayName).toBe('Alice Dev Box');
  });

  test('Validate surfaces a message when the request itself throws (server unreachable)', async () => {
    validateSpy.mockRejectedValue(new Error('Failed to fetch'));
    renderCreate();

    fireEvent.click(screen.getByRole('button', { name: /^yaml editor$/i }));
    await screen.findByTestId('yaml-editor');

    fireEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    // The thrown error is caught and rendered in the status panel, not swallowed.
    expect(await screen.findByText(/failed to fetch/i)).toBeDefined();
  });
});
