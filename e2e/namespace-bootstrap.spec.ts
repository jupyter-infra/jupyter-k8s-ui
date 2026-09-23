import { test, expect } from '@playwright/test';
import { expectOnPath } from './test-utils';

// The namespace bootstrap (GET /api/v1/my-namespace) decides which namespace the app shows.
// While it fails the list must not read as "you have no workspaces"; once it succeeds the app
// must recover without a reload.
test.describe('Namespace bootstrap failure', () => {
  test('shows the error state with Retry and recovers once the lookup succeeds', async ({ page }) => {
    const bootstrap = '**/api/v1/my-namespace';
    await page.route(bootstrap, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
    });

    await page.goto('/');
    // Two retries with backoff run before the error state shows.
    await expect(page.getByText(/couldn't load your namespace/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/no workspaces/i)).toBeHidden();

    await page.unroute(bootstrap);
    await page.getByRole('button', { name: /^retry$/i }).click();

    await expectOnPath(page, { namespace: 'default' });
    await expect(page.getByRole('button', { name: /select namespace/i })).toContainText('default');
  });
});
