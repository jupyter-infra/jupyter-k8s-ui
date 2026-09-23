import { describe, test, expect, beforeEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { TestProviders } from '../test-utils';
import { useNamespacedNavigate } from './useNamespacedNavigate';

function Probe() {
  const navigate = useNamespacedNavigate();
  const { pathname, search } = useLocation();
  const navigationType = useNavigationType();
  return (
    <div>
      <button onClick={() => navigate('/create')}>active</button>
      <button onClick={() => navigate('/workspace/x', { namespace: 'team-b' })}>explicit</button>
      <button onClick={() => navigate('/', { replace: true })}>replace</button>
      <div data-testid="location">{pathname + search}</div>
      <div data-testid="type">{navigationType}</div>
    </div>
  );
}

beforeEach(() => cleanup());

describe('useNamespacedNavigate', () => {
  test('appends the active namespace to the path', () => {
    render(
      <TestProviders namespace="team-a">
        <Probe />
      </TestProviders>,
    );
    fireEvent.click(screen.getByText('active'));
    expect(screen.getByTestId('location').textContent).toBe('/create?namespace=team-a');
  });

  test('an explicit namespace wins over the active one', () => {
    render(
      <TestProviders namespace="team-a">
        <Probe />
      </TestProviders>,
    );
    fireEvent.click(screen.getByText('explicit'));
    expect(screen.getByTestId('location').textContent).toBe('/workspace/x?namespace=team-b');
  });

  test('forwards replace to the router', () => {
    render(
      <TestProviders namespace="team-a" initialEntries={['/workspace/x']}>
        <Probe />
      </TestProviders>,
    );
    fireEvent.click(screen.getByText('replace'));
    expect(screen.getByTestId('location').textContent).toBe('/?namespace=team-a');
    expect(screen.getByTestId('type').textContent).toBe('REPLACE');
  });
});
