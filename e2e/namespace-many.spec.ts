import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Many-namespace E2E: exercises sa-list label discovery + the paginated switcher + the
// confused-deputy SSAR filter + cookie memory at scale. Creates 30 namespaces — 25 LABELED
// (workspace.jupyter.org/workspaces-enabled=true) and 5 UNLABELED. Of the 25 labeled, 20 get
// list-workspaces RBAC for the e2e-test identity and 5 are FORBIDDEN (labeled → discovery
// candidates, but NO RBAC). Then asserts:
//   - labeled+authorized namespaces are discoverable; unlabeled ones never appear;
//   - the confused-deputy filter: a FORBIDDEN namespace (a real candidate the SA sees) is
//     DROPPED from the switcher list by the per-user SSAR fan-out — on EVERY page, not just
//     page 0 (one forbidden ns is interleaved into each page of 5);
//   - the switcher pages past NAMESPACE_CANDIDATE_CAP (5) via "Load more";
//   - cookie memory: a switched-to namespace persists across reload.
//
// The fixture is a Helm chart (e2e/fixtures/many-ns/) rendered with `helm template` and
// piped to `kubectl apply` — it ranges over labeledCount/unlabeledCount, so scaling the
// fixture is a values change, not hand-written YAML. Every object carries the
// `e2e-many-test=true` label; afterAll deletes by that label so cleanup is bulletproof
// even if the spec throws mid-run.
//
// Requires the E2E server in sa-list mode with a small cap + short poll (set in the
// Makefile _e2e-start-server target): NAMESPACE_CANDIDATE_CAP=5, POLL_INTERVAL_SECS=5.

const CONTEXT = `kind-${process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev'}`;
const CLEANUP_LABEL = 'e2e-many-test=true';
const CHART_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'many-ns');
const LABELED_COUNT = 25;
const UNLABELED_COUNT = 5;
// FORBIDDEN labeled indices — one per page of 5 (NAMESPACE_CANDIDATE_CAP), so each SSAR
// fan-out page must drop exactly one candidate. The ordered universe is
// [default(0), e2e-team-b(1), mns-00(2), mns-01(3), …], so mns-NN sits at position NN+2.
// Positions 3, 8, 13, 18, 23 → one in each of pages 0–4.
const FORBIDDEN_INDICES = [1, 6, 11, 16, 21];
// Zero-padded so lexical (switcher) order matches numeric order — the switcher sorts the
// alphabetical tail, so mns-03 sorts before mns-10. MUST match the chart's `%02d` padding.
const labeledNs = (i: number) => `e2e-mns-labeled-${String(i).padStart(2, '0')}`;
const unlabeledNs = (i: number) => `e2e-mns-plain-${String(i).padStart(2, '0')}`;

/** Render the many-ns Helm chart to a multi-doc manifest (labeled + unlabeled namespaces). */
function renderManifest(): string {
  const forbiddenJson = JSON.stringify(FORBIDDEN_INDICES.map((i) => String(i).padStart(2, '0')));
  return execFileSync(
    'helm',
    [
      'template',
      'e2e-many-ns',
      CHART_DIR,
      '--set',
      `labeledCount=${LABELED_COUNT}`,
      '--set',
      `unlabeledCount=${UNLABELED_COUNT}`,
      '--set-json',
      `forbiddenIndices=${forbiddenJson}`,
    ],
    { encoding: 'utf8' },
  );
}

/** Open the switcher (triggers the lazy fan-out). */
async function openSwitcher(page: Page) {
  await page.getByRole('button', { name: /select namespace/i }).click();
}

/** Count how many labeled-namespace menu items are currently rendered in the open switcher. */
async function visibleLabeledCount(page: Page): Promise<number> {
  return page.getByRole('menuitem', { name: /e2e-mns-labeled-/ }).count();
}

/** True if the given namespace is currently a selectable menu item in the open switcher. */
function menuItem(page: Page, ns: string) {
  return page.getByRole('menuitem', { name: new RegExp(`^${ns}$`) });
}

/** Click "Load more" if it's offered; returns whether another page was loaded. */
async function loadMoreIfPresent(page: Page): Promise<boolean> {
  const loadMore = page.getByRole('menuitem', { name: /load more/i });
  if (!(await loadMore.isVisible().catch(() => false))) return false;
  const before = await visibleLabeledCount(page);
  await loadMore.click();
  await expect.poll(async () => visibleLabeledCount(page), { timeout: 10_000 }).toBeGreaterThan(before);
  return true;
}

test.describe('Many-namespace discovery + pagination', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    execFileSync('kubectl', ['--context', CONTEXT, 'apply', '-f', '-'], { input: renderManifest(), stdio: 'pipe' });
    // Wait out one poll interval (5s) + margin so the SA universe poll picks up the new
    // labeled namespaces before the tests query the switcher.
    execFileSync('sleep', ['9']);
  });

  // Bulletproof teardown: delete every namespace carrying the cleanup label, regardless of
  // how the tests fared. Runs even if a test threw.
  test.afterAll(() => {
    execFileSync('kubectl', ['--context', CONTEXT, 'delete', 'namespace', '-l', CLEANUP_LABEL, '--wait=false', '--ignore-not-found'], { stdio: 'pipe' });
  });

  test('labeled namespaces are discoverable; unlabeled never appear (sa-list filtering)', async ({ page }) => {
    await page.goto('/');
    await openSwitcher(page);

    // A labeled namespace is reachable — find-by-name confirms it (past the cap, the typeahead
    // + find lookup reaches it even if not in the first page).
    await page.getByRole('textbox', { name: /find a namespace/i }).fill(labeledNs(0));
    await expect(page.getByRole('menuitem', { name: new RegExp(`^${labeledNs(0)}$`) })).toBeVisible({ timeout: 10_000 });

    // An UNLABELED, unauthorized namespace is unreachable: it's not in the discovery list
    // (SA candidate scan is label-selected), and find-by-name (live SSAR) DENIES it since
    // e2e-test has no RBAC there. Type its exact name, click Find → the switcher shows the
    // not-allowed message and never selects it.
    await page.getByRole('textbox', { name: /find a namespace/i }).fill(unlabeledNs(0));
    // No allowed-list item matches it…
    await expect(page.getByRole('menuitem', { name: new RegExp(`^${unlabeledNs(0)}$`) })).toHaveCount(0);
    // …and the find-by-name lookup is denied.
    await page.getByRole('menuitem', { name: new RegExp(`Find "${unlabeledNs(0)}"`) }).click();
    await expect(page.getByText(`You don't have access to "${unlabeledNs(0)}".`)).toBeVisible({ timeout: 10_000 });
  });

  test('confused-deputy: FORBIDDEN labeled namespaces are dropped from the list by the SSAR fan-out (one per page)', async ({ page }) => {
    await page.goto('/');
    await openSwitcher(page);

    // Page through the ENTIRE ordered universe (Load more until exhausted). useInfiniteQuery
    // accumulates every page client-side, so after this loop the menu holds all namespaces
    // the SSAR fan-out marked visible.
    // Bounded loop: the universe is 27 candidates / 5 per page ≈ 6 pages; 12 is generous.
    for (let i = 0; i < 12 && (await loadMoreIfPresent(page)); i++);

    // Each FORBIDDEN namespace is a genuine discovery candidate (labeled → the SA lists it),
    // interleaved one-per-page. None may appear: the per-user SSAR fan-out must drop it. This
    // is THE confused-deputy assertion — visibility is gated by the user's token, not the SA
    // candidate scan. (find-by-name is also denied, same as an unlabeled ns.)
    for (const i of FORBIDDEN_INDICES) {
      await expect(menuItem(page, labeledNs(i))).toHaveCount(0);
    }

    // Sanity: the AUTHORIZED neighbors bracketing each forbidden ns DID load — proving the
    // absences above are real SSAR denials, not a page that simply never rendered.
    for (const i of FORBIDDEN_INDICES) {
      await expect(menuItem(page, labeledNs(i - 1))).toBeVisible();
      await expect(menuItem(page, labeledNs(i + 1))).toBeVisible();
    }

    // Exactly the 20 authorized labeled namespaces are visible (25 labeled − 5 forbidden).
    expect(await visibleLabeledCount(page)).toBe(LABELED_COUNT - FORBIDDEN_INDICES.length);
  });

  test('find-by-name is denied for a forbidden (labeled-but-unauthorized) namespace', async ({ page }) => {
    await page.goto('/');
    await openSwitcher(page);

    // A forbidden ns past page 0 isn't in the loaded list; find-by-name runs a live SSAR under
    // the user's token, which DENIES it (labeled ≠ authorized). Same escape-hatch guard the
    // unlabeled case exercises, but here the ns IS a discovery candidate — proving the label
    // never implies access.
    const forbidden = labeledNs(FORBIDDEN_INDICES[FORBIDDEN_INDICES.length - 1]); // mns-21, a late page
    await page.getByRole('textbox', { name: /find a namespace/i }).fill(forbidden);
    await expect(menuItem(page, forbidden)).toHaveCount(0);
    await page.getByRole('menuitem', { name: new RegExp(`Find "${forbidden}"`) }).click();
    await expect(page.getByText(`You don't have access to "${forbidden}".`)).toBeVisible({ timeout: 10_000 });
  });

  test('switcher pages past the candidate cap via Load more', async ({ page }) => {
    await page.goto('/');
    await openSwitcher(page);

    // First page is capped at NAMESPACE_CANDIDATE_CAP (5). "Load more" is offered.
    const loadMore = page.getByRole('menuitem', { name: /load more/i });
    await expect(loadMore).toBeVisible({ timeout: 10_000 });
    const firstPageCount = await visibleLabeledCount(page);
    expect(firstPageCount).toBeLessThanOrEqual(5);

    // Load the next page — more labeled namespaces accumulate (client keeps prior pages).
    await loadMore.click();
    await expect.poll(async () => visibleLabeledCount(page), { timeout: 10_000 }).toBeGreaterThan(firstPageCount);
  });

  test('cookie memory: a switched-to namespace persists across reload', async ({ page }) => {
    await page.goto('/');
    await openSwitcher(page);
    // Reach a labeled namespace PAST the first page (cap 5) via find-by-name: it isn't in
    // the loaded allowed list, so the switcher offers "Find "<name>"" → the live SSAR
    // allows it (labeled + RBAC) → it's selected. Exercises the find path, not paging.
    const target = labeledNs(12);
    await page.getByRole('textbox', { name: /find a namespace/i }).fill(target);
    await page.getByRole('menuitem', { name: new RegExp(`Find "${target}"`) }).click();
    await expect(page.getByRole('button', { name: /select namespace/i })).toContainText(target);

    // Reload — the preference cookie + URL canonicalization restore the selection.
    await page.reload();
    await expect(page.getByRole('button', { name: /select namespace/i })).toContainText(target);
    await expect(page).toHaveURL(new RegExp(`[?&]namespace=${target}(&|$)`));
  });
});
