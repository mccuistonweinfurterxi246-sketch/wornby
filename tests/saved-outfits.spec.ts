import { expect, Page, test } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' } });

const profile = (id: number, name: string, items: { id: number; name: string; assetTypeName: string }[] = []) => `event: done\ndata: ${JSON.stringify({
  user: { id, name, displayName: name, hasVerifiedBadge: false },
  thumbnails: { fullBodyUrl: null, headshotUrl: null },
  outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: items.length, items },
  groups: [],
  telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: items.length },
})}\n\n`;

async function mockProfiles(page: Page) {
  await page.route('**/api/user/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || 'Alpha');
    const id = name === 'Beta' ? 2 : name === 'Locked' ? 3 : 1;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: profile(id, name, id === 3 ? [{ id: 900, name: 'Cap', assetTypeName: 'Hat' }] : []) });
  });
  await page.route(/\/api\/asset-thumbnails/, (route) => route.fulfill({ json: { thumbnails: {} } }));
}

async function openPlayer(page: Page, name: string) {
  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill(name);
  await search.press('Enter');
}

test('the archive loads only when opened, previews a fit and switches players', async ({ page }) => {
  const requestedUsers: number[] = [];
  await mockProfiles(page);
  await page.route(/\/api\/users\/(\d+)\/archive(\?|$)/, async (route) => {
    const userId = Number(new URL(route.request().url()).pathname.match(/users\/(\d+)\//)?.[1]);
    requestedUsers.push(userId);
    const outfits = userId === 2 ? [{ id: 20, name: 'Beta fit', thumbnailUrl: null }]
      : [{ id: 10, name: 'Street fit', thumbnailUrl: null }, { id: 11, name: 'Evening fit', thumbnailUrl: null }, { id: 12, name: 'Last fit', thumbnailUrl: null }];
    await route.fulfill({ json: { inventory: 'public', outfits, complete: true } });
  });
  await page.route(/\/api\/users\/\d+\/archive\/index/, (route) => route.fulfill({ json: { snapshots: [], complete: true } }));
  await page.route(/\/api\/outfits\/(\d+)$/, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    await route.fulfill({ json: {
      id, name: 'Street fit', assets: [
        { id: 101, name: 'Blue shirt', assetTypeName: 'Shirt', kind: 'clothing', thumbnailUrl: null },
        { id: 102, name: 'Black hat', assetTypeName: 'Hat', kind: 'accessory', thumbnailUrl: null },
      ],
    } });
  });

  await page.goto('http://127.0.0.1:5173/');
  await openPlayer(page, 'Alpha');
  await expect(page.getByRole('tab', { name: 'ARCHIVE' })).toBeVisible();
  expect(requestedUsers).toEqual([]);

  await page.getByRole('tab', { name: 'ARCHIVE' }).click();
  await expect(page.getByRole('button', { name: 'View fit Street fit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View fit Last fit' })).toBeVisible();
  await expect(page.getByText('3 available · 0 recovered · 0 deleted · 0 name only')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/archive-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'View fit Street fit' }).click();
  await expect(page.getByRole('dialog', { name: 'Fit Street fit' })).toBeVisible();
  await expect(page.getByText('Blue shirt')).toBeVisible();
  await page.getByRole('button', { name: 'Copy clothing IDs' }).click();
  await expect(page.getByRole('button', { name: 'Copied clothing IDs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy ID 102' })).toBeVisible();
  await page.getByRole('button', { name: 'Close fit preview' }).last().click();
  await page.getByRole('textbox', { name: 'Search outfits or item IDs' }).fill('evening');
  await expect(page.getByRole('button', { name: 'View fit Street fit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View fit Evening fit' })).toBeVisible();

  await openPlayer(page, 'Beta');
  await expect(page.getByRole('button', { name: 'View fit Beta fit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View fit Street fit' })).toHaveCount(0);
  expect(requestedUsers).toEqual([1, 2]);
});

test('history from the Wayback Machine adds deleted fits, name-only fits and dated worn looks', async ({ page }) => {
  await mockProfiles(page);
  await page.route(/\/api\/users\/1\/archive(\?|$)/, (route) => route.fulfill({ json: { inventory: 'public', outfits: [{ id: 10, name: 'Street fit', thumbnailUrl: null }], complete: true } }));
  await page.route(/\/api\/users\/1\/archive\/index/, async (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    const snapshots = kind === 'outfits' ? [{ kind, ts: '20221106000000', url: 'https://avatar.roblox.com/v2/avatar/users/1/outfits' }]
      : kind === 'profile' ? [{ kind, ts: '20160103060258', url: 'https://www.roblox.com/users/1/profile' }] : [];
    await route.fulfill({ json: { snapshots, complete: true } });
  });
  await page.route(/\/api\/archive\/snapshot/, async (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    await route.fulfill({ json: kind === 'outfits'
      ? { kind, date: '2022-11-06', outfits: [{ id: 10, name: 'Street fit' }, { id: 5, name: 'maidy' }, { id: 6, name: 'neko' }] }
      : { kind, date: '2016-01-03', look: { assetIds: [42070576, 31312357], items: [{ id: 42070576, name: 'Epic Face' }, { id: 31312357, name: 'Telamon Hair' }], renderUrl: null } } });
  });
  await page.route(/\/api\/outfits\/(5|6)$/, (route) => route.fulfill({ status: 404, json: { error: 'Outfit not found' } }));
  await page.route(/\/api\/outfits\/5\/archived/, (route) => route.fulfill({ json: { id: 5, assets: [{ id: 77, name: 'Maid dress', assetTypeName: 'Shirt', kind: 'clothing' }] } }));
  await page.route(/\/api\/outfits\/6\/archived/, (route) => route.fulfill({ json: { id: 6, assets: null } }));

  await page.goto('http://127.0.0.1:5173/?u=Alpha&tab=fits');
  await expect(page.getByText('1 available · 0 recovered · 1 deleted · 1 name only · 1 worn looks')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'View look worn Jan 2016' })).toBeVisible();
  await page.screenshot({ path: 'test-results/archive-history.png', fullPage: true });

  await page.getByRole('button', { name: 'View fit maidy' }).click();
  await expect(page.getByText('Items recovered from an archived copy')).toBeVisible();
  await expect(page.getByText('Maid dress')).toBeVisible();
  await page.getByRole('button', { name: 'Close fit preview' }).last().click();
  await page.getByRole('button', { name: 'View fit neko' }).click();
  await expect(page.getByText('Only this fit’s name was archived')).toBeVisible();
  await page.getByRole('button', { name: 'Close fit preview' }).last().click();

  await page.getByRole('button', { name: /^Deleted/ }).click();
  await expect(page.getByRole('button', { name: 'View fit maidy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View fit Street fit' })).toHaveCount(0);
});

test('a private inventory hides outfits but keeps worn looks', async ({ page }) => {
  await mockProfiles(page);
  await page.route(/\/api\/users\/3\/archive(\?|$)/, (route) => route.fulfill({ json: { inventory: 'private', outfits: [], complete: true } }));
  await page.route(/\/api\/users\/3\/archive\/index/, (route) => route.fulfill({ json: { snapshots: [], complete: true } }));
  await page.goto('http://127.0.0.1:5173/?u=Locked&tab=fits');
  await expect(page.getByText('This player’s inventory is private')).toBeVisible();
  await expect(page.getByRole('button', { name: /View look worn/ })).toBeVisible();
  await expect(page.getByText('Wearing now')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Available/ })).toHaveCount(0);
});
