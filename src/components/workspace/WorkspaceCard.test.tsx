import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { WorkspaceCard } from './WorkspaceCard';
import { TestProviders, makeWorkspace } from '../../test-utils';

// Mock auth context to pretend "alice" is logged in
mock.module('../../context', () => ({
  useAuth: () => ({ user: { username: 'alice' }, isLoading: false }),
}));

// Mock mutations so we can assert on `isPending` etc without real fetches
const mutationStub = { mutate: mock(() => {}), isPending: false };
mock.module('../../api', () => ({
  useStartWorkspace: () => mutationStub,
  useStopWorkspace: () => mutationStub,
  useDeleteWorkspace: () => mutationStub,
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
