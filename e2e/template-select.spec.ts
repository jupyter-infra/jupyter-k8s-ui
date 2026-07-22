import { test, expect, type Page } from '@playwright/test';

// Template SELECTION behaviors, exercised against the real cluster with TWO template
// fixtures: `default` (flagged default, appType jupyterlab) and `alt-template` (non-default,
// appType code-server, idle enabled). With ≥2 templates and one flagged default, the picker
// renders a card grid preselecting the default (no "No template" card).
//
// Covers:
//   1. template selection persists across the simple ↔ YAML toggle (both directions);
//   2. template is LOCKED on simple edit but editable in the YAML editor;
//   3. workspace-detail pills we added (Image / Template / Idle shutdown);
//   4. workspace-list card additions (template pill + appType logo).

const RUN_ID = `e2e-tsel-${Date.now()}`;

/** Wait for the Monaco editor to be mounted + interactive (textarea attached). */
async function waitForMonaco(page: Page) {
  await page.locator('.monaco-editor textarea').first().waitFor({ state: 'attached', timeout: 20_000 });
}

/** Click Refresh on the list until the named card shows the expected status. */
async function waitForCardStatus(page: Page, name: string, statusText: string) {
  const card = page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: /refresh/i }).click();
        return card
          .getByText(statusText, { exact: true })
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBeTruthy();
}

async function deleteWorkspace(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /all/i }).click();
  const card = page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
  if (!(await card.isVisible().catch(() => false))) return;
  await card.getByRole('button', { name: /more options/i }).click();
  await page.getByRole('menuitem', { name: /delete/i }).click();
  await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
  await page.getByRole('button', { name: /delete/i }).click();
}

test.describe('Template selection', () => {
  test.describe.configure({ mode: 'serial' });

  // A workspace created against `alt-template` (used by the detail + list assertions).
  const ALT_WS = `${RUN_ID}-alt`;

  test('picker preselects the flagged default; carries the selection into the YAML editor', async ({ page }) => {
    await page.goto('/create');

    // ≥2 templates + one flagged default → the default card is selected on load.
    const defaultCard = page.getByRole('button', { name: /select Default template/i });
    await expect(defaultCard).toBeVisible({ timeout: 10_000 });
    await expect(defaultCard).toHaveAttribute('aria-pressed', 'true');

    // Flip to the YAML editor — the selected template must carry over into its dropdown.
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForMonaco(page);
    await expect(page.getByRole('combobox', { name: /template/i })).toHaveValue('default');
  });

  test('selecting the alt template in the simple form carries into the YAML editor', async ({ page }) => {
    await page.goto('/create');

    // Pick the non-default template.
    await page.getByRole('button', { name: /select Alt Template template/i }).click();
    await expect(page.getByRole('button', { name: /select Alt Template template/i })).toHaveAttribute('aria-pressed', 'true');

    // Toggle to YAML — the dropdown reflects the alt template, not the default.
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForMonaco(page);
    await expect(page.getByRole('combobox', { name: /template/i })).toHaveValue('alt-template');
  });

  test('changing the template in the YAML editor carries back to the simple form', async ({ page }) => {
    await page.goto('/create');
    // Default is preselected; switch to YAML and change the template there.
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForMonaco(page);

    const combobox = page.getByRole('combobox', { name: /template/i });
    await expect(combobox).toHaveValue('default');
    await combobox.fill('alt-template');
    await page.getByRole('option', { name: 'alt-template' }).click();

    // Back to the simple form — the alt template card is now the selected one.
    await page.getByRole('button', { name: /^simple form$/i }).click();
    await expect(page.getByRole('button', { name: /select Alt Template template/i })).toHaveAttribute('aria-pressed', 'true');
  });

  test('create a workspace from the alt template (for the detail + list assertions)', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('textbox', { name: /^name$/i }).fill(ALT_WS);
    await page.getByRole('textbox', { name: /display name/i }).fill(ALT_WS);
    await page.getByRole('button', { name: /select Alt Template template/i }).click();

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, ALT_WS, 'Running');
  });

  test('list card shows the template pill and the appType logo', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${ALT_WS}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Template pill = the templateRef name.
    await expect(card.getByText('alt-template', { exact: true })).toBeVisible();
    // App logo is present (decorative → located by testid).
    await expect(card.getByTestId('workspace-app-logo')).toBeVisible();
  });

  test('detail page shows Image, Template, and Idle-shutdown values', async ({ page }) => {
    await page.goto(`/workspace/${ALT_WS}`);
    await expect(page.getByRole('heading', { name: ALT_WS })).toBeVisible({ timeout: 10_000 });

    // Image pill shows the short name:tag (nginx:latest), not the full registry path.
    await expect(page.getByText('nginx:latest', { exact: true })).toBeVisible();
    // Template pill shows the ref name.
    await expect(page.getByText('alt-template', { exact: true })).toBeVisible();
    // Idle shutdown is enabled on the alt template → "30 minutes" (not "Disabled").
    await expect(page.getByText('30 minutes', { exact: true })).toBeVisible();
  });

  test('template is locked on simple edit but editable in the YAML editor', async ({ page }) => {
    // Stop first — edit requires a Stopped workspace.
    await page.goto(`/workspace/${ALT_WS}`);
    await expect(page.getByRole('heading', { name: ALT_WS })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /stop/i }).click();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 45_000 });

    // Simple edit: the template is shown read-only (no combobox to change it). The locked
    // field displays the template's DISPLAY NAME ("Alt Template"), not the ref name.
    await page.goto(`/workspace/${ALT_WS}/edit`);
    await expect(page.getByRole('heading', { name: /edit workspace/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alt Template', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /template/i })).toHaveCount(0);

    // Switch to the YAML editor — there the template IS editable (a combobox holding the
    // current ref).
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForMonaco(page);
    await expect(page.getByRole('combobox', { name: /template/i })).toHaveValue('alt-template');
  });

  test('locked-idle template: shutdown toggle is disabled and the timeout slider is bound to 30–120', async ({ page }) => {
    await page.goto('/create');
    // Select the locked-idle template (idleShutdownOverrides.allow=false, bounds 30–120).
    await page.getByRole('button', { name: /select Locked Idle Template template/i }).click();

    // The idle on/off toggle is present but DISABLED — the user can't turn idle shutdown off.
    // Idle is enabled by default on this template, so the switch is checked-but-frozen.
    const idleToggle = page.getByRole('checkbox', { name: /enable automatic shutdown when idle/i });
    await expect(idleToggle).toBeVisible();
    await expect(idleToggle).toBeDisabled();
    await expect(idleToggle).toBeChecked();

    // The timeout slider is bound to the template's min/max (30–120 min), not the default
    // 1–480. It's enabled (min !== max) so the timeout stays adjustable.
    const timeoutSlider = page.getByRole('slider', { name: /idle timeout/i });
    await expect(timeoutSlider).toBeVisible();
    await expect(timeoutSlider).toHaveAttribute('aria-valuemin', '30');
    await expect(timeoutSlider).toHaveAttribute('aria-valuemax', '120');
  });

  test('cleans up the alt-template workspace', async ({ page }) => {
    await deleteWorkspace(page, ALT_WS);
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${ALT_WS}.*workspace`, 'i'));
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: /refresh/i }).click();
          return card.isVisible().catch(() => false);
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBeFalsy();
  });
});
