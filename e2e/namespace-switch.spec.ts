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
const DEEPLINK_WS_NAME = `${RUN_ID}-deeplink`;
const CONTEXT = `kind-${process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev'}`;
const SHARED_TEMPLATE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'optional', 'shared-template.yaml');
const SECOND_NAMESPACE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'e2e-second-namespace.yaml');

/**
 * RBAC changes reach the API server's authorizer a moment after the RoleBinding write; wait
 * until `kubectl auth can-i` gives the expected answer for the e2e user in e2e-team-b before
 * loading the app.
 */
async function waitForTeamBAccess(allowed: boolean) {
  await expect
    .poll(
      () => {
        try {
          return execFileSync(
            'kubectl',
            [
              '--context',
              CONTEXT,
              'auth',
              'can-i',
              'list',
              'workspaces.workspace.jupyter.org',
              '--as=system:serviceaccount:default:e2e-test',
              '-n',
              'e2e-team-b',
            ],
            { stdio: 'pipe' },
          )
            .toString()
            .trim();
        } catch {
          return 'no';
        }
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(allowed ? 'yes' : 'no');
}

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

  // Restores e2e-team-b access right after the revoke test, since the cleanup test needs it.
  let teamBRevoked = false;
  test.afterEach(async () => {
    if (!teamBRevoked) return;
    teamBRevoked = false;
    execFileSync('kubectl', ['--context', CONTEXT, 'apply', '-f', SECOND_NAMESPACE_FIXTURE], { stdio: 'pipe' });
    await waitForTeamBAccess(true);
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

  test('creating through a deep link lands back on that namespace, not the cookie one', async ({ page }) => {
    await page.goto('/');
    await switchNamespace(page, 'default');
    await expectActiveNamespace(page, 'default');

    await page.goto('/create?namespace=e2e-team-b');
    await expect(page.getByText(/creating in e2e-team-b/i)).toBeVisible();
    await page.getByRole('textbox', { name: /^name$/i }).fill(DEEPLINK_WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(DEEPLINK_WS_NAME);
    await page.getByRole('button', { name: /create workspace/i }).click();

    await expectOnPath(page, { namespace: 'e2e-team-b' });
    await expectActiveNamespace(page, 'e2e-team-b');
    await page.getByRole('button', { name: /^all$/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(DEEPLINK_WS_NAME);
    await expect(page.getByLabel(new RegExp(`${DEEPLINK_WS_NAME}.*workspace`, 'i'))).toBeVisible({ timeout: 30_000 });
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

  test('selection survives a reload (URL canonicalization)', async ({ page }) => {
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');

    await page.reload();
    // reload() keeps the canonicalized ?namespace= param, which takes precedence over the
    // cookie — so this asserts URL canonicalization survives a reload. The cookie path (bare
    // base-URL load, no param) is exercised by the next test.
    await expectActiveNamespace(page, 'e2e-team-b', { checkUrl: true });
    await page.getByRole('button', { name: /^all$/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(RUN_ID);
    await expect(page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'))).toBeVisible({ timeout: 30_000 });
  });

  test('selection survives a BARE base-URL visit (cookie persistence)', async ({ page }) => {
    // The genuine activeNs-cookie test: switch, then navigate to the bare base URL with NO
    // ?namespace= param, so nothing but the persisted cookie can restore the choice. This is
    // the path the reload test can't reach (its URL still carries the param). Regressed once
    // when SESSION_ENABLED=false left the cookie unsigned/unwritten — this guards it.
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');

    // Fresh navigation to the bare base URL — GET /my-namespace must read activeNs from the
    // cookie and the client must canonicalize back to ?namespace=e2e-team-b.
    await page.goto('/');
    await expectActiveNamespace(page, 'e2e-team-b', { checkUrl: true });
  });

  test('losing access to the active namespace drops the app back to the default one', async ({ page }) => {
    // Without the RoleBinding the workspace list returns 403, and the app recomputes the
    // visible namespaces and falls back to the default one.
    await page.goto('/');
    await switchNamespace(page, 'e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');

    execFileSync('kubectl', ['--context', CONTEXT, 'delete', 'rolebinding', 'e2e-test-binding', '-n', 'e2e-team-b'], { stdio: 'pipe' });
    teamBRevoked = true;
    await waitForTeamBAccess(false);
    await page.goto('/?namespace=e2e-team-b');
    await expectActiveNamespace(page, 'default', { checkUrl: true });
  });

  test('cleanup: delete the test workspaces', async ({ page }) => {
    await page.goto('/?namespace=e2e-team-b');
    await expectActiveNamespace(page, 'e2e-team-b');
    await page.getByRole('button', { name: /^all$/i }).click();
    for (const name of [WS_NAME, DEEPLINK_WS_NAME]) {
      await page.getByRole('textbox', { name: /search workspaces/i }).fill(name);
      const card = page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
      if (await card.isVisible().catch(() => false)) {
        await card.getByRole('button', { name: /more options/i }).click();
        await page.getByRole('menuitem', { name: /delete/i }).click();
        await expect(page.getByText(/are you sure you want to delete/i)).toBeVisible();
        await page.getByRole('button', { name: /^delete$/i }).click();
        await expect(card).toBeHidden({ timeout: 30_000 });
      }
    }
  });
});
