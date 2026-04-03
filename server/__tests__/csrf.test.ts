import { describe, expect, test } from 'bun:test';
import { validateCSRF } from '../csrf';
import { serverConfig } from '../k8s';

describe('validateCSRF', () => {
  const originalDomain = serverConfig.session.expectedDomain;

  test('allows GET requests without origin', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces', { method: 'GET' });
    expect(validateCSRF(req)).toBe(true);
    serverConfig.session.expectedDomain = originalDomain;
  });

  test('allows POST with matching origin', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces', {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
    });
    expect(validateCSRF(req)).toBe(true);
    serverConfig.session.expectedDomain = originalDomain;
  });

  test('rejects POST with mismatched origin', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces', {
      method: 'POST',
      headers: { Origin: 'https://evil.com' },
    });
    expect(validateCSRF(req)).toBe(false);
    serverConfig.session.expectedDomain = originalDomain;
  });

  test('rejects POST with no origin or referer', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces', { method: 'POST' });
    expect(validateCSRF(req)).toBe(false);
    serverConfig.session.expectedDomain = originalDomain;
  });

  test('allows POST with matching referer when no origin', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces', {
      method: 'POST',
      headers: { Referer: 'https://example.com/some/page' },
    });
    expect(validateCSRF(req)).toBe(true);
    serverConfig.session.expectedDomain = originalDomain;
  });

  test('skips check when expectedDomain not configured', () => {
    serverConfig.session.expectedDomain = '';
    const req = new Request('http://localhost/api/v1/workspaces', { method: 'POST' });
    expect(validateCSRF(req)).toBe(true);
  });

  test('allows DELETE with matching origin', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces/test', {
      method: 'DELETE',
      headers: { Origin: 'https://example.com' },
    });
    expect(validateCSRF(req)).toBe(true);
    serverConfig.session.expectedDomain = originalDomain;
  });

  test('rejects POST with http origin (non-TLS)', () => {
    serverConfig.session.expectedDomain = 'example.com';
    const req = new Request('http://localhost/api/v1/workspaces', {
      method: 'POST',
      headers: { Origin: 'http://example.com' },
    });
    expect(validateCSRF(req)).toBe(false);
    serverConfig.session.expectedDomain = originalDomain;
  });
});
