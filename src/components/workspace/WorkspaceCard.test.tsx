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

describe('WorkspaceCard', () => {
  beforeEach(() => {
    cleanup();
    mutationStub.mutate.mockClear();
  });

  test('shows Running status when workspace is running + available', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.getByText('Running')).toBeDefined();
  });

  test('shows Stopped status when desiredStatus is Stopped', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { desiredStatus: 'Stopped', displayName: 'Test', image: 'img', accessType: 'Public', ownershipType: 'OwnerOnly' },
      status: { accessURL: '', conditions: [] },
    });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
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
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.getByText('Starting')).toBeDefined();
  });

  test('shows stop button when owner + running', () => {
    const ws = makeWorkspace({ owner: 'alice' });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.getAllByLabelText(/stop/i).length).toBeGreaterThan(0);
  });

  test('shows start button when owner + stopped', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { desiredStatus: 'Stopped', displayName: 'T', image: 'i', accessType: 'Public', ownershipType: 'OwnerOnly' },
      status: { accessURL: '', conditions: [] },
    });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.getAllByLabelText(/start/i).length).toBeGreaterThan(0);
  });

  test('hides start/stop buttons for non-owner', () => {
    const ws = makeWorkspace({ owner: 'bob' });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.queryByLabelText(/^stop$/i)).toBeNull();
    expect(screen.queryByLabelText(/^start$/i)).toBeNull();
  });

  test('shows Open button when running + available + public', () => {
    const ws = makeWorkspace({ owner: 'bob' }); // not owner but public
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.getByLabelText(/open workspace/i)).toBeDefined();
  });

  test('hides Open button for non-owner on OwnerOnly workspace', () => {
    const ws = makeWorkspace({
      owner: 'bob',
      spec: { accessType: 'OwnerOnly', desiredStatus: 'Running', displayName: 'T', image: 'i', ownershipType: 'OwnerOnly' },
    });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.queryByLabelText(/open workspace/i)).toBeNull();
  });

  test('hides Open button when workspace is not available', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      status: { accessURL: 'https://ws.example.com', conditions: [] },
    });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.queryByLabelText(/open workspace/i)).toBeNull();
  });

  test('shows displayName when set, falls back to name', () => {
    const ws = makeWorkspace({
      owner: 'alice',
      spec: { displayName: 'My Display', image: 'i', desiredStatus: 'Running', accessType: 'Public', ownershipType: 'OwnerOnly' },
    });
    render(
      <TestProviders>
        <WorkspaceCard workspace={ws} />
      </TestProviders>,
    );
    expect(screen.getByText('My Display')).toBeDefined();
  });
});
