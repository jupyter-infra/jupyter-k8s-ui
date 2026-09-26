import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NamespaceGateView } from './NamespaceGate';
import { strings } from '../../constants';

beforeEach(() => cleanup());

describe('NamespaceGateView', () => {
  test('shows progress while the namespace lookup runs', () => {
    render(
      <NamespaceGateView loading error={null} onRetry={() => {}}>
        <div>page</div>
      </NamespaceGateView>,
    );
    expect(screen.getByRole('progressbar')).toBeDefined();
    expect(screen.queryByText('page')).toBeNull();
  });

  test('shows the error with Retry once the lookup has failed, and Retry calls back', () => {
    const onRetry = mock(() => {});
    render(
      <NamespaceGateView loading={false} error={new Error('down')} onRetry={onRetry}>
        <div>page</div>
      </NamespaceGateView>,
    );
    expect(screen.getByText(strings.namespace.loadErrorTitle)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: strings.namespace.loadErrorAction }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('page')).toBeNull();
  });

  test('renders the page when there is nothing to wait for', () => {
    render(
      <NamespaceGateView loading={false} error={null} onRetry={() => {}}>
        <div>page</div>
      </NamespaceGateView>,
    );
    expect(screen.getByText('page')).toBeDefined();
  });
});
