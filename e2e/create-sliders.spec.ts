import { test, expect } from '@playwright/test';
import { expectOnPath, waitForCardStatus, waitForCardGone, kubectlGet } from './test-utils';

// The create form's sliders set the limits a workspace is created with. Against the e2e default
// template (cpu 100m to 2, memory 128Mi to 2Gi, storage 1Gi to 10Gi, with requests declared),
// moving each slider to its maximum must store those limits, keep the template's requests,
// size the PVC accordingly, and reach Running.

const RUN_ID = `e2e-sliders-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

test.describe('Create form sliders', () => {
  test.describe.configure({ mode: 'serial' });

  test('moving cpu, memory and storage to their maxima stores those values', async ({ page }) => {
    await page.goto('/create');
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);

    const cpu = page.getByRole('slider', { name: 'CPU' });
    const memory = page.getByRole('slider', { name: 'Memory' });
    const storage = page.getByRole('slider', { name: 'Storage' });
    await cpu.focus();
    await page.keyboard.press('End');
    await expect(cpu).toHaveValue('2');
    await memory.focus();
    await page.keyboard.press('End');
    await expect(memory).toHaveValue('2');
    await storage.focus();
    await page.keyboard.press('End');
    await expect(storage).toHaveValue('10');

    await page.getByRole('button', { name: /create workspace/i }).click();
    await expectOnPath(page);

    const resources = JSON.parse(kubectlGet(`workspace ${WS_NAME}`, '{.spec.resources}'));
    expect(resources.limits).toEqual({ cpu: '2', memory: '2Gi' });
    // The template declares requests, so they ride verbatim; the sliders only set limits.
    expect(resources.requests).toEqual({ cpu: '100m', memory: '128Mi' });
    expect(kubectlGet(`workspace ${WS_NAME}`, '{.spec.storage.size}')).toBe('10Gi');
    // The operator creates the PVC on its first reconcile, moments after the create.
    await expect
      .poll(
        () => {
          try {
            return kubectlGet(`pvc workspace-${WS_NAME}-pvc`, '{.spec.resources.requests.storage}');
          } catch {
            return '';
          }
        },
        { timeout: 30_000 },
      )
      .toBe('10Gi');
  });

  test('the card shows the chosen values and the workspace reaches Running', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /all/i }).click();
    const card = page.getByLabel(new RegExp(`${WS_NAME}.*workspace`, 'i'));
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('2 CPU')).toBeVisible();
    await expect(card.getByText('2 GiB')).toBeVisible();
    await expect(card.getByText('10 GiB')).toBeVisible();
    await waitForCardStatus(page, card, 'Running');
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
