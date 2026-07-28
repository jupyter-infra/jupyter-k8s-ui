import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectOnPath } from './test-utils';

// Namespace switcher E2E. The E2E server runs with WORKSPACE_NAMESPACES=default,e2e-team-b
// and SHARED_TEMPLATE_NAMESPACE=e2e-shared; the e2e-test SA has workspace RBAC in both
// namespaces and list-templates in e2e-shared (see e2e/fixtures/e2e-second-namespace.yaml
// and e2e-shared-namespace.yaml). Verifies: the switcher lists both namespaces; switching
// scopes the workspace list AND the template picker; the picker combines the active ns's
// own templates with the shared ones; a workspace created in one namespace is absent in the
// other; and the selection survives a reload.
//
// The shared template is OPT-IN (not in the always-on fixtures) — this spec needs it to
// prove the "own-ns ∪ shared" merge, so it applies e2e/fixtures/optional/shared-template.yaml
// in beforeAll and deletes it in afterAll (leaving it out is what makes e2e-team-b a
// single-flagged-default picker for single-default-template.spec.ts).
//
// Template fixtures in play:
//   - default ns: `default` (Default), `alt-template` (Alt Template) [+ others]
//   - e2e-team-b: `team-b-template` (Team B Template, flagged default)
//   - e2e-shared: `shared-template` (Shared Template, non-default) — visible EVERYWHERE
//     [applied by this spec's beforeAll]

const RUN_ID = `e2e-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ns-ws`;
const CONTEXT = `kind-${process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev'}`;
const SHARED_TEMPLATE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'optional', 'shared-template.yaml');

/** Open the namespace switcher and pick a namespace by name. */
async function switchNamespace(page: Page, ns: string) {
  await page.getByRole('button', { name: /select namespace/i }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${ns}$`) }).click();
}

/**
 * The active namespace is reflected BOTH in the switcher button label and (on the list
 * page) in the canonicalized `?namespace=` URL param. Assert both — the URL check is the
 * direct test of NamespaceContext's canonicalization.
 */
async function expectActiveNamespace(page: Page, ns: string, opts: { checkUrl?: boolean } = {}) {
  await expect(page.getByRole('button', { name: /select namespace/i })).toContainText(ns);
  if (opts.checkUrl) {
    await expectOnPath(page, { namespace: ns });
  }
}

/** A template card by its displayName (aria-label = "Select <displayName> template"). */
function templateCard(page: Page, displayName: string) {
  return page.getByRole('button', { name: new RegExp(`select ${displayName} template`, 'i') });
}

test.describe('Namespace selection', () => {
  test.describe.configure({ mode: 'serial' });

  // The shared template is opt-in; apply it for this spec's merge assertions and remove it
  // afterward so the single-flagged-default case stays reachable for other specs.
  test.beforeAll(() => {
    execFileSync('kubectl', ['--context', CONTEXT, 'apply', '-f', SHARED_TEMPLATE_FIXTURE], { stdio: 'pipe' });
  });
  test.afterAll(() => {
    execFileSync('kubectl', ['--context', CONTEXT, 'delete', '-f', SHARED_TEMPLATE_FIXTURE, '--ignore-not-found'], { stdio: 'pipe' });
  });

  test('switcher lists both accessible namespaces', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /select namespace/i }).click();
    await expect(page.getByRole('menuitem', { name: /^default$/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^e2e-team-b$/ })).toBeVisible();
  });

  test('create picker in e2e-team-b shows own-ns ∪ shared templates (and not default-ns ones)', async ({ page }) => {
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');

    await page.getByRole('button', { name: /new workspace/i }).click();
    await expect(page.getByText(/creating in e2e-team-b/i)).toBeVisible();

    // Own-namespace template (e2e-team-b) is present AND, being the flagged default, preselected.
    await expect(templateCard(page, 'Team B Template')).toBeVisible({ timeout: 10_000 });
    await expect(templateCard(page, 'Team B Template')).toHaveAttribute('aria-pressed', 'true');
    // Shared template (e2e-shared) is combined in — visible in every namespace's picker.
    await expect(templateCard(page, 'Shared Template')).toBeVisible();
    // A template that lives ONLY in the `default` namespace must NOT leak into e2e-team-b.
    await expect(templateCard(page, 'Alt Template')).toHaveCount(0);
  });

  test('creating in e2e-team-b (with the own-ns template), the workspace is absent in default', async ({ page }) => {
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');

    await page.getByRole('button', { name: /new workspace/i }).click();
    await expect(page.getByText(/creating in e2e-team-b/i)).toBeVisible();
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    // Team B Template is preselected (flagged default in e2e-team-b) — create against it.
    await page.getByRole('button', { name: /create workspace/i }).click();

    // Back on the list (in e2e-team-b), the workspace appears.
    await page.getByRole('button', { name: /^all$/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(RUN_ID);
    await expect(page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'))).toBeVisible({ timeout: 30_000 });

    // Switch to default — the workspace must NOT be there.
    await switchNamespace(page, 'default');
    await expectActiveNamespace(page, 'default');
    await page.getByRole('button', { name: /^all$/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(RUN_ID);
    await expect(page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'))).toBeHidden();
  });

  test('switching namespace changes the template set (default picker != e2e-team-b picker)', async ({ page }) => {
    // In `default`, the create picker shows default-ns templates + shared, NOT team-b's.
    await page.goto('/');
    await switchNamespace(page, 'default');
    await page.getByRole('button', { name: /new workspace/i }).click();
    await expect(templateCard(page, 'Shared Template')).toBeVisible({ timeout: 10_000 }); // shared everywhere
    await expect(templateCard(page, 'Alt Template')).toBeVisible(); // a default-ns template
    await expect(templateCard(page, 'Team B Template')).toHaveCount(0); // e2e-team-b only — not here

    // Return to the list, switch to e2e-team-b, reopen create: team-b's template appears,
    // default-ns's is gone. (Switching from /create leaves you on /create with no "New
    // workspace" button — the switch is a list-level gesture here, so go back to the list.)
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await page.getByRole('button', { name: /new workspace/i }).click();
    await expect(templateCard(page, 'Team B Template')).toBeVisible({ timeout: 10_000 });
    await expect(templateCard(page, 'Shared Template')).toBeVisible();
    await expect(templateCard(page, 'Alt Template')).toHaveCount(0);
  });

  test('selection survives a reload (persistence)', async ({ page }) => {
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');

    await page.reload();
    // URL canonicalization + cookie both restore e2e-team-b — assert the label AND the
    // canonicalized ?namespace= param survived the reload.
    await expectActiveNamespace(page, 'e2e-team-b', { checkUrl: true });
    await page.getByRole('button', { name: /^all$/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(RUN_ID);
    await expect(page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'))).toBeVisible({ timeout: 30_000 });
  });

  test('cleanup: delete the test workspace', async ({ page }) => {
    await page.goto('/?namespace=e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');
    await page.getByRole('button', { name: /^all$/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(RUN_ID);
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    if (await card.isVisible().catch(() => false)) {
      await card.getByRole('button', { name: /more options/i }).click();
      await page.getByRole('menuitem', { name: /delete/i }).click();
      await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
      await page.getByRole('button', { name: /^delete$/i }).click();
    }
  });
});
