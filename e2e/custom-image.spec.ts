import { test, expect, type Page } from '@playwright/test';

// Free-solo image path: a template with allowCustomImages:true AND a curated allowedImages
// list (e2e/fixtures/custom-image-template.yaml). The image control must be an editable
// combobox that (a) offers the allowedImages as suggestions and (b) still accepts any typed
// value — regression coverage for the resolver/guidance bugs that dropped allowedImages
// whenever allowCustomImages was set. Runs against the real cluster.

const RUN_ID = `e2e-img-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

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

test.describe('Custom-image (free-solo) template', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await deleteWorkspace(page, WS_NAME);
    await page.close();
  });

  test('image field is an editable combobox offering the template suggestions', async ({ page }) => {
    await page.goto('/create');

    // Select the custom-image template (default is preselected; this is a non-default card).
    await page.getByRole('button', { name: /select Custom Image Template template/i }).click();

    // allowCustomImages → the image control is a free-solo combobox (editable), NOT a plain
    // select. Its suggestions include the template's allowedImages.
    const imageField = page.getByRole('combobox', { name: /image/i });
    await expect(imageField).toBeVisible();
    await expect(imageField).toBeEditable();

    // Opening it surfaces the curated suggestions (nginx:1.27 is in allowedImages).
    await imageField.click();
    await expect(page.getByRole('option', { name: 'nginx:1.27' })).toBeVisible({ timeout: 10_000 });
  });

  test('accepts a typed custom image and creates a Running workspace with it', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    await page.getByRole('button', { name: /select Custom Image Template template/i }).click();

    // Type an image NOT in the suggestion list — free-solo must accept it. Use a real,
    // pullable image so the workspace actually reaches Running (nginx:1.27 is allowed +
    // available on the cluster).
    const imageField = page.getByRole('combobox', { name: /image/i });
    await imageField.fill('nginx:1.27');

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, WS_NAME, 'Running');

    // The typed image landed on the workspace (detail pill shows the short name:tag).
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('nginx:1.27', { exact: true })).toBeVisible();
  });
});
