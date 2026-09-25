import { test, expect } from '@playwright/test';
import { expectOnPath, advertiseNodeCapacity, withdrawNodeCapacity, waitForCardStatus, waitForCardGone, KUBECTL, KIND_NODE, kubectlGet } from './test-utils';

// The #69 contract end to end, against the pinned-gpu-template fixture (every resource
// axis min == max): the create form serializes no spec.resources, the operator's
// admission stamps the template defaultResources verbatim, including the accelerator
// request the form never renders, and the pod schedules with the GPU (fake node
// capacity, same mechanism as gpu-template.spec.ts).

const RUN_ID = `e2e-pinned-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

test.describe('Create from a fully pinned template', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => advertiseNodeCapacity(KUBECTL, KIND_NODE, { 'nvidia.com/gpu': '4' }));
  test.afterAll(() => withdrawNodeCapacity(KUBECTL, KIND_NODE, ['nvidia.com/gpu']));

  test('create renders disabled sliders and stores the webhook-stamped defaults', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('button', { name: /select pinned gpu template/i }).click();

    const cpu = page.getByRole('slider', { name: 'CPU' });
    await expect(cpu).toBeDisabled();
    await expect(cpu).toHaveValue('0.5');
    const memory = page.getByRole('slider', { name: 'Memory' });
    await expect(memory).toBeDisabled();
    await expect(memory).toHaveValue('1');
    const gpu = page.getByRole('slider', { name: 'GPU' });
    await expect(gpu).toBeDisabled();
    await expect(gpu).toHaveValue('1');
    await expect(page.getByRole('slider', { name: 'Storage' })).toBeEnabled();

    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    await page.getByRole('button', { name: /create workspace/i }).click();
    await expectOnPath(page);

    // The stored spec carries the template defaults verbatim, strings the form can
    // never produce: it emits cpu as "0.5" (never "500m") and puts accelerators in
    // limits only (never requests). Both prove spec.resources was omitted on create and
    // stamped by the operator's admission.
    const stored = JSON.parse(kubectlGet(`workspace ${WS_NAME}`, '{.spec.resources}'));
    expect(stored.limits.cpu).toBe('500m');
    expect(stored.requests['nvidia.com/gpu']).toBe('1');
    expect(stored.limits['nvidia.com/gpu']).toBe('1');
    // Storage still rides on the same submit (spec.storage, not spec.resources).
    const size = kubectlGet(`workspace ${WS_NAME}`, '{.spec.storage.size}');
    expect(size).toBe('5Gi');
  });

  test('the pod schedules with the GPU and the card shows the template values', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await waitForCardStatus(page, card, 'Running');
    await expect(card.getByText('0.5 CPU')).toBeVisible();
    await expect(card.getByText('1 GiB')).toBeVisible();
    await expect(card.getByText('1 GPU')).toBeVisible();

    const limits = JSON.parse(kubectlGet(`deployment workspace-${WS_NAME}`, '{.spec.template.spec.containers[0].resources.limits}'));
    expect(limits['nvidia.com/gpu']).toBe('1');
  });

  test('detail page shows the stamped resources', async ({ page }) => {
    await page.goto(`/workspace/${WS_NAME}`);
    await expect(page.getByText('0.5', { exact: true })).toBeVisible();
    await expect(page.getByText('1 GiB', { exact: true })).toBeVisible();
    await expect(page.getByText('GPU', { exact: true })).toBeVisible();
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
