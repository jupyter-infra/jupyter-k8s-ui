import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';

// Unique prefix per run to avoid collisions with other specs / prior runs.
const RUN_ID = `e2e-adv-${Date.now()}`;

/**
 * Replace the Monaco editor's contents. Monaco owns the DOM, so `fill()` won't work —
 * focus the editor, select-all, delete, then type. Waits briefly for the language
 * worker to catch up afterward.
 */
async function setEditorYaml(page: Page, yaml: string) {
  // Set the buffer via Monaco's own model API rather than simulated keystrokes:
  // focus()+Ctrl+A+type proved unreliable headless (the select-all didn't catch, so
  // the original scaffold got submitted unchanged). Driving the model is deterministic.
  // Wait for window.monaco + a model to exist first (set on editor mount, may lag the
  // textarea being attached), then setValue — which fires onDidChangeModelContent so
  // React's onChange runs.
  await page.waitForFunction(
    () => {
      const w = window as unknown as { monaco?: { editor: { getModels(): unknown[] } } };
      return (w.monaco?.editor.getModels().length ?? 0) > 0;
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate((text) => {
    const w = window as unknown as { monaco?: { editor: { getModels(): Array<{ setValue(v: string): void }> } } };
    w.monaco!.editor.getModels()[0].setValue(text);
  }, yaml);
  await page.waitForTimeout(500);
}

/** Read the editor buffer via Monaco's model API (the reliable full-content source). */
async function getEditorYaml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { monaco?: { editor: { getModels(): Array<{ getValue(): string }> } } };
    return w.monaco?.editor.getModels()[0]?.getValue() ?? '';
  });
}

/**
 * Wait for the Monaco editor to be mounted and interactive. We key off the editor's
 * hidden <textarea> being ATTACHED (not "visible" — Monaco's `.view-lines` is
 * `aria-hidden` with zero measured size until content paints, so a visibility wait
 * flakes). The textarea is the real input target the other helpers focus.
 */
async function waitForEditor(page: Page) {
  await page.locator('.monaco-editor textarea').first().waitFor({ state: 'attached', timeout: 20_000 });
}

/** Click Refresh on the list until the named card shows the expected status. */
async function waitForCardStatus(page: Page, name: string, statusText: string) {
  const card = page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
  // Match the status badge EXACTLY: getByText's default substring match would also
  // hit the card's description line (the resource name ends in "-stopped"), and the
  // resulting strict-mode violation would be swallowed by the catch below — so the
  // poll would never go truthy for a Stopped workspace.
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

/**
 * Open the advanced create editor. There is no `/create-advanced` route anymore — the
 * YAML editor is an inline toggle on the `/create` page (the simple form and the editor
 * share the Name/Display name fields above them). Navigate to /create and flip the toggle.
 */
async function openAdvancedCreate(page: Page) {
  await page.goto('/create');
  await page.getByRole('button', { name: /^yaml editor$/i }).click();
  await waitForEditor(page);
}

/** Set the run-unique name via the Name field, mirroring displayName so cards are findable. */
async function fillIdentity(page: Page, name: string) {
  // Type the Name first, then overwrite Display name so the card aria-label
  // ("{displayName} workspace, …") matches the run-unique name (the two fields are
  // linked: Display name -> Name derivation, but here we set both explicitly).
  await page.getByRole('textbox', { name: /^name$/i }).fill(name);
  await page.getByRole('textbox', { name: /display name/i }).fill(name);
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

test.describe('Advanced YAML editor', () => {
  test.describe.configure({ mode: 'serial' });

  // --- Editor core: create, edit, and local (syntax + schema) validation ---

  test('create via advanced editor reaches Running', async ({ page }) => {
    const name = `${RUN_ID}-create`;
    await openAdvancedCreate(page);

    // displayName === name (set via the Display name field, no longer in the buffer) so
    // the card's aria-label ("{displayName} workspace, …") is findable by the run name.
    await fillIdentity(page, name);
    await setEditorYaml(page, 'desiredStatus: Running\n');

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    await page.getByRole('button', { name: /all/i }).click();
    await expect(page.getByLabel(new RegExp(`${name}.*workspace`, 'i'))).toBeVisible({ timeout: 10_000 });
    await waitForCardStatus(page, name, 'Running');
  });

  test('editing a Running workspace is blocked (direct URL does not restart it)', async ({ page }) => {
    // The Edit affordances are hidden while Running, but the route is reachable directly
    // (saved link / history). The page must refuse to edit a running workspace — saving
    // a spec change would restart the pod and drop the user's session.
    const name = `${RUN_ID}-create`;
    await page.goto(`/workspace/${name}/edit`);

    await expect(page.getByText(/stop the workspace before editing/i)).toBeVisible({ timeout: 10_000 });
    // The editor must not render, so there's nothing to save.
    await expect(page.getByRole('textbox', { name: /display name/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /save changes/i })).toHaveCount(0);
  });

  test('stop the workspace so the remaining edit tests can run', async ({ page }) => {
    const name = `${RUN_ID}-create`;
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: /stop/i }).click();
    await waitForCardStatus(page, name, 'Stopped');
  });

  test('edit route pre-populates the fields and freezes the name', async ({ page }) => {
    const name = `${RUN_ID}-create`;
    await page.goto(`/workspace/${name}/edit`);
    await waitForEditor(page);

    // Name control is present but disabled (K8s names are immutable).
    const nameField = page.getByRole('textbox', { name: /^name$/i });
    await expect(nameField).toHaveValue(name);
    await expect(nameField).toBeDisabled();

    // displayName is lifted OUT of the buffer into its own field (no longer in the YAML).
    await expect(page.getByRole('textbox', { name: /display name/i })).toHaveValue(name);
    // The rest of the resolved spec is seeded into the buffer (read via the model API).
    await expect.poll(async () => getEditorYaml(page), { timeout: 10_000 }).toContain('desiredStatus');
  });

  test('edit changes displayName and persists', async ({ page }) => {
    const name = `${RUN_ID}-create`;
    await page.goto(`/workspace/${name}/edit`);
    await waitForEditor(page);

    // displayName is edited via its field now, not the YAML buffer.
    await page.getByRole('textbox', { name: /display name/i }).fill('Renamed Adv');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });

    // Detail page reflects the new displayName after refetch.
    await page.goto(`/workspace/${name}`);
    await expect(page.getByRole('heading', { name: /Renamed Adv/i })).toBeVisible({ timeout: 10_000 });
  });

  test('YAML syntax error blocks save', async ({ page }) => {
    await openAdvancedCreate(page);
    await fillIdentity(page, `${RUN_ID}-syntax`);

    // Broken YAML (bad indentation / stray colons).
    await setEditorYaml(page, 'desiredStatus: Running\n  bad: : :\n');
    await expect(page.getByRole('button', { name: /create workspace/i })).toBeDisabled();
  });

  test('CRD schema error on a bad enum blocks save', async ({ page }) => {
    await openAdvancedCreate(page);
    await fillIdentity(page, `${RUN_ID}-schema`);

    // desiredStatus only accepts Running/Stopped — Frozen is a schema violation.
    await setEditorYaml(page, 'desiredStatus: Frozen\n');
    // Wait for the language worker to flag it, then Save must be disabled.
    await expect(page.getByRole('button', { name: /create workspace/i })).toBeDisabled({ timeout: 10_000 });
  });

  // --- Server dry-run validation (authoritative) ---

  test('dry-run rejects an invalid manifest with the operator message, then fixes', async ({ page }) => {
    await openAdvancedCreate(page);
    await fillIdentity(page, `${RUN_ID}-dryrun`);

    // Image not in the template's allowedImages -> validating webhook rejects.
    await setEditorYaml(page, 'image: evil/not-allowed:latest\n');
    await page.getByRole('button', { name: /^validate$/i }).click();

    // The webhook's own message is surfaced (not just a generic status).
    await expect(page.getByText(/not permitted|not allowed|validation/i)).toBeVisible({ timeout: 15_000 });

    // Fix to an allowed image -> validation passes.
    await setEditorYaml(page, 'image: nginx:latest\n');
    await page.getByRole('button', { name: /^validate$/i }).click();
    await expect(page.getByText(/validation passed/i)).toBeVisible({ timeout: 15_000 });
  });

  test('Validate does not create a resource', async ({ page }) => {
    const name = `${RUN_ID}-novalidate`;
    await openAdvancedCreate(page);
    await fillIdentity(page, name);
    await setEditorYaml(page, 'desiredStatus: Running\n');

    await page.getByRole('button', { name: /^validate$/i }).click();
    await expect(page.getByText(/validation passed/i)).toBeVisible({ timeout: 15_000 });

    // The workspace must NOT exist — dry-run never persists.
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    await page.getByRole('textbox', { name: /search workspaces/i }).fill(name);
    await expect(page.getByText(/no workspaces found/i)).toBeVisible();
  });

  // --- Template discovery + guidance ---

  test('template guidance panel lists the default template bounds', async ({ page }) => {
    await openAdvancedCreate(page);

    // Select the seeded default template from the dropdown.
    await page.getByRole('combobox', { name: /template/i }).fill('default');
    await page.getByRole('option', { name: 'default' }).click();

    // The guidance panel shows the "Bounds" section with Images + a Resources range.
    // (Scope text assertions to unique panel labels — the image also appears in the
    // scaffold buffer, so an unscoped image match would be ambiguous.)
    await expect(page.getByText('Bounds', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Images', { exact: true })).toBeVisible();
    await expect(page.getByText('Resources', { exact: true })).toBeVisible();
    // CPU bound from the fixture template. Label and value render in separate grid
    // cells ("CPU:" | "[100m, 2]"), so assert each independently.
    await expect(page.getByText('CPU:', { exact: true })).toBeVisible();
    await expect(page.getByText('[100m, 2]', { exact: true })).toBeVisible();
  });

  test('image-not-allowed shows an advisory warning but does not block save', async ({ page }) => {
    await openAdvancedCreate(page);
    await fillIdentity(page, `${RUN_ID}-warn`);

    await page.getByRole('combobox', { name: /template/i }).fill('default');
    await page.getByRole('option', { name: 'default' }).click();

    // An image outside the template allowlist -> advisory warning, Save still enabled.
    // (The template switch after edits may prompt to regenerate — keep our edits.)
    await setEditorYaml(page, 'image: some/other:tag\n');
    await expect(page.getByText(/allowed list|isn't in template/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /create workspace/i })).toBeEnabled();
  });

  // --- Inline form <-> YAML toggle (create page) ---

  test('toggling to the YAML editor preserves the name/display name already entered', async ({ page }) => {
    const name = `${RUN_ID}-toggle`;
    await page.goto('/create');
    // Fill identity on the simple form, then switch to YAML — the fields carry over.
    await page.getByRole('textbox', { name: /^name$/i }).fill(name);
    await page.getByRole('textbox', { name: /display name/i }).fill('Toggle Kept');

    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForEditor(page);

    await expect(page.getByRole('textbox', { name: /^name$/i })).toHaveValue(name);
    await expect(page.getByRole('textbox', { name: /display name/i })).toHaveValue('Toggle Kept');
  });

  test('switching back to the simple form is immediate while the buffer is pristine', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForEditor(page);

    // No hand-edits yet -> switching back goes straight to the form, no discard prompt.
    await page.getByRole('button', { name: /^simple form$/i }).click();
    await expect(page.getByText('Resources', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /create workspace/i })).toBeVisible();
  });

  test('switching back to the simple form with a dirty buffer prompts before discarding', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    await waitForEditor(page);

    // A genuine keystroke marks the buffer dirty. The model-API setValue fires
    // isFlush=true (treated as programmatic), and merely focusing Monaco's hidden
    // <textarea> does NOT place a cursor — the keystrokes go nowhere. Click into the
    // visible content area (.view-lines) so Monaco positions the caret, then type.
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.type('# edit');

    // A discard confirmation appears; cancelling keeps us in the editor. Assert on the
    // dialog's title heading specifically — the body text also contains "discard", so an
    // unscoped getByText would match two elements (strict-mode violation).
    await page.getByRole('button', { name: /^simple form$/i }).click();
    await expect(page.getByRole('heading', { name: /discard yaml edits/i })).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await waitForEditor(page);

    // Confirming the discard returns to the simple form (Resources section visible).
    await page.getByRole('button', { name: /^simple form$/i }).click();
    await page.getByRole('button', { name: /discard & switch/i }).click();
    await expect(page.getByText('Resources', { exact: true })).toBeVisible();
  });

  // Clean up any workspaces this spec created.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    for (const suffix of ['create']) {
      await deleteWorkspace(page, `${RUN_ID}-${suffix}`).catch(() => {});
    }
    await page.close();
  });
});

// Entry points into the advanced editor + the external links that lead out of it.
// These need a STOPPED workspace to exercise the Edit affordances (owner + Stopped gate).
test.describe('Advanced editor — entry points', () => {
  test.describe.configure({ mode: 'serial' });

  const STOPPED_WS = `${RUN_ID}-stopped`;

  // Create a workspace that settles to Stopped so the Edit buttons appear.
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await openAdvancedCreate(page);
    // displayName === name so the card is findable by name (aria-label uses displayName).
    await fillIdentity(page, STOPPED_WS);
    await setEditorYaml(page, 'desiredStatus: Stopped\n');
    const createBtn = page.getByRole('button', { name: /create workspace/i });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });
    await page.getByRole('button', { name: /all/i }).click();
    await waitForCardStatus(page, STOPPED_WS, 'Stopped');
    await page.close();
  });

  // 1/ Detail page Edit button (Stopped WS) -> edit page
  test('detail-page Edit button navigates to the edit editor', async ({ page }) => {
    await page.goto(`/workspace/${STOPPED_WS}`);
    await expect(page.getByRole('heading', { name: STOPPED_WS })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('link', { name: /^edit$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${STOPPED_WS}/edit`));
    await waitForEditor(page);
  });

  // 2/ Card 3-dot menu Edit item -> edit page
  test('card overflow-menu Edit item navigates to the edit editor', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${STOPPED_WS}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByRole('button', { name: /more options/i }).click();
    await page.getByRole('menuitem', { name: /^edit$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${STOPPED_WS}/edit`));
    await waitForEditor(page);
  });

  // 3/ Card footer Edit button -> edit page
  test('card footer Edit button navigates to the edit editor', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${STOPPED_WS}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The footer Edit is a button directly on the card (not inside the menu).
    await card.getByRole('button', { name: /^edit$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${STOPPED_WS}/edit`));
    await waitForEditor(page);
  });

  // 4/ Create page "YAML editor" button -> reveals the inline editor (stays on /create)
  test('create-page YAML editor button reveals the advanced create editor inline', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('button', { name: /^yaml editor$/i }).click();
    // No route change — the editor replaces the sliders in place.
    await expect(page).toHaveURL(/\/create$/);
    await waitForEditor(page);
  });

  // 5/ kubectl link from the advanced box -> kubectl page loads
  test('create-page kubectl link opens the kubectl access page', async ({ page }) => {
    await page.goto('/create');
    // Scope to the advanced box's "use kubectl" link — the layout nav also links to
    // /kubectl, so an unscoped /kubectl/i match would be ambiguous.
    await page.getByRole('link', { name: /use kubectl/i }).click();
    await expect(page).toHaveURL(/\/kubectl$/);
    await expect(page.getByRole('heading', { name: /kubectl access/i })).toBeVisible({ timeout: 10_000 });
  });

  // 6/ documentation (CRD reference) link -> resolves 200. It's an external link
  // (opens a new tab), so we fetch its href directly rather than navigate.
  test('create-page CRD reference link points at a reachable doc', async ({ page }) => {
    await page.goto('/create');
    const href = await page.getByRole('link', { name: /crd reference/i }).getAttribute('href');
    expect(href).toBeTruthy();

    const ctx = await playwrightRequest.newContext();
    const res = await ctx.get(href!);
    expect(res.status()).toBe(200);
    await ctx.dispose();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await deleteWorkspace(page, STOPPED_WS).catch(() => {});
    await page.close();
  });
});
