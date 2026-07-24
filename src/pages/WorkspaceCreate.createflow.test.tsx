import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StrictMode } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import type { AdvancedWorkspacePayload, CreateWorkspaceRequest, DiscoveredTemplate, DiscoveryResponse } from '../types';

// Capture what the advanced create path actually sends to the API.
const createSpy = mock(async (): Promise<unknown> => ({}));
// The simple create path goes through createWorkspace (not ...Advanced).
const createSimpleSpy = mock(async (): Promise<unknown> => ({}));
// validateWorkspace normally turns HTTP errors into a result; here we make the request
// itself throw (server unreachable) to exercise handleValidate's catch.
const validateSpy = mock(async (): Promise<unknown> => ({ valid: true }));

// Mutable templates response so individual tests can supply fixtures.
let templatesResponse: DiscoveryResponse<DiscoveredTemplate> = {
  items: [],
  access: { user: 'ok', shared: 'ok' },
  namespaces: { own: 'user-ns', shared: 'shared-ns' },
};

mock.module('../api/client', () => ({
  apiClient: {
    listWorkspaces: mock(async () => []),
    listTemplates: mock(async () => templatesResponse),
    getCrdSchema: mock(async () => ({ type: 'object', required: ['displayName'], properties: {} })),
    createWorkspace: createSimpleSpy,
    createWorkspaceAdvanced: createSpy,
    validateWorkspace: validateSpy,
  },
}));

function tmplFixture(overrides: Partial<DiscoveredTemplate['spec']>, name = 'eks-oidc', sourceNamespace = 'shared-ns'): DiscoveredTemplate {
  return {
    metadata: { name, namespace: sourceNamespace },
    spec: { displayName: name, ...overrides },
    sourceNamespace,
  };
}

mock.module('../components/workspace/yaml-editor/YamlEditor', () => ({
  YamlEditor: ({ value }: { value: string }) => <textarea data-testid="yaml-editor" value={value} readOnly />,
}));

const { WorkspaceCreate } = await import('./WorkspaceCreate');

// Drain pending async state updates (React Query results settling, the post-submit
// navigate()/isPending flip) inside act(), so a trailing update from a finished test doesn't
// land during the next test's teardown and trip React's "not wrapped in act(...)" warning.
// Drains a macrotask (not just a microtask) since those resolutions chain across ticks.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

// Stub only the global fetch AuthContext uses (`/api/v1/me`) rather than mocking the
// AuthContext module — bun's mock.module is process-global, and clobbering AuthContext
// leaks into AuthContext.test. This keeps the real provider and only fakes the network.
const realFetch = globalThis.fetch;

async function renderCreate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let result!: ReturnType<typeof render>;
  // Render AND settle the initial async effects (auth /me fetch, templates query, the
  // resulting picker auto-select + MUI InputBase mount effects) inside one act(), so none
  // of those first-mount updates land outside act and trip the warning.
  await act(async () => {
    result = render(
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
    await new Promise((r) => setTimeout(r, 0));
  });
  return result;
}

describe('create via inline YAML toggle', () => {
  beforeEach(() => {
    createSpy.mockClear();
    createSimpleSpy.mockClear();
    validateSpy.mockClear();
    validateSpy.mockResolvedValue({ valid: true });
    templatesResponse = { items: [], access: { user: 'ok', shared: 'ok' }, namespaces: { own: 'user-ns', shared: 'shared-ns' } };
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ authenticated: true, username: 'alice' }), { status: 200 })) as typeof fetch;
  });
  // Flush inside act BEFORE the synchronous cleanup(), so any trailing update from the
  // just-finished test (e.g. MUI InputBase's mount effect) is applied under act rather than
  // landing during the next test's unmount and tripping the act warning.
  afterEach(async () => {
    await flush();
    cleanup();
    globalThis.fetch = realFetch;
  });

  test('sends the typed displayName in the advanced payload spec', async () => {
    await renderCreate();

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
    await renderCreate();

    fireEvent.click(screen.getByRole('button', { name: /^yaml editor$/i }));
    await screen.findByTestId('yaml-editor');

    fireEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    // The thrown error is caught and rendered in the status panel, not swallowed.
    expect(await screen.findByText(/failed to fetch/i)).toBeDefined();
  });
});

describe('template-aware simple create', () => {
  beforeEach(() => {
    createSpy.mockClear();
    createSimpleSpy.mockClear();
    templatesResponse = { items: [], access: { user: 'ok', shared: 'ok' }, namespaces: { own: 'user-ns', shared: 'shared-ns' } };
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ authenticated: true, username: 'alice' }), { status: 200 })) as typeof fetch;
  });
  // See the note above: flush under act before cleanup so trailing updates don't leak.
  afterEach(async () => {
    await flush();
    cleanup();
    globalThis.fetch = realFetch;
  });

  const submit = () => fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));
  const lastSimplePayload = () => createSimpleSpy.mock.calls.at(-1)![0] as unknown as CreateWorkspaceRequest;

  test('no-template create sends WYSIWYG static defaults, no templateRef, ownership OwnerOnly', async () => {
    await renderCreate();
    await screen.findByText(/^resources$/i);
    // No template + empty image = unstartable → submit is blocked. Type an image so the
    // workspace has something to run (mirrors the real no-template flow).
    fireEvent.change(screen.getByRole('combobox', { name: /image/i }), { target: { value: 'nginx:latest' } });
    submit();

    await waitFor(() => expect(createSimpleSpy).toHaveBeenCalledTimes(1));
    const p = lastSimplePayload();
    expect(p.templateRef).toBeUndefined();
    expect(p.image).toBe('nginx:latest');
    expect(p.ownershipType).toBe('OwnerOnly'); // not driven by the Public default toggle
    expect(p.accessType).toBe('Public');
    // STATIC_DEFAULTS: cpu 1 / memory 2Gi / storage 10Gi, complete resources block.
    expect(p.resources?.limits).toEqual({ cpu: '1', memory: '2Gi' });
    expect(p.resources?.requests).toBeDefined();
    expect(p.storage).toEqual({ size: '10Gi' });
    expect(p.idleShutdown).toBeUndefined(); // no template → no idle
  });

  test('no template + empty image blocks submit (unstartable workspace)', async () => {
    await renderCreate();
    await screen.findByText(/^resources$/i);
    // Empty image, no template → the Create button is disabled and submit sends nothing.
    expect((screen.getByRole('button', { name: /create workspace/i }) as HTMLButtonElement).disabled).toBe(true);
    submit();
    await flush();
    expect(createSimpleSpy).not.toHaveBeenCalled();
  });

  test('selecting a template reshapes the payload to the template default + carries templateRef', async () => {
    templatesResponse = {
      items: [tmplFixture({ resourceBounds: { resources: { cpu: { min: '2', max: '4' } } }, defaultResources: { limits: { cpu: '2' } } })],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderCreate();
    // 1 template, not flagged default → grid shows it + no-template, preselect no-template.
    const card = await screen.findByRole('button', { name: /select eks-oidc template/i });
    fireEvent.click(card);
    submit();

    await waitFor(() => expect(createSimpleSpy).toHaveBeenCalledTimes(1));
    const p = lastSimplePayload();
    expect(p.templateRef).toEqual({ name: 'eks-oidc', namespace: 'shared-ns' });
    expect(p.resources?.limits?.cpu).toBe('2'); // template default limit
  });

  test('access toggle drives accessType only; ownership stays the template default', async () => {
    templatesResponse = {
      items: [tmplFixture({ defaultAccessType: 'Public', defaultOwnershipType: 'OwnerOnly' }, 'only-tmpl')],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderCreate();
    fireEvent.click(await screen.findByRole('button', { name: /select only-tmpl template/i }));

    // Flip access to Private.
    fireEvent.click(screen.getByRole('button', { name: /^private$/i }));
    submit();

    await waitFor(() => expect(createSimpleSpy).toHaveBeenCalledTimes(1));
    const p = lastSimplePayload();
    expect(p.accessType).toBe('OwnerOnly'); // toggle → accessType
    expect(p.ownershipType).toBe('OwnerOnly'); // template default, NOT driven by the toggle
  });

  test('idle-enabled template create sends a complete idleShutdown block echoing detection', async () => {
    const detection = { httpGet: { port: 8888 } };
    templatesResponse = {
      items: [
        tmplFixture(
          {
            defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30, detection },
            idleShutdownOverrides: { allow: true, minIdleTimeoutInMinutes: 5, maxIdleTimeoutInMinutes: 120 },
          },
          'idle-tmpl',
        ),
      ],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderCreate();
    fireEvent.click(await screen.findByRole('button', { name: /select idle-tmpl template/i }));
    submit();

    await waitFor(() => expect(createSimpleSpy).toHaveBeenCalledTimes(1));
    const p = lastSimplePayload();
    expect(p.idleShutdown).toEqual({ enabled: true, timeoutInMinutes: 30, detection });
  });

  test('disabling an enabled-by-default idle template sends an explicit {enabled:false} block', async () => {
    // Toggling idle OFF must send an explicit disabled block, NOT omit idleShutdown —
    // omitting it lets the operator's defaulter copy the template's enabled default back on,
    // re-enabling idle against the user's choice.
    const detection = { httpGet: { port: 8888 } };
    templatesResponse = {
      items: [
        tmplFixture(
          {
            defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30, detection },
            idleShutdownOverrides: { allow: true, minIdleTimeoutInMinutes: 5, maxIdleTimeoutInMinutes: 120 },
          },
          'idle-tmpl',
        ),
      ],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderCreate();
    fireEvent.click(await screen.findByRole('button', { name: /select idle-tmpl template/i }));
    // Toggle idle off (default is enabled for this template).
    fireEvent.click(await screen.findByRole('checkbox', { name: /idle/i }));
    submit();

    await waitFor(() => expect(createSimpleSpy).toHaveBeenCalledTimes(1));
    const p = lastSimplePayload();
    expect(p.idleShutdown).toEqual({ enabled: false, timeoutInMinutes: 30, detection });
  });

  test('a flagged default template is auto-selected and suppresses the no-template card', async () => {
    templatesResponse = {
      items: [tmplFixture({ defaultResources: { limits: { cpu: '2' } }, resourceBounds: { resources: { cpu: { min: '1', max: '4' } } } }, 'default-tmpl')].map(
        (t) => ({ ...t, metadata: { ...t.metadata, labels: { 'workspace.jupyter.org/default-template': 'true' } } }),
      ),
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'shared-ns', shared: 'shared-ns' },
    };
    await renderCreate();
    // Wait until the default template is adopted — its cpu default (2) replaces the static
    // default (1), which is the observable signal that auto-selection propagated.
    await screen.findByText(/2 cores/i);
    // 1 flagged default → picker renders nothing; no "No template" card.
    expect(screen.queryByRole('button', { name: /select No template/i })).toBeNull();
    submit();

    await waitFor(() => expect(createSimpleSpy).toHaveBeenCalledTimes(1));
    // Auto-selected default template rides on the payload.
    expect(lastSimplePayload().templateRef).toEqual({ name: 'default-tmpl', namespace: 'shared-ns' });
  });
});
