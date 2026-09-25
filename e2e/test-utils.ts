import { execSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';

// The e2e Kind cluster, addressed through its kubectl context, so a spec can never target
// another context by accident.
export const KIND_CLUSTER = process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev';
export const KIND_NODE = `${KIND_CLUSTER}-control-plane`;
export const KUBECTL = `kubectl --context kind-${KIND_CLUSTER}`;

export function kubectlGet(resource: string, jsonpath: string): string {
  return execSync(`${KUBECTL} get ${resource} -o jsonpath='${jsonpath}'`, { stdio: 'pipe' }).toString();
}

// Advertise fake extended-resource capacity on a Kind node by patching node status (the
// documented mechanism, no device plugin needed:
// https://kubernetes.io/docs/tasks/administer-cluster/extended-resource-node/).
// Scheduling is then real, so workspaces requesting the resource reach Running while the
// container never touches a device.
export function advertiseNodeCapacity(kubectl: string, node: string, resources: Record<string, string>): void {
  const patch = JSON.stringify(Object.entries(resources).map(([key, value]) => ({ op: 'add', path: `/status/capacity/${key.replace(/\//g, '~1')}`, value })));
  execSync(`${kubectl} patch node ${node} --subresource=status --type=json -p='${patch}'`, { stdio: 'pipe' });
}

export function withdrawNodeCapacity(kubectl: string, node: string, keys: string[]): void {
  const patch = JSON.stringify(keys.map((key) => ({ op: 'remove', path: `/status/capacity/${key.replace(/\//g, '~1')}` })));
  try {
    execSync(`${kubectl} patch node ${node} --subresource=status --type=json -p='${patch}'`, { stdio: 'pipe' });
  } catch {
    // Best-effort: leftover fake capacity is harmless and re-advertised next run.
  }
}

// Shared E2E helpers. NOT a .spec file, so Playwright won't collect it as a test.

/** Escape a string for safe embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a full-URL pattern that matches when the URL's path is exactly `path`, tolerating
 * an optional trailing query string. `toHaveURL` matches against the ENTIRE URL (scheme +
 * host + path + query), so a bare `/\/create$/` fails once NamespaceContext canonicalizes
 * `?namespace=` onto the URL — hence the optional `(\?.*)?` tail. Anchored at end only
 * (the host prefix varies).
 */
function pathPattern(path: string): RegExp {
  return new RegExp(`${escapeRegex(path)}(\\?.*)?$`);
}

/**
 * Assert the page is on `path` (default `/`, the workspace list), tolerating the
 * `?namespace=` param the app canonicalizes onto the URL. Pass `namespace` to also assert
 * the active namespace in the URL — the single place E2E encodes "we're on the list page,
 * scoped to ns X".
 *
 *   await expectOnPath(page);                              // on the list (any namespace)
 *   await expectOnPath(page, { namespace: 'e2e-team-b' }); // on the list, scoped to team-b
 *   await expectOnPath(page, { path: '/create' });         // on the create page
 */
export async function expectOnPath(page: Page, opts: { path?: string; namespace?: string; timeout?: number } = {}): Promise<void> {
  const { path = '/', namespace, timeout = 10_000 } = opts;
  await expect(page).toHaveURL(pathPattern(path), { timeout });
  if (namespace !== undefined) {
    // The canonicalized `?namespace=<ns>` param (order-independent within the query).
    await expect(page).toHaveURL(new RegExp(`[?&]namespace=${escapeRegex(namespace)}(&|$)`), { timeout });
  }
}

/** The workspace card for `name`; the card's aria-label carries the name. */
export function cardByName(page: Page, name: string): Locator {
  return page.getByLabel(new RegExp(`${name}.*workspace`, 'i'));
}

/**
 * Click Refresh until the card shows `text`. The list only auto-polls every 60s and the
 * operator reconciles in seconds, so the refresh mirrors what a user waiting on a card does.
 * The status is matched exactly: a substring match would also hit the card's description when
 * the resource name ends in the status word, and the strict-mode error that raises is swallowed
 * by the catch below, so the poll would never go truthy.
 */
export async function waitForCardStatus(page: Page, card: Locator, text: string) {
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

/**
 * Click Refresh until the card is gone. Deletion is finalized asynchronously (the CR lists
 * with a deletionTimestamp until the operator's finalizer runs), so the card can linger.
 */
export async function waitForCardGone(page: Page, card: Locator) {
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: /refresh/i }).click();
        return card.isVisible().catch(() => false);
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBeFalsy();
}

export async function waitForCardStatusByName(page: Page, name: string, text: string) {
  await waitForCardStatus(page, cardByName(page, name), text);
}
