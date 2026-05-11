import { test, expect, type Locator, type Page } from '@playwright/test';

// Unique prefix per test run to avoid collisions
const RUN_ID = `e2e-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

// Workspace image — override via E2E_WORKSPACE_IMAGE env var or Makefile variable.
// Defaults to nginx because the real UV image isn't public on GHCR (see Makefile comments).
const E2E_WORKSPACE_IMAGE = process.env.E2E_WORKSPACE_IMAGE || 'nginx:latest';

/** Click Refresh and wait for the expected status text using Playwright's polling assertion. */
async function waitForCardStatus(page: Page, card: Locator, text: string) {
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: /refresh/i }).click();
        return card
          .getByText(text)
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBeTruthy();
}

test.describe('Workspace CRUD', () => {
  test.describe.configure({ mode: 'serial' });

  test('shows empty state when no workspaces exist', async ({ page }) => {
    await page.goto('/');
    // Switch to "All" filter to avoid user-identity filtering
    await page.getByRole('button', { name: /all/i }).click();
    // Search for our run-specific prefix to ensure isolation
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(RUN_ID);
    await expect(page.getByText(/no workspaces found/i)).toBeVisible();
  });

  test('creates a workspace and waits for Running', async ({ page }) => {
    await page.goto('/');

    // Navigate to create page
    await page.getByRole('button', { name: /new workspace/i }).click();
    await expect(page).toHaveURL('/create');

    // Fill workspace name
    await page.getByLabel(/^name/i).fill(WS_NAME);

    // Override the default image with one that's available in Kind without building
    const imageInput = page.getByLabel(/image/i);
    await imageInput.clear();
    await imageInput.fill(E2E_WORKSPACE_IMAGE);

    // Submit the form
    await page.getByRole('button', { name: /create workspace/i }).click();

    // Should redirect back to list
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    // Switch to "All" filter so we can see the workspace regardless of owner matching
    await page.getByRole('button', { name: /all/i }).click();

    // Workspace card should appear (scoped by aria-label to avoid strict mode violation)
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Refresh until status transitions to "Running" (operator reconciles in seconds)
    await waitForCardStatus(page, card, 'Running');
  });

  test('stops a running workspace', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();

    // Find our workspace card and click Stop
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: /stop/i }).click();

    // Refresh until status transitions to Stopped
    await waitForCardStatus(page, card, 'Stopped');

    // Stop button should be gone, Start button should appear
    await expect(card.getByRole('button', { name: /start/i })).toBeVisible();
  });

  test('starts a stopped workspace', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();

    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Click Start
    await card.getByRole('button', { name: /start/i }).click();

    // Refresh until Running
    await waitForCardStatus(page, card, 'Running');

    // Stop button should be back
    await expect(card.getByRole('button', { name: /stop/i })).toBeVisible();
  });

  test('views workspace detail page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();

    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Click view details
    await card.getByRole('button', { name: /view details/i }).click();

    // Should navigate to detail page
    await expect(page).toHaveURL(new RegExp(`/workspace/${WS_NAME}`));

    // Verify workspace info is displayed (use heading to avoid strict mode — name shows twice)
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible();
    await expect(page.getByText('Running', { exact: true })).toBeVisible();
    await expect(page.getByText('Conditions')).toBeVisible();
    await expect(page.getByText('Information')).toBeVisible();
  });

  test('stops and starts from detail page', async ({ page }) => {
    await page.goto(`/workspace/${WS_NAME}`);

    // Wait for page to load
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });

    // Stop from detail page
    await page.getByRole('button', { name: /stop/i }).click();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 30_000 });

    // Start from detail page
    await page.getByRole('button', { name: /start/i }).click();
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test('deletes a workspace', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();

    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Open the more menu
    await card.getByRole('button', { name: /more options/i }).click();

    // Click Delete in the menu
    await page.getByRole('menuitem', { name: /delete/i }).click();

    // Confirm dialog should appear
    await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();

    // Workspace should disappear from the list
    await expect(card).not.toBeVisible({ timeout: 30_000 });
  });

  test('rejects invalid workspace name in create form', async ({ page }) => {
    await page.goto('/create');

    // The name field sanitizes input (sanitizeK8sName strips invalid chars)
    // so typing uppercase results in lowercase
    const nameField = page.getByLabel(/^name/i);
    await nameField.fill('INVALID');
    await expect(nameField).toHaveValue('invalid');

    // Empty name should keep submit disabled
    await nameField.fill('');
    const submitButton = page.getByRole('button', { name: /create workspace/i });
    await expect(submitButton).toBeDisabled();
  });
});
