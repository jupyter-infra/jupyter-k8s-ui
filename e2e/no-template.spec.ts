import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// No-template create flow: when NO WorkspaceTemplate is flagged the default, the picker
// renders a "No template" card (preselected) and creating from it produces a bare workspace
// — static bounds, free image, and NO templateRef. This is a first-class picker outcome and
// the path tied to the unbound-PVC bug (jupyter-deploy#321), so it earns live coverage.
//
// The other specs rely on `default` being the flagged default, so we UNFLAG it for this
// file only (beforeAll) and RESTORE it (afterAll, runs even on failure). Playwright runs
// files serially (workers:1), and each test uses a fresh page (fresh React Query cache), so
// the unflag is observed and doesn't leak across files.
//
// Storage: a plain `kind` cluster ships the `standard` StorageClass as default, so a
// no-template workspace's empty-storageClass PVC binds and the workspace reaches Running
// without a storageClass override.

const RUN_ID = `e2e-notmpl-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;
const CONTEXT = `kind-${process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev'}`;

function setDefaultFlag(value: 'true' | 'false') {
  execFileSync(
    'kubectl',
    ['--context', CONTEXT, 'label', 'workspacetemplate', 'default', '-n', 'default', `workspace.jupyter.org/default-template=${value}`, '--overwrite'],
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

test.describe('No-template create', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => setDefaultFlag('false'));

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await deleteWorkspace(page, WS_NAME);
    await page.close();
  });

  // Restore the flagged default in its OWN fixture-less afterAll so it runs unconditionally
  // — the workspace-cleanup hook above takes the `browser` fixture, and if the browser fails
  // to launch that hook body never runs, leaving `default` unflagged and breaking every
  // later run (the advanced-editor create test needs a default template injected). This hook
  // touches no fixtures, so it always executes.
  test.afterAll(() => setDefaultFlag('true'));

  test('picker shows the No-template card and preselects it (no default flagged)', async ({ page }) => {
    await page.goto('/create');

    // With no default flagged, the "No template" card is present and selected on load.
    const noTemplateCard = page.getByRole('button', { name: /select No template template/i });
    await expect(noTemplateCard).toBeVisible({ timeout: 10_000 });
    await expect(noTemplateCard).toHaveAttribute('aria-pressed', 'true');

    // Free image entry: no template → the image control is an editable combobox (not a
    // strict select), empty by default.
    const imageField = page.getByRole('combobox', { name: /image/i });
    await expect(imageField).toBeVisible();
    await expect(imageField).toBeEditable();

    // No template → no idle-shutdown source (the form can't infer detection), so the idle
    // toggle is not rendered at all.
    await expect(page.getByRole('checkbox', { name: /enable automatic shutdown when idle/i })).toHaveCount(0);

    // No template + empty image is unstartable → the Create button is disabled until an
    // image is typed (the edge Gaurav caught: no templateRef AND no image = can't start).
    const createBtn = page.getByRole('button', { name: /create workspace/i });
    await expect(createBtn).toBeDisabled();
    await imageField.fill('nginx:latest');
    await expect(createBtn).toBeEnabled();
  });

  test('creates a bare workspace (typed image, no templateRef) that reaches Running', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    // No-template card is preselected; type an image (free field is empty otherwise, which
    // would give a workspace with no image that can't start).
    await page.getByRole('combobox', { name: /image/i }).fill('nginx:latest');

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, WS_NAME, 'Running');
  });

  test('the bare workspace has NO template (detail shows "none")', async ({ page }) => {
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });

    // Detail Template pill reads "none" for a no-template workspace; the typed image landed.
    await expect(page.getByText('none', { exact: true })).toBeVisible();
    await expect(page.getByText('nginx:latest', { exact: true })).toBeVisible();
  });
});
