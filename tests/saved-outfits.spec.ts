import { expect, test } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' } });

test('shows saved fits only when opened, with pagination and a whole-outfit preview', async ({ page }) => {
  const requestedUsers: number[] = [];
  await page.route('**/api/user/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || 'Alpha');
    const id = name === 'Beta' ? 2 : 1;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify({
      user: { id, name, displayName: name, hasVerifiedBadge: false },
      thumbnails: { fullBodyUrl: null, headshotUrl: null },
      outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: 0, items: [] },
      groups: [],
      telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: 0 },
    })}\n\n` });
  });
  await page.route(/\/api\/users\/(\d+)\/outfits/, async (route) => {
    const url = new URL(route.request().url());
    const userId = Number(url.pathname.match(/\/api\/users\/(\d+)\/outfits/)?.[1]);
    requestedUsers.push(userId);
    const next = url.searchParams.get('pageToken');
    const outfits = userId === 2
      ? [{ id: 20, name: 'Beta fit', thumbnailUrl: null }]
      : next ? [{ id: 12, name: 'Last fit', thumbnailUrl: null }]
        : [{ id: 10, name: 'Street fit', thumbnailUrl: null }, { id: 11, name: 'Evening fit', thumbnailUrl: null }];
    await route.fulfill({ json: { outfits, nextPageToken: userId === 1 && !next ? 'page-2' : null } });
  });
  await page.route(/\/api\/outfits\/(\d+)/, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    await route.fulfill({ json: {
      id, name: 'Street fit', assets: [
        { id: 101, name: 'Blue shirt', assetTypeName: 'Shirt', kind: 'clothing', thumbnailUrl: null },
        { id: 102, name: 'Black hat', assetTypeName: 'Hat', kind: 'accessory', thumbnailUrl: null },
      ],
    } });
  });

  await page.goto('http://127.0.0.1:5173/');
  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Alpha');
  await search.press('Enter');
  await expect(page.getByRole('tab', { name: 'FITS' })).toBeVisible();
  expect(requestedUsers).toEqual([]);

  await page.getByRole('tab', { name: 'FITS' }).click();
  await expect(page.getByRole('button', { name: 'View fit Street fit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View fit Evening fit' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'FITS' })).toBeVisible();
  await page.screenshot({ path: 'test-results/saved-fits-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'View fit Street fit' }).click();
  await expect(page.getByRole('dialog', { name: 'Fit Street fit' })).toBeVisible();
  await expect(page.getByText('Blue shirt')).toBeVisible();
  await expect(page.getByText('Black hat')).toBeVisible();
  await page.screenshot({ path: 'test-results/saved-fit-details-mobile.png' });
  await page.getByRole('button', { name: 'Copy clothing IDs' }).click();
  await expect(page.getByRole('button', { name: 'Copied clothing IDs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy ID 102' })).toBeVisible();
  await page.getByRole('button', { name: 'Close fit preview' }).last().click();
  await page.getByRole('button', { name: 'LOAD MORE FITS' }).click();
  await expect(page.getByRole('button', { name: 'View fit Last fit' })).toBeVisible();
  expect(requestedUsers).toEqual([1, 1]);

  await search.fill('Beta');
  await search.press('Enter');
  await expect(page.getByRole('button', { name: 'View fit Beta fit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View fit Street fit' })).toHaveCount(0);
  expect(requestedUsers).toEqual([1, 1, 2]);
});
