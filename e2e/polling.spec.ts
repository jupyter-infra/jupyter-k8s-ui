import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { expectOnPath, cardByName, KUBECTL } from './test-utils';

const RUN_ID = `e2e-poll-${Date.now()}`;
const WS_NAME = `${RUN_ID}-ws`;

// The other specs click Refresh to wait for a card, so they pass even if the list stopped polling. This one
// waits on the poll alone: the list refetches every 3 s while a card is Starting, and at the 60 s rate the
// card would still read Starting when the 30 s budget ends.
test.describe('List polling', () => {
  test.afterAll(() => {
    execSync(`${KUBECTL} delete workspace ${WS_NAME} -n default --ignore-not-found --wait=false`, { stdio: 'inherit' });
  });

  test('a new workspace reaches Running on its card without a Refresh click', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /new workspace/i }).click();
    await expectOnPath(page, { path: '/create' });
    await page.getByRole('textbox', { name: /^name$/i }).fill(WS_NAME);
    await page.getByRole('textbox', { name: /display name/i }).fill(WS_NAME);
    await page.getByRole('button', { name: /create workspace/i }).click();
    await expectOnPath(page);

    await page.getByRole('button', { name: /all/i }).click();
    const card = cardByName(page, WS_NAME);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
