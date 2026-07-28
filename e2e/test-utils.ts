import { expect, type Page } from '@playwright/test';

// Shared E2E helpers. NOT a .spec file, so Playwright won't collect it as a test.

/** Escape a string for safe embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a full-URL pattern that matches when the URL's path is exactly `path`, tolerating
 * an optional trailing query string. `toHaveURL` matches against the ENTIRE URL (scheme +
 * host + path + query), so a bare `/\/create$/` fails once NamespaceContext canonicalizes
 * `?namespace=` onto the URL — hence the optional `(\?.*)?` tail. Anchored at end only
 * (the host prefix varies).
 */
function pathPattern(path: string): RegExp {
  return new RegExp(`${escapeRegex(path)}(\\?.*)?$`);
}

/**
 * Assert the page is on `path` (default `/`, the workspace list), tolerating the
 * `?namespace=` param the app canonicalizes onto the URL. Pass `namespace` to also assert
 * the active namespace in the URL — the single place E2E encodes "we're on the list page,
 * scoped to ns X".
 *
 *   await expectOnPath(page);                              // on the list (any namespace)
 *   await expectOnPath(page, { namespace: 'e2e-team-b' }); // on the list, scoped to team-b
 *   await expectOnPath(page, { path: '/create' });         // on the create page
 */
export async function expectOnPath(page: Page, opts: { path?: string; namespace?: string; timeout?: number } = {}): Promise<void> {
  const { path = '/', namespace, timeout = 10_000 } = opts;
  await expect(page).toHaveURL(pathPattern(path), { timeout });
  if (namespace !== undefined) {
    // The canonicalized `?namespace=<ns>` param (order-independent within the query).
    await expect(page).toHaveURL(new RegExp(`[?&]namespace=${escapeRegex(namespace)}(&|$)`), { timeout });
  }
}
