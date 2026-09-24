import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { TestProviders, makeWorkspace, makeQueryClient } from '../../test-utils';

// Leaf-mock the API client (the pattern every suite here uses) and run the real hooks
// against it. Mocking the ../../api or ../../context barrels instead leaks into every
// test file that runs after this one: bun module mocks are process-global and never
// restored, and file order varies by filesystem, so a barrel mock breaks other suites
// only on some machines.
mock.module('../../api/client', () => ({
  apiClient: {
    startWorkspace: mock(async () => ({})),
    stopWorkspace: mock(async () => ({})),
    deleteWorkspace: mock(async () => ({})),
  },
  ApiError: class ApiError extends Error {},
}));

const { WorkspaceCard } = await import('./WorkspaceCard');
const { AuthProvider, authKeys } = await import('../../context/AuthContext');

// The signed-in user. `displayUser` (raw OIDC claim, display-only) and `k8sUser` (the
// authoritative K8s username `created-by` holds) are deliberately different: ownership
// must compare against k8sUser, so the owner annotations in these tests use 'alice'
// (== k8sUser) while displayUser is a distinct claim. Comparing against displayUser
// instead would fail the owner-gating tests (#57).
const alice = { displayUser: 'alice-raw-claim', k8sUser: 'alice' };

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

async function renderCard(ws: ReturnType<typeof makeWorkspace>, extra?: React.ReactNode) {
  const queryClient = makeQueryClient();
  // Seed the me-query (fresh for its 5-minute staleTime), so AuthProvider resolves
  // without a fetch, the same trick TestProviders uses for the namespace bootstrap.
  queryClient.setQueryData(authKeys.me, alice);
  let result!: ReturnType<typeof render>;
  // Render, then flush a second act() scope: react-query's batched notify lands after the
  // rendering act exits, so a single scope would leave that commit outside act.
  await act(async () => {
    result = render(
      <TestProviders queryClient={queryClient}>
        <AuthProvider>
          <WorkspaceCard workspace={ws} />
          {extra}
        </AuthProvider>
      </TestProviders>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return result;
}

beforeEach(() => {
  cleanup();
});

describe('WorkspaceCard', () => {
  test('shows Running status when workspace is running + available', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    await renderCard(ws);
    expect(screen.getByText('Running')).toBeDefined();
  });

  test('shows Stopped status when desiredStatus is Stopped', async () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { desiredStatus: 'Stopped', displayName: 'Test', image: 'img', accessType: 'Public', ownershipType: 'OwnerOnly' },
      status: { accessURL: '', conditions: [] },
    });
    await renderCard(ws);
    expect(screen.getByText('Stopped')).toBeDefined();
  });

  test('shows Starting when running but not yet available', async () => {
    const ws = makeWorkspace({
      owner: 'alice',
      status: {
        accessURL: '',
        conditions: [{ type: 'Progressing', status: 'True', reason: '', message: '' }],
      },
    });
    await renderCard(ws);
    expect(screen.getByText('Starting')).toBeDefined();
  });

  test('shows stop button when owner + running', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    await renderCard(ws);
    expect(screen.getByRole('button', { name: /stop/i })).toBeDefined();
  });

  test('shows start button when owner + stopped', async () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { desiredStatus: 'Stopped', displayName: 'T', image: 'i', accessType: 'Public', ownershipType: 'OwnerOnly' },
      status: { accessURL: '', conditions: [] },
    });
    await renderCard(ws);
    expect(screen.getByRole('button', { name: /start/i })).toBeDefined();
  });

  test('hides start/stop buttons for non-owner', async () => {
    const ws = makeWorkspace({ owner: 'bob' });
    await renderCard(ws);
    expect(screen.queryByRole('button', { name: /^stop$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^start$/i })).toBeNull();
  });

  test('shows Open button when running + available + public', async () => {
    const ws = makeWorkspace({ owner: 'bob' }); // not owner but public
    await renderCard(ws);
    expect(screen.getByRole('button', { name: /open/i })).toBeDefined();
  });

  test('hides Open button for non-owner on OwnerOnly workspace', async () => {
    const ws = makeWorkspace({
      owner: 'bob',
      spec: { accessType: 'OwnerOnly', desiredStatus: 'Running', displayName: 'T', image: 'i', ownershipType: 'OwnerOnly' },
    });
    await renderCard(ws);
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  });

  test('hides Open button when workspace is not available', async () => {
    const ws = makeWorkspace({
      owner: 'alice',
      status: { accessURL: 'https://ws.example.com', conditions: [] },
    });
    await renderCard(ws);
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  });

  test('shows displayName when set, falls back to name', async () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { displayName: 'My Display', image: 'i', desiredStatus: 'Running', accessType: 'Public', ownershipType: 'OwnerOnly' },
    });
    await renderCard(ws);
    expect(screen.getByText('My Display')).toBeDefined();
  });
});

describe('WorkspaceCard accelerator chip', () => {
  test('renders a count + friendly label chip when an accelerator limit is present', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi', 'nvidia.com/gpu': '1' } };
    await renderCard(ws);
    expect(screen.getByText('1 GPU')).toBeDefined();
  });

  test('renders nothing accelerator-related without such a limit', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi' } };
    await renderCard(ws);
    expect(screen.queryByText(/GPU/)).toBeNull();
  });

  test('stored quantities the sliders cannot produce round to 2 decimals', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    // "1G" is 10^9 bytes = 0.9313… Gi; "1500m" is 1.5 cores — both must not render raw floats.
    ws.spec.resources = { limits: { cpu: '1500m', memory: '1G' } };
    ws.spec.storage = { size: '2G' };
    await renderCard(ws);
    expect(screen.getByText('1.5 CPU')).toBeDefined();
    expect(screen.getByText(/^0\.93 GiB$/)).toBeDefined();
    expect(screen.getByText(/^1\.86 GiB$/)).toBeDefined();
  });

  test('ephemeral-storage limits never render as accelerator chips (unprefixed keys are built-ins)', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '1073741824' } };
    await renderCard(ws);
    expect(screen.queryByText(/ephemeral-storage/)).toBeNull();
  });

  test('a tiny nonzero quantity renders as <0.01, never as 0', async () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '1m', memory: '4Gi' } };
    await renderCard(ws);
    expect(screen.getByText('<0.01 CPU')).toBeDefined();
  });
});

describe('WorkspaceCard navigation', () => {
  test('Details navigates carrying the workspace namespace', async () => {
    // A bare /workspace/<name> would resolve the detail fetch against the cookie's
    // namespace, 404ing when this list was reached via a ?namespace= deep link.
    const ws = makeWorkspace({ owner: 'alice', metadata: { namespace: 'team-b' } });
    await renderCard(ws, <LocationProbe />);
    fireEvent.click(screen.getByRole('button', { name: /details/i }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workspace/test-ws?namespace=team-b'));
  });
});
