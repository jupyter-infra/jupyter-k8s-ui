import { test, expect, type Page } from '@playwright/test';
import { expectOnPath } from './test-utils';

// Single-flagged-default template create flow. When a namespace's ONLY template is flagged
// the default, the simple create picker renders NOTHING (no card grid, no "No template"
// card) and silently auto-adopts that template — the user can't switch it. In its place the
// form shows a read-only, locked Template section. This is a distinct UI branch
// (TemplatePicker's `hidden` case) that no other E2E reaches, because they all see ≥2
// templates once the shared template is present.
//
// We reach the single-default state via `e2e-team-b`: its only own template is
// `team-b-template` (Team B Template, flagged default), and the shared template is opt-in
// (absent from the always-on fixtures — namespace-switch.spec.ts applies it only for its own
// run and deletes it after). So in e2e-team-b the picker sees exactly one flagged default.

const RUN_ID = `e2e-single-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;
const NS = 'e2e-team-b';
const TEMPLATE_DISPLAY = 'Team B Template';
const TEMPLATE_REF = 'team-b-template';

/**
 * Switch the active namespace via the switcher. Unlike a `?namespace=` deep link (ephemeral,
 * lost on the next navigation), the switcher PATCHes the activeNs cookie, so the selection
 * survives the post-create redirect to the list.
 */
async function switchNamespace(page: Page, ns: string) {
  await page.getByRole('button', { name: /select namespace/i }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${ns}$`) }).click();
  await expect(page.getByRole('button', { name: /select namespace/i })).toContainText(ns);
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
  await page.goto(`/?namespace=${NS}`);
  await page.getByRole('button', { name: /all/i }).click();
  const card = page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
  if (!(await card.isVisible().catch(() => false))) return;
  await card.getByRole('button', { name: /more options/i }).click();
  await page.getByRole('menuitem', { name: /delete/i }).click();
  await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
  await page.getByRole('button', { name: /delete/i }).click();
}

test.describe('Single-flagged-default template create', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await deleteWorkspace(page, WS_NAME);
    await page.close();
  });

  test('picker is hidden (no grid, no "No template" card); a locked Template section shows the enforced template', async ({ page }) => {
    await page.goto(`/create?namespace=${NS}`);
    await expect(page.getByText(/creating in e2e-team-b/i)).toBeVisible();

    // The enforced template's display name shows in a read-only Template section.
    await expect(page.getByText(TEMPLATE_DISPLAY, { exact: true })).toBeVisible({ timeout: 10_000 });

    // The distinguishing signal of the hidden branch: NO selectable template cards at all
    // (not the flagged default's own card, not a "No template" card) — the picker didn't
    // render a grid.
    await expect(page.getByRole('button', { name: /select .* template/i })).toHaveCount(0);

    // The image control still reflects the enforced template's allowedImages (a select seeded
    // with its defaultImage), proving the template was adopted, not merely displayed.
    await expect(page.getByRole('combobox', { name: /image/i })).toBeVisible();
  });

  test('create auto-uses the enforced template (workspace reaches Running with its templateRef)', async ({ page }) => {
    // Switch via the switcher (persists the active ns in the cookie) so the post-create
    // redirect to the list stays in e2e-team-b — a `?namespace=` deep link would be dropped.
    await page.goto('/');
    await switchNamespace(page, NS);

    await page.getByRole('button', { name: /new workspace/i }).click();
    await expect(page.getByText(/creating in e2e-team-b/i)).toBeVisible();
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);

    // No template to pick — just create. The hidden picker already adopted team-b-template.
    await page.getByRole('button', { name: /create workspace/i }).click();
    await expectOnPath(page, { namespace: NS });

    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, WS_NAME, 'Running');

    // Detail confirms the enforced template rode onto the workspace (Template pill = ref name).
    await page.goto(`/workspace/${WS_NAME}?namespace=${NS}`);
    await expect(page.getByRole('heading', { name: WS_NAME })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(TEMPLATE_REF, { exact: true })).toBeVisible();
  });
});
