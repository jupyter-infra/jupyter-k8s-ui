import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Idle-override DRIFT on edit: a template can flip from permissive (idle optional) to
// REQUIRED (idleShutdownOverrides.allow=false + an enabled default) AFTER a workspace was
// created with idle off. The operator's structural lock then rejects that workspace's stored
// (disabled) idleShutdown on any edit — and the simple editor freezes the toggle, so the user
// can't fix it by hand. conform-on-load must force idleShutdown.enabled → true and disclose
// it, so the save is admitted.
//
// This is the idle counterpart to template-drift.spec.ts (image drift). We use a dedicated
// `idle-drift-template` fixture and flip its overrides mid-test with `kubectl patch`,
// restoring the permissive state afterward (afterAll runs even on failure).

const RUN_ID = `e2e-idledrift-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;
const CONTEXT = `kind-${process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev'}`;
const TEMPLATE = 'idle-drift-template';

// Merge-patch the template's idle policy. Merge semantics preserve sibling fields (timeout,
// detection, min/max), so we only set the two knobs that induce / undo the drift.
function patchIdlePolicy(allow: boolean, defaultEnabled: boolean) {
  const patch = { spec: { defaultIdleShutdown: { enabled: defaultEnabled }, idleShutdownOverrides: { allow } } };
  execFileSync('kubectl', ['--context', CONTEXT, 'patch', 'workspacetemplate', TEMPLATE, '-n', 'default', '--type', 'merge', '-p', JSON.stringify(patch)], {
    stdio: 'pipe',
  });
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

test.describe('Idle-override drift on edit', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await deleteWorkspace(page, WS_NAME);
    await page.close();
  });

  // Restore the permissive policy unconditionally, in its own fixture-less hook so a
  // browser-launch failure above can't leave the template locked for later runs.
  test.afterAll(() => patchIdlePolicy(true, false));

  test('create a workspace with idle OFF under the (permissive) template', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    await page.getByRole('button', { name: /select Idle Drift Template template/i }).click();

    // Idle is disabled by default on this template and overrides are allowed → the toggle is
    // interactive and off. Leave it off.
    const toggle = page.getByRole('checkbox', { name: /enable automatic shutdown when idle/i });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });
    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, WS_NAME, 'Running');

    // Confirm the stored state is idle-off.
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
  });

  test('drift the template to REQUIRE idle, then editing conforms enabled→on and saves', async ({ page }) => {
    // Stop first — edit requires a Stopped workspace.
    await page.goto(`/workspace/${WS_NAME}`);
    await page.getByRole('button', { name: /stop/i }).click();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 45_000 });

    // Flip the template: idle is now REQUIRED (allow:false) with an enabled default. The
    // workspace's stored idle-off block now violates the operator's structural lock.
    patchIdlePolicy(false, true);

    await page.goto(`/workspace/${WS_NAME}/edit`);
    await expect(page.getByRole('heading', { name: /edit workspace/i })).toBeVisible({ timeout: 10_000 });

    // conform-on-load forces idle on and discloses it in the banner; the toggle is frozen ON.
    await expect(page.getByText(/adjusted to fit its template/i)).toBeVisible();
    // Match a stable fragment of the conform copy (idleShutdownEnable banner) rather than
    // the full sentence, so wording tweaks don't break the assertion.
    await expect(page.getByText(/idle shutdown was enabled/i)).toBeVisible();
    const toggle = page.getByRole('checkbox', { name: /enable automatic shutdown when idle/i });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeDisabled();

    // Save must send the conformed enabled block or the operator's structural lock rejects it.
    // A clean navigation to '/' proves it admitted.
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    // Detail confirms idle is now enabled (shows a timeout, not "Disabled").
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/\d+ minutes/)).toBeVisible();
  });
});
