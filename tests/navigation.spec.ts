import { expect, test } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' } });

test('browser back and forward restore profiles without adding history entries', async ({ page }) => {
  await page.route('**/api/user/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '');
    if (name === 'Gamma') await new Promise((resolve) => setTimeout(resolve, 500));
    const profile = {
      user: { id: name === 'Alpha' ? 1 : 2, name, displayName: name, hasVerifiedBadge: false },
      thumbnails: { fullBodyUrl: null, headshotUrl: null },
      outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: 0, items: [] },
      groups: [],
      telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: 0 },
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `event: done\ndata: ${JSON.stringify(profile)}\n\n`,
    });
  });

  await page.goto('http://127.0.0.1:5173/');
  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Alpha');
  await search.press('Enter');
  await expect(page).toHaveURL(/\?u=Alpha$/);
  await expect(page.getByTitle('Return to Hero Search')).toBeVisible();

  await search.fill('Beta');
  await search.press('Enter');
  await expect(page).toHaveURL(/\?u=Beta$/);
  const historyLength = await page.evaluate(() => window.history.length);

  await page.goBack();
  await expect(page).toHaveURL(/\?u=Alpha$/);
  await expect(page.getByTitle('Return to Hero Search')).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  await page.goForward();
  await expect(page).toHaveURL(/\?u=Beta$/);
  await expect(page.getByTitle('Return to Hero Search')).toBeVisible();

  await search.fill('Gamma');
  await search.press('Enter');
  await expect(page.getByText('LOADING TELEMETRY…')).toBeVisible();
  await page.getByTitle('Return to Hero Search').click();
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page.getByTitle('Return to Hero Search')).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page.getByTitle('Return to Hero Search')).toHaveCount(0);
});
