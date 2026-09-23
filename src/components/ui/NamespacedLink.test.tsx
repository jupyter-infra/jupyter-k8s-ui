import { describe, test, expect, beforeEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { TestProviders } from '../../test-utils';
import { NamespacedLink } from './NamespacedLink';

beforeEach(() => cleanup());

describe('NamespacedLink', () => {
  test('carries the active namespace', () => {
    render(
      <TestProviders namespace="team-a">
        <NamespacedLink to="/create">Create</NamespacedLink>
      </TestProviders>,
    );
    expect(screen.getByRole('link', { name: 'Create' }).getAttribute('href')).toBe('/create?namespace=team-a');
  });

  test('an explicit namespace wins over the active one', () => {
    render(
      <TestProviders namespace="team-a">
        <NamespacedLink to="/workspace/x" namespace="team-b">
          Open
        </NamespacedLink>
      </TestProviders>,
    );
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/workspace/x?namespace=team-b');
  });
});
