import { test, expect, type Locator, type Page } from '@playwright/test';

// Template-aware simple create + simple edit, exercised against the real cluster with the
// e2e template fixtures. The `default` fixture (e2e/fixtures/default-template.yaml) is the
// flagged default (cpu 0.1–2, mem 0.125–2Gi, storage 1–10Gi, image select nginx:*); with
// the `alt-template` fixture also present the picker renders a card grid PRESELECTING the
// flagged default. These tests assert the resolver-driven controls that follow from that
// auto-selection, not the picking itself (covered by template-select.spec.ts).

const RUN_ID = `e2e-tmpl-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

async function waitForCardStatus(page: Page, card: Locator, text: string) {
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: /refresh/i }).click();
        return card
          .getByText(text, { exact: true })
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBeTruthy();
}

test.describe('Template-aware simple create + edit', () => {
  test.describe.configure({ mode: 'serial' });

  test('create is driven by the flagged default template (image select + template bounds)', async ({ page }) => {
    await page.goto('/create');

    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);

    // The template's allowedImages (2 nginx images, no custom) → the image control renders
    // as a select, not a free-text box. Its default is the template's defaultImage.
    const imageField = page.getByRole('combobox', { name: /image/i });
    await expect(imageField).toBeVisible();

    // The `default` template has NO defaultIdleShutdown → the simple form can't author idle
    // (no detection to echo), so the idle toggle is not rendered at all.
    await expect(page.getByRole('checkbox', { name: /enable automatic shutdown when idle/i })).toHaveCount(0);

    // Submit — the operator resolves the (auto-used) default template and admits.
    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await waitForCardStatus(page, card, 'Running');

    // The default template's appType is `jupyterlab` → the branded Jupyter SVG renders (not
    // the neutral fallback). Asserting on the branded-SVG testid verifies the logo registry
    // actually resolved, not merely that the logo wrapper box exists.
    await expect(card.getByTestId('app-type-logo-svg')).toBeVisible();

    // WYSIWYG: the template's default image the form displayed actually landed on the
    // created workspace (detail page shows the short name:tag pill).
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('nginx:latest', { exact: true })).toBeVisible();
  });

  test('simple edit adjusts resources within template bounds and saves', async ({ page }) => {
    // Stop first — edit requires a Stopped workspace (owner + Stopped guard).
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /stop/i }).click();
    // Status renders as a chip on the detail page (not a heading); match its exact text.
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 45_000 });

    // Go to the edit page — it defaults to the simple (slider) editor.
    await page.goto(`/workspace/${WS_NAME}/edit`);
    await expect(page.getByRole('heading', { name: /edit workspace/i })).toBeVisible({ timeout: 10_000 });

    // Name is read-only (immutable); the CPU slider is present and bounded by the template.
    const cpuSlider = page.getByRole('slider', { name: /cpu/i });
    await expect(cpuSlider).toBeVisible();
    // Storage is read-only on edit — no storage slider.
    await expect(page.getByRole('slider', { name: /storage/i })).toHaveCount(0);

    // Nudge CPU and save.
    await cpuSlider.focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: /save changes/i }).click();

    // Saves via selective PATCH and navigates to the list (no auto-start → stays Stopped).
    await expect(page).toHaveURL('/', { timeout: 10_000 });
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await waitForCardStatus(page, card, 'Stopped');
  });

  test('edit page can switch to the YAML editor', async ({ page }) => {
    await page.goto(`/workspace/${WS_NAME}/edit`);
    await expect(page.getByRole('heading', { name: /edit workspace/i })).toBeVisible({ timeout: 10_000 });

    // The Advanced box's "YAML editor" button switches to the Monaco editor (single path to YAML).
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await page.locator('.monaco-editor textarea').first().waitFor({ state: 'attached', timeout: 20_000 });
  });

  test('deletes the workspace', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByRole('button', { name: /more options/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
    await page.getByRole('button', { name: /delete/i }).click();

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
