import { execSync } from 'node:child_process';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectOnPath } from './test-utils';

// Accelerator axes end to end, against the real cluster with the gpu-template fixture
// (e2e/fixtures/gpu-template.yaml: nvidia.com/gpu 0–2 default 1, plus a MIG profile key
// 0–4 default absent, plus ephemeral-storage as an unprefixed built-in that must never
// become an axis or a chip).
//
// The Kind node has no GPU hardware; the suite advertises fake extended-resource capacity
// by patching node status (the documented mechanism, no device plugin needed:
// https://kubernetes.io/docs/tasks/administer-cluster/extended-resource-node/). Scheduling
// is then real, so a GPU workspace runs the normal lifecycle including Running — the
// container never touches a device. Webhook bounds rejection is covered by unit tests and
// the operator's own suite; the UI clamps to bounds so it cannot produce an out-of-bounds
// spec through this form.

const RUN_ID = `e2e-gpu-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

const CLUSTER = process.env.E2E_KIND_CLUSTER || 'jupyter-k8s-dev';
const NODE = `${CLUSTER}-control-plane`;
const KUBECTL = `kubectl --context kind-${CLUSTER}`;

function advertiseAccelerators() {
  const patch = JSON.stringify([
    { op: 'add', path: '/status/capacity/nvidia.com~1gpu', value: '4' },
    { op: 'add', path: '/status/capacity/nvidia.com~1mig-1g.5gb', value: '4' },
  ]);
  execSync(`${KUBECTL} patch node ${NODE} --subresource=status --type=json -p='${patch}'`, { stdio: 'pipe' });
}

function withdrawAccelerators() {
  const patch = JSON.stringify([
    { op: 'remove', path: '/status/capacity/nvidia.com~1gpu' },
    { op: 'remove', path: '/status/capacity/nvidia.com~1mig-1g.5gb' },
  ]);
  try {
    execSync(`${KUBECTL} patch node ${NODE} --subresource=status --type=json -p='${patch}'`, { stdio: 'pipe' });
  } catch {
    // Best-effort: leftover fake capacity is harmless and re-advertised next run.
  }
}

async function waitForCardStatus(page: Page, card: Locator, text: string) {
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

// Deletion is finalized asynchronously (the CR lists with a deletionTimestamp until the
// operator's finalizer runs), so poll with explicit refreshes like workspace-crud does.
async function waitForCardGone(page: Page, card: Locator) {
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

test.describe('Accelerator axes (gpu-template)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => advertiseAccelerators());
  test.afterAll(() => withdrawAccelerators());

  test('template-gated axes render and create emits the default GPU limit', async ({ page }) => {
    await page.goto('/create');

    // Select the GPU template card → both accelerator axes appear between Memory and Storage.
    await page.getByRole('button', { name: /select gpu template template/i }).click();
    const gpuSlider = page.getByRole('slider', { name: 'GPU' });
    await expect(gpuSlider).toBeVisible();
    await expect(gpuSlider).toHaveValue('1'); // template defaultResources limit
    const migSlider = page.getByRole('slider', { name: 'nvidia.com/mig-1g.5gb' });
    await expect(migSlider).toHaveValue('0'); // no template default → 0 → omitted on submit
    // Unprefixed built-ins declared in bounds never become axes (extended resources are
    // exactly the domain-prefixed keys).
    await expect(page.getByRole('slider', { name: 'ephemeral-storage' })).toHaveCount(0);

    // Switching to a template without accelerator bounds unmounts the axes.
    await page.getByRole('button', { name: /select default template/i }).click();
    await expect(page.getByRole('slider', { name: 'GPU' })).toHaveCount(0);
    await page.getByRole('button', { name: /select gpu template template/i }).click();
    await expect(page.getByRole('slider', { name: 'GPU' })).toBeVisible();

    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    await page.getByRole('button', { name: /create workspace/i }).click();
    await expectOnPath(page);

    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });

    // With the advertised capacity the pod actually schedules — full lifecycle, not
    // spec-only assertions.
    await waitForCardStatus(page, card, 'Running');
    await expect(card.getByText('1 GPU')).toBeVisible();
  });

  test('detail page shows the accelerator row', async ({ page }) => {
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByText('GPU', { exact: true })).toBeVisible();
    // The MIG key was omitted at 0 → no row for it.
    await expect(page.getByText('nvidia.com/mig-1g.5gb')).toHaveCount(0);
  });

  test('an unprefixed stored limit never renders as an accelerator chip', async ({ page }) => {
    // Landed via kubectl patch, the YAML-editor channel for keys the form does not model.
    execSync(`${KUBECTL} patch workspace ${WS_NAME} --type=merge -p='{"spec":{"resources":{"limits":{"ephemeral-storage":"1073741824"}}}}'`, {
      stdio: 'pipe',
    });
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('1 GPU')).toBeVisible();
    await expect(card.getByText(/ephemeral-storage/)).toHaveCount(0);
  });

  test('quantities entered through YAML render rounded and labeled GiB on the card', async ({ page }) => {
    // "1500m" is 1.5 cores; "1G" is 10^9 bytes = 0.93 GiB; YAML edits can store both.
    execSync(`${KUBECTL} patch workspace ${WS_NAME} --type=merge -p='{"spec":{"resources":{"limits":{"cpu":"1500m","memory":"1G"}}}}'`, {
      stdio: 'pipe',
    });
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('1.5 CPU')).toBeVisible();
    await expect(card.getByText('0.93 GiB')).toBeVisible();
  });

  test('edit seeds the stored GPU and sliding to 0 removes the key', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await card.getByRole('button', { name: /^stop$/i }).click();
    await waitForCardStatus(page, card, 'Stopped');

    await card.getByRole('button', { name: /^edit$/i }).click();
    const gpuSlider = page.getByRole('slider', { name: 'GPU' });
    await expect(gpuSlider).toHaveValue('1'); // seeded from the stored limit
    await gpuSlider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(gpuSlider).toHaveValue('0');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expectOnPath(page);

    // The key is gone: the card shows no GPU chip anymore.
    await page.getByRole('button', { name: /all/i }).click();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('1 GPU')).toHaveCount(0);

    // The form save rebuilds only the resource keys it models; a stored limit it does
    // not model must pass through the same save verbatim.
    const limits = JSON.parse(execSync(`${KUBECTL} get workspace ${WS_NAME} -o jsonpath='{.spec.resources.limits}'`, { stdio: 'pipe' }).toString());
    expect(limits['nvidia.com/gpu']).toBeUndefined();
    expect(limits['ephemeral-storage']).toBe('1073741824');
  });

  test('delete cleans up', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await card.getByRole('button', { name: /more options/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^delete$/i })
      .click();
    await waitForCardGone(page, card);
  });
});
