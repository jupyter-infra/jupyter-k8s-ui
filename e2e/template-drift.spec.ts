import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Template DRIFT on edit: a template's defaultImage can change AFTER a workspace was created,
// leaving the workspace's stored image no longer permitted by the (now-different) template.
// The operator's whole-spec revalidation re-checks EVERY field on any edit, so a save would
// be rejected unless the UI conforms the stored image to the current default first.
//
// This is the only place the conform-on-load → whole-spec-revalidation interaction can be
// verified end to end (unit tests cover the conform logic, but not that the operator then
// admits the conformed save). We use a dedicated FIXED-image fixture and mutate its
// defaultImage mid-test with `kubectl patch`, restoring it afterward (afterAll runs even on
// failure), so no other spec sees the drift.

const RUN_ID = `e2e-drift-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;
const CONTEXT = `kind-${process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev'}`;
const TEMPLATE = 'fixed-image-drift-template';
const ORIGINAL_IMAGE = 'nginx:latest';
const DRIFTED_IMAGE = 'nginx:1.27';

function setTemplateDefaultImage(image: string) {
  execFileSync(
    'kubectl',
    ['--context', CONTEXT, 'patch', 'workspacetemplate', TEMPLATE, '-n', 'default', '--type', 'merge', '-p', JSON.stringify({ spec: { defaultImage: image } })],
    { stdio: 'pipe' },
  );
}

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

test.describe('Template drift on edit', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await deleteWorkspace(page, WS_NAME);
    await page.close();
  });

  // Restore the template's original image unconditionally, in its own fixture-less hook so a
  // browser-launch failure in the cleanup above can't leave the fixture drifted for later runs.
  test.afterAll(() => setTemplateDefaultImage(ORIGINAL_IMAGE));

  test('create a workspace against the fixed-image template (pins nginx:latest)', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    await page.getByRole('button', { name: /select Fixed Image Drift Template template/i }).click();

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });
    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, WS_NAME, 'Running');
  });

  test('stop, drift the template image, then editing conforms the stored image and saves', async ({ page }) => {
    // Stop first — edit requires a Stopped workspace.
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /stop/i }).click();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 45_000 });

    // Drift the template: its fixed image is now nginx:1.27, so the workspace's stored
    // nginx:latest is no longer permitted.
    setTemplateDefaultImage(DRIFTED_IMAGE);

    // Open the simple editor — conform-on-load rewrites the stored image to the template's
    // new default and discloses it in the banner.
    await page.goto(`/workspace/${WS_NAME}/edit`);
    await expect(page.getByRole('heading', { name: /edit workspace/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/adjusted to fit its template/i)).toBeVisible();
    await expect(page.getByText(new RegExp(`Image changed from "${ORIGINAL_IMAGE}" to "${DRIFTED_IMAGE}"`))).toBeVisible();

    // Save must send the conformed image — otherwise the operator's whole-spec revalidation
    // rejects the (stored, now-disallowed) image. A clean navigation to '/' proves it admitted.
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    // Detail confirms the conformed image actually persisted.
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(DRIFTED_IMAGE, { exact: true })).toBeVisible();
  });
});
