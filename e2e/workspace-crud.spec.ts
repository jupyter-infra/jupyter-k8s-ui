import { test, expect, type Locator, type Page } from '@playwright/test';

// Unique prefix per test run to avoid collisions
const RUN_ID = `e2e-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

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

/**
 * Click Refresh until the card disappears. The list only auto-polls every 60s, so
 * after a delete the card can linger until the next poll — clicking Refresh forces
 * the refetch, mirroring what a user would do.
 */
async function waitForCardGone(page: Page, card: Locator) {
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: /refresh/i }).click();
        return card.isVisible().catch(() => false);
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBeFalsy();
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

    // Fill both name fields using role selectors for MUI TextFields
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);

    // Submit the form — image comes from the default WorkspaceTemplate via operator webhook
    await page.getByRole('button', { name: /create workspace/i }).click();

    // Should redirect back to list
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    // Switch to "All" filter so we can see the workspace regardless of owner matching
    await page.getByRole('button', { name: /all/i }).click();

    // Workspace card should appear (aria-label format: "{displayName} workspace, {status}")
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

    // Click details button
    await card.getByRole('button', { name: /^details$/i }).click();

    // Should navigate to detail page
    await expect(page).toHaveURL(new RegExp(`/workspace/${WS_NAME}`));

    // Verify workspace info is displayed (use heading to avoid strict mode — name shows twice)
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible();
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Conditions')).toBeVisible();
    await expect(page.getByText('Information')).toBeVisible();
  });

  test('stops and starts from detail page', { timeout: 120_000 }, async ({ page }) => {
    await page.goto(`/workspace/${WS_NAME}`);

    // Wait for page to load
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });

    // Stop from detail page
    await page.getByRole('button', { name: /stop/i }).click();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 45_000 });

    // Start from detail page — cold start can take longer in CI
    await page.getByRole('button', { name: /start/i }).click();
    await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 45_000 });
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
    await waitForCardGone(page, card);
  });

  // Regression guard for #39: creating a "Private" (owner-only) workspace once
  // failed because the UI submitted accessType "Private", which the CRD rejects
  // with a 422. This exercises the ownership toggle end-to-end against the real
  // API server — the path the default-create test above never touches.
  test('creates a Private (owner-only) workspace and reaches Running', async ({ page }) => {
    // Avoid "private" in the name: the card renders a "Private" chip and getByText
    // would otherwise match the name too, tripping Playwright's strict mode.
    const privateName = `${RUN_ID}-owned`;

    await page.goto('/create');

    await page.getByRole('textbox', { name: /^name$/i }).fill(privateName);
    await page.getByRole('textbox', { name: /display name/i }).fill(privateName);

    // Flip the access toggle from Public to Private (submits accessType "OwnerOnly")
    await page.getByRole('button', { name: /^private$/i }).click();

    await page.getByRole('button', { name: /create workspace/i }).click();

    // A 422 from the API server would surface as an inline error alert and keep us
    // on /create. Redirect back to the list is proof the CRD accepted the enum.
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    await page.getByRole('button', { name: /all/i }).click();

    const card = page.getByLabel(new RegExp(`${privateName}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    // The Private chip confirms ownershipType round-tripped through K8s
    await expect(card.getByText('Private', { exact: true })).toBeVisible();

    await waitForCardStatus(page, card, 'Running');

    // Clean up so we don't leak a workspace into later runs
    await card.getByRole('button', { name: /more options/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();
    await waitForCardGone(page, card);
  });

  test('rejects invalid workspace name in create form', async ({ page }) => {
    await page.goto('/create');

    // The name field sanitizes input (sanitizeK8sName strips invalid chars)
    // so typing uppercase results in lowercase
    const nameField = page.getByRole('textbox', { name: /^name$/i });
    await nameField.fill('INVALID');
    await expect(nameField).toHaveValue('invalid');

    // Empty name should keep submit disabled
    await nameField.fill('');
    const submitButton = page.getByRole('button', { name: /create workspace/i });
    await expect(submitButton).toBeDisabled();
  });
});
