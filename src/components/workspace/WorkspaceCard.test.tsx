import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { WorkspaceCard } from './WorkspaceCard';
import { TestProviders, makeWorkspace } from '../../test-utils';

// Mock auth context to pretend "alice" is logged in. `displayUser` (raw OIDC claim,
// display-only) and `k8sUser` (the authoritative K8s username `created-by` holds) are
// DELIBERATELY DIFFERENT here: ownership must compare against k8sUser, so the owner annotations
// in these tests use 'alice' (== k8sUser) while displayUser is a distinct claim. This makes the
// owner-gating tests a real regression guard for #57 — reverting the call site to
// user?.displayUser would break them.
mock.module('../../context', () => ({
  useAuth: () => ({ user: { displayUser: 'alice-raw-claim', k8sUser: 'alice' }, isLoading: false }),
}));

// Mock mutations so we can assert on `isPending` etc without real fetches
const mutationStub = { mutate: mock(() => {}), isPending: false };
// Mutable so individual tests can supply template fixtures for the resources fallback.
let templatesItems: unknown[] = [];
mock.module('../../api', () => ({
  useStartWorkspace: () => mutationStub,
  useStopWorkspace: () => mutationStub,
  useDeleteWorkspace: () => mutationStub,
  useTemplates: () => ({ data: { items: templatesItems }, isLoading: false }),
}));

function renderCard(ws: ReturnType<typeof makeWorkspace>) {
  return render(
    <TestProviders>
      <WorkspaceCard workspace={ws} />
    </TestProviders>,
  );
}

describe('WorkspaceCard', () => {
  beforeEach(() => {
    cleanup();
    mutationStub.mutate.mockClear();
  });

  test('shows Running status when workspace is running + available', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    renderCard(ws);
    expect(screen.getByText('Running')).toBeDefined();
  });

  test('shows Stopped status when desiredStatus is Stopped', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { desiredStatus: 'Stopped', displayName: 'Test', image: 'img', accessType: 'Public', ownershipType: 'OwnerOnly' },
      status: { accessURL: '', conditions: [] },
    });
    renderCard(ws);
    expect(screen.getByText('Stopped')).toBeDefined();
  });

  test('shows Starting when running but not yet available', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      status: {
        accessURL: '',
        conditions: [{ type: 'Progressing', status: 'True', reason: '', message: '' }],
      },
    });
    renderCard(ws);
    expect(screen.getByText('Starting')).toBeDefined();
  });

  test('shows stop button when owner + running', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    renderCard(ws);
    expect(screen.getByRole('button', { name: /stop/i })).toBeDefined();
  });

  test('shows start button when owner + stopped', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { desiredStatus: 'Stopped', displayName: 'T', image: 'i', accessType: 'Public', ownershipType: 'OwnerOnly' },
      status: { accessURL: '', conditions: [] },
    });
    renderCard(ws);
    expect(screen.getByRole('button', { name: /start/i })).toBeDefined();
  });

  test('hides start/stop buttons for non-owner', () => {
    const ws = makeWorkspace({ owner: 'bob' });
    renderCard(ws);
    expect(screen.queryByRole('button', { name: /^stop$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^start$/i })).toBeNull();
  });

  test('shows Open button when running + available + public', () => {
    const ws = makeWorkspace({ owner: 'bob' }); // not owner but public
    renderCard(ws);
    expect(screen.getByRole('button', { name: /open/i })).toBeDefined();
  });

  test('hides Open button for non-owner on OwnerOnly workspace', () => {
    const ws = makeWorkspace({
      owner: 'bob',
      spec: { accessType: 'OwnerOnly', desiredStatus: 'Running', displayName: 'T', image: 'i', ownershipType: 'OwnerOnly' },
    });
    renderCard(ws);
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  });

  test('hides Open button when workspace is not available', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      status: { accessURL: 'https://ws.example.com', conditions: [] },
    });
    renderCard(ws);
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
  });

  test('shows displayName when set, falls back to name', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { displayName: 'My Display', image: 'i', desiredStatus: 'Running', accessType: 'Public', ownershipType: 'OwnerOnly' },
    });
    renderCard(ws);
    expect(screen.getByText('My Display')).toBeDefined();
  });
});

describe('WorkspaceCard accelerator chip', () => {
  beforeEach(() => cleanup());

  test('renders a count + friendly label chip when an accelerator limit is present', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi', 'nvidia.com/gpu': '1' } };
    renderCard(ws);
    expect(screen.getByText('1 GPU')).toBeDefined();
  });

  test('renders nothing accelerator-related without such a limit', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi' } };
    renderCard(ws);
    expect(screen.queryByText(/GPU/)).toBeNull();
  });

  test('stored quantities the sliders cannot produce round to 2 decimals', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    // "1G" is 10^9 bytes = 0.9313… Gi; "1500m" is 1.5 cores — both must not render raw floats.
    ws.spec.resources = { limits: { cpu: '1500m', memory: '1G' } };
    ws.spec.storage = { size: '2G' };
    renderCard(ws);
    expect(screen.getByText('1.5 CPU')).toBeDefined();
    expect(screen.getByText(/^0\.93 GiB$/)).toBeDefined();
    expect(screen.getByText(/^1\.86 GiB$/)).toBeDefined();
  });

  test('ephemeral-storage limits never render as accelerator chips (unprefixed keys are built-ins)', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '1073741824' } };
    renderCard(ws);
    expect(screen.queryByText(/ephemeral-storage/)).toBeNull();
  });

  test('a tiny nonzero quantity renders as <0.01, never as 0', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '1m', memory: '4Gi' } };
    renderCard(ws);
    expect(screen.getByText('<0.01 CPU')).toBeDefined();
  });
});

describe('WorkspaceCard resources fallback to template defaults (#69)', () => {
  const pinnedTemplate = {
    metadata: { name: 'pinned-gpu', namespace: 'shared' },
    spec: { defaultResources: { requests: { cpu: '3', memory: '12Gi', 'nvidia.com/gpu': '1' }, limits: { cpu: '3', memory: '12Gi', 'nvidia.com/gpu': '1' } } },
    sourceNamespace: 'shared',
  };

  beforeEach(() => {
    cleanup();
    templatesItems = [pinnedTemplate];
  });

  test('a workspace without spec.resources shows its template defaults', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    delete ws.spec.resources;
    ws.spec.templateRef = { name: 'pinned-gpu', namespace: 'shared' };
    renderCard(ws);
    expect(screen.getByText('3 CPU')).toBeDefined();
    expect(screen.getByText('12 GiB')).toBeDefined();
    expect(screen.getByText('1 GPU')).toBeDefined();
  });

  test('an unresolvable templateRef keeps the placeholder values', () => {
    templatesItems = [];
    const ws = makeWorkspace({ owner: 'alice' });
    delete ws.spec.resources;
    ws.spec.templateRef = { name: 'ghost-template' };
    renderCard(ws);
    expect(screen.getByText('— CPU')).toBeDefined();
  });

  test('stored resources win over template defaults', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    ws.spec.resources = { limits: { cpu: '2', memory: '4Gi' } };
    ws.spec.templateRef = { name: 'pinned-gpu', namespace: 'shared' };
    renderCard(ws);
    expect(screen.getByText('2 CPU')).toBeDefined();
    // The template's gpu default must not leak into a workspace that stored no gpu.
    expect(screen.queryByText('1 GPU')).toBeNull();
  });
});
