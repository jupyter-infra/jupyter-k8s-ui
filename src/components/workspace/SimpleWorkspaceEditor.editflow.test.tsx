import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveredTemplate, DiscoveryResponse, UpdateWorkspaceRequest, Workspace } from '../../types';
import { strings } from '../../constants';

const updateSpy = mock(async (): Promise<unknown> => ({}));
let templatesResponse: DiscoveryResponse<DiscoveredTemplate> = {
  items: [],
  access: { user: 'ok', shared: 'ok' },
  namespaces: { own: 'user-ns', shared: 'shared-ns' },
};

mock.module('../../api/client', () => ({
  apiClient: {
    listTemplates: mock(async () => templatesResponse),
    updateWorkspace: (name: string, data: UpdateWorkspaceRequest) => updateSpy(name, data),
  },
  ApiError: class ApiError extends Error {},
}));

const { SimpleWorkspaceEditor } = await import('./SimpleWorkspaceEditor');
const { AuthProvider } = await import('../../context/AuthContext');

const realFetch = globalThis.fetch;

// Drain pending async state updates (the auth /me fetch + templates query resolving into the
// template resolver/re-seed) inside act(), so a trailing update doesn't leak into the next
// test's teardown and trip React's "not wrapped in act(...)" warning.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function renderEditor(workspace: Workspace) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let result!: ReturnType<typeof render>;
  // Render AND settle the initial async effects (auth /me, templates query → template
  // resolution + re-seed) inside one act(), so first-mount updates don't land outside act.
  await act(async () => {
    result = render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/workspace/${workspace.metadata.name}/edit`]}>
            <SimpleWorkspaceEditor
              workspace={workspace}
              displayName={workspace.spec.displayName ?? workspace.metadata.name}
              onDisplayNameChange={() => {}}
              onSwitchToYaml={() => {}}
            />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return result;
}

function tmpl(spec: DiscoveredTemplate['spec'], name = 'eks-oidc', sourceNamespace = 'shared-ns'): DiscoveredTemplate {
  return { metadata: { name, namespace: sourceNamespace }, spec, sourceNamespace };
}

function baseWorkspace(overrides: Partial<Workspace['spec']> = {}): Workspace {
  return {
    metadata: { name: 'my-ws', namespace: 'user-ns', annotations: { 'workspace.jupyter.org/created-by': 'alice' } },
    spec: {
      displayName: 'My WS',
      image: 'jupyter:1',
      desiredStatus: 'Stopped',
      resources: { limits: { cpu: '2', memory: '4Gi' }, requests: { cpu: '500m', memory: '1Gi' } },
      storage: { size: '20Gi' },
      accessType: 'Public',
      ...overrides,
    },
  };
}

const lastPayload = () => updateSpy.mock.calls.at(-1)![1] as unknown as UpdateWorkspaceRequest;
const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

describe('SimpleWorkspaceEditor', () => {
  beforeEach(() => {
    updateSpy.mockClear();
    templatesResponse = { items: [], access: { user: 'ok', shared: 'ok' }, namespaces: { own: 'user-ns', shared: 'shared-ns' } };
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ authenticated: true, username: 'alice' }), { status: 200 })) as typeof fetch;
  });
  // Flush under act before the synchronous cleanup(), so trailing updates don't leak.
  afterEach(async () => {
    await flush();
    cleanup();
    globalThis.fetch = realFetch;
  });

  test('untouched save omits resources (preserves stored requests) and never sends desiredStatus', async () => {
    await renderEditor(baseWorkspace());
    await screen.findByText(/edit workspace|resources/i);
    save();

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const p = lastPayload();
    expect(p.resources).toBeUndefined(); // untouched → don't touch resources
    expect(p).not.toHaveProperty('desiredStatus'); // stay Stopped, no auto-start
    expect(p.displayName).toBe('My WS');
  });

  test('touching a CPU slider sends a complete resources block preserving the stored request', async () => {
    await renderEditor(baseWorkspace());
    await screen.findByText(/^resources$/i);
    // Move the CPU slider.
    const cpuSlider = screen.getByRole('slider', { name: /cpu/i });
    fireEvent.change(cpuSlider, { target: { value: '3' } });
    save();

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const p = lastPayload();
    expect(p.resources?.limits?.cpu).toBe('3');
    // Stored request (500m) preserved verbatim — NOT recomputed from the ratio.
    expect(p.resources?.requests?.cpu).toBe('500m');
    expect(p.resources?.requests?.memory).toBe('1Gi');
  });

  test('storage is read-only on edit (no storage slider, storage never in payload)', async () => {
    await renderEditor(baseWorkspace());
    await screen.findByText(/^resources$/i);
    // No storage slider is rendered (read-only display only).
    expect(screen.queryByRole('slider', { name: /storage/i })).toBeNull();
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(lastPayload()).not.toHaveProperty('storage');
  });

  test('re-sends the existing templateRef unchanged (template locked)', async () => {
    templatesResponse = {
      items: [tmpl({ displayName: 'EKS', resourceBounds: { resources: { cpu: { min: '1', max: '8' } } } })],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderEditor(baseWorkspace({ templateRef: { name: 'eks-oidc', namespace: 'shared-ns' } }));
    await screen.findByText(/^resources$/i);
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(lastPayload().templateRef).toEqual({ name: 'eks-oidc', namespace: 'shared-ns' });
  });

  test('conform-on-load clamps an over-max stored limit and shows the banner; conformed value is sent', async () => {
    // Template caps CPU at 4; workspace stored 6 → conform to 4 + banner + resources sent.
    templatesResponse = {
      items: [tmpl({ displayName: 'EKS', resourceBounds: { resources: { cpu: { min: '1', max: '4' } } }, defaultResources: { limits: { cpu: '2' } } })],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderEditor(
      baseWorkspace({
        templateRef: { name: 'eks-oidc', namespace: 'shared-ns' },
        resources: { limits: { cpu: '6', memory: '4Gi' }, requests: { cpu: '500m', memory: '1Gi' } },
      }),
    );
    // Banner enumerates the adjustment.
    expect(await screen.findByText(/adjusted to fit its template/i)).toBeDefined();
    expect(screen.getByText(/CPU reduced from 6 cores to 4 cores/i)).toBeDefined();

    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    // Drifted → resources sent, conformed to 4.
    expect(lastPayload().resources?.limits?.cpu).toBe('4');
  });

  test('unresolvable templateRef shows the not-accessible note and seeds from stored spec', async () => {
    // Ref set but not in the discoverable list → treat as unresolvable.
    await renderEditor(baseWorkspace({ templateRef: { name: 'ghost', namespace: 'other-ns' } }));
    expect(await screen.findByText(/template you can't access/i)).toBeDefined();
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    // Ref preserved on the payload even though unresolvable.
    expect(lastPayload().templateRef).toEqual({ name: 'ghost', namespace: 'other-ns' });
  });

  test('idle block on the workspace → idle controls render and echo detection on save', async () => {
    const detection = { httpGet: { port: 8888 } };
    templatesResponse = {
      items: [
        tmpl({
          displayName: 'EKS',
          defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30, detection },
          idleShutdownOverrides: { allow: true, minIdleTimeoutInMinutes: 5, maxIdleTimeoutInMinutes: 120 },
        }),
      ],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderEditor(
      baseWorkspace({
        templateRef: { name: 'eks-oidc', namespace: 'shared-ns' },
        idleShutdown: { enabled: true, idleTimeoutInMinutes: 60, detection },
      }),
    );
    await screen.findByText(/^resources$/i);
    // Touch nothing but idle is present → save should send the idle block echoing detection.
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(lastPayload().idleShutdown).toEqual({ enabled: true, timeoutInMinutes: 60, detection });
  });

  test('no stored idle block under an idle-capable template: toggle shows OFF, save authors a block from the template default', async () => {
    // A workspace with no idleShutdown block under an idle-capable template DOES show the
    // idle toggle (seeded OFF). Turning it on authors a complete block from the template's
    // default detection — the UI never invents detection itself.
    const detection = { httpGet: { port: 8888 } };
    templatesResponse = {
      items: [
        tmpl({
          displayName: 'EKS',
          defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30, detection },
          idleShutdownOverrides: { allow: true, minIdleTimeoutInMinutes: 5, maxIdleTimeoutInMinutes: 120 },
        }),
      ],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    // Workspace has NO idleShutdown block.
    await renderEditor(baseWorkspace({ templateRef: { name: 'eks-oidc', namespace: 'shared-ns' } }));
    await screen.findByText(/^resources$/i);
    // The toggle is visible and seeded OFF.
    const toggle = screen.getByRole('checkbox', { name: /idle/i });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    // Turn idle on and save.
    fireEvent.click(toggle);
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    // Block authored from the template default: enabled true, detection from the template.
    expect(lastPayload().idleShutdown).toEqual({ enabled: true, timeoutInMinutes: 30, detection });
  });

  test('no stored idle block, toggle left OFF: save sends an explicit {enabled:false} block (not omitted)', async () => {
    // Even with the toggle left off, save must send an explicit disabled block so the
    // operator's defaulter can't re-enable idle from the (enabled) template default.
    const detection = { httpGet: { port: 8888 } };
    templatesResponse = {
      items: [
        tmpl({
          displayName: 'EKS',
          defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30, detection },
          idleShutdownOverrides: { allow: true, minIdleTimeoutInMinutes: 5, maxIdleTimeoutInMinutes: 120 },
        }),
      ],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderEditor(baseWorkspace({ templateRef: { name: 'eks-oidc', namespace: 'shared-ns' } }));
    await screen.findByText(/^resources$/i);
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(lastPayload().idleShutdown).toEqual({ enabled: false, timeoutInMinutes: 30, detection });
  });

  test('template drifted to REQUIRE idle: conform forces enabled on, banner discloses it, save sends enabled block', async () => {
    // Template now locks idle (allow:false) with an enabled default, but the workspace's
    // stored block is disabled — reachable only via drift. The operator's structural lock
    // rejects a disabled block under this template, and the toggle is frozen, so the editor
    // must conform enabled→true, disclose it, and send the enabled block (from the template
    // default detection) so the save is admitted.
    const detection = { httpGet: { port: 8888 } };
    templatesResponse = {
      items: [
        tmpl({
          displayName: 'EKS',
          defaultIdleShutdown: { enabled: true, idleTimeoutInMinutes: 30, detection },
          idleShutdownOverrides: { allow: false, minIdleTimeoutInMinutes: 30, maxIdleTimeoutInMinutes: 120 },
        }),
      ],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    // Workspace stored idle DISABLED (the drift-created state).
    await renderEditor(
      baseWorkspace({
        templateRef: { name: 'eks-oidc', namespace: 'shared-ns' },
        idleShutdown: { enabled: false, idleTimeoutInMinutes: 30, detection },
      }),
    );
    await screen.findByText(/^resources$/i);
    // Banner discloses the forced enable (assert via strings, not a hardcoded literal).
    expect(screen.getByText(strings.workspace.editConformIdleEnabled)).toBeTruthy();
    // The frozen toggle is disabled + checked, with a lock icon whose tooltip carries the
    // locked-idle copy (asserted via strings, not a hardcoded literal).
    const idleToggle = screen.getByRole('checkbox', { name: strings.workspace.idleShutdownEnable });
    expect((idleToggle as HTMLInputElement).disabled).toBe(true);
    expect((idleToggle as HTMLInputElement).checked).toBe(true);
    const lockIcon = screen.getByTestId('idle-locked-icon');
    expect(lockIcon.closest('[aria-label]')?.getAttribute('aria-label')).toBe(strings.workspace.idleShutdownLockedTooltip);
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(lastPayload().idleShutdown).toEqual({ enabled: true, timeoutInMinutes: 30, detection });
  });

  test('fixed-image conform-on-load sends the conformed image on save', async () => {
    // Template pins a fixed image (no allowedImages, no custom) whose defaultImage drifted
    // from what the workspace stores. conform-on-load rewrites the stored image to the
    // template default; save must SEND that image or the operator's revalidation rejects it.
    templatesResponse = {
      items: [tmpl({ displayName: 'EKS', defaultImage: 'nginx:1.27' })],
      access: { user: 'ok', shared: 'ok' },
      namespaces: { own: 'user-ns', shared: 'shared-ns' },
    };
    await renderEditor(baseWorkspace({ templateRef: { name: 'eks-oidc', namespace: 'shared-ns' }, image: 'nginx:latest' }));
    await screen.findByText(/^resources$/i);
    save();
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(lastPayload().image).toBe('nginx:1.27');
  });
});
