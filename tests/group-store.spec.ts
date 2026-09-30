import { expect, test } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' } });

test('only opened stores load and viewed classifications survive a reload', async ({ page }) => {
  test.setTimeout(60000);
  const requestedGroups: number[] = [];
  let transientPageFailures = 0;
  const groups = [
    { id: 101, name: 'Clothing Club', memberCount: 10, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null },
    { id: 102, name: 'Accessory Club', memberCount: 20, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null },
    { id: 103, name: 'Unopened Club', memberCount: 30, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null },
  ];
  const clothingTypes = [
    [2, 'T-Shirt'], [11, 'Shirt'], [12, 'Pants'], [64, 'T-Shirt Accessory'],
    [65, 'Shirt Accessory'], [66, 'Pants Accessory'], [67, 'Jacket Accessory'], [68, 'Sweater Accessory'],
  ] as const;
  const item = (id: number, assetType: number, assetTypeName: string) => ({
    id, name: `${assetTypeName} ${id}`, description: '', assetType, assetTypeName,
    creatorName: 'Group', price: 5, isForSale: true, isOffSale: false, isDeletedOrModerated: false,
    isFree: false, thumbnailUrl: null, studioLuaCommand: '', catalogUrl: `https://www.roblox.com/catalog/${id}`,
  });

  await page.route('**/api/user/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || 'Alpha');
    const profile = {
      user: { id: name === 'Beta' ? 2 : 1, name, displayName: name, hasVerifiedBadge: false },
      thumbnails: { fullBodyUrl: null, headshotUrl: null },
      outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: 0, items: [] },
      groups: name === 'Beta' ? [groups[0]] : groups,
      telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: 0 },
    };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(profile)}\n\n` });
  });
  await page.route(/\/api\/group\/(\d+)\/store/, async (route) => {
    const url = new URL(route.request().url());
    const groupId = Number(url.pathname.match(/\/api\/group\/(\d+)\/store/)?.[1]);
    requestedGroups.push(groupId);
    if (groupId === 103 && url.searchParams.has('cursor') && transientPageFailures++ < 2) {
      await route.fulfill({ status: 503, json: { error: 'Temporary failure' } });
      return;
    }
    if (groupId === 101 && requestedGroups.filter((id) => id === 101).length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const items = groupId === 101
      ? [
          ...clothingTypes.map(([type, name], index) => item(1000 + index, type, name)),
          ...(requestedGroups.filter((id) => id === 101).length > 1 ? [item(1008, 11, 'Shirt')] : []),
        ]
      : groupId === 102 ? url.searchParams.has('cursor') ? [] : [item(2000, 41, 'Hair Accessory')]
      : groupId === 103 ? [url.searchParams.has('cursor') ? item(3001, 41, 'Hair Accessory') : item(3000, 11, 'Shirt')]
      : [];
    await route.fulfill({ json: { items, nextPageCursor: (groupId === 102 || groupId === 103) && !url.searchParams.has('cursor') ? 'second' : null } });
  });
  await page.route('**/api/asset-thumbnails', (route) => route.fulfill({ json: { thumbnails: {} } }));

  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' }).fill('Alpha');
  await page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' }).press('Enter');
  await page.getByRole('tab', { name: /COMMUNITIES/ }).click();
  expect(requestedGroups).toEqual([]);

  await page.getByRole('button', { name: 'Browse Group Store' }).first().click({ force: true });
  await expect(page.getByText(/Checking/).first()).toBeVisible();
  await expect(page.getByText('Clothing · 8').first()).toBeVisible();
  await page.waitForTimeout(250);
  expect(requestedGroups).toEqual([101]);

  await page.getByRole('button', { name: 'Clothing type' }).click();
  const menu = page.getByRole('listbox', { name: 'Clothing type' });
  await expect(menu).toBeVisible();
  await menu.hover();
  await page.mouse.wheel(0, 200);
  await expect(menu).toBeVisible();
  await page.getByRole('button', { name: 'Clothing type' }).click();
  await page.getByRole('button', { name: 'Sort catalog' }).click();
  const sortMenu = page.getByRole('listbox', { name: 'Sort catalog' });
  await expect(sortMenu).toBeVisible();
  expect(await sortMenu.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await sortMenu.hover();
  await page.mouse.wheel(0, 150);
  await expect(sortMenu).toBeVisible();
  await page.screenshot({ path: 'test-results/group-store-desktop.png' });
  await page.getByRole('button', { name: 'Close Store Modal' }).click();

  await page.getByRole('button', { name: 'Browse Group Store' }).nth(1).click({ force: true });
  await expect(page.getByText('Items · 1').first()).toBeVisible();
  await page.getByRole('button', { name: 'Close Store Modal' }).click();
  expect(requestedGroups).toEqual([101, 102, 102]);

  await page.getByRole('button', { name: 'Browse Group Store' }).nth(2).click({ force: true });
  await expect(page.getByText('Incomplete · 1+').first()).toBeVisible();
  await page.getByRole('button', { name: 'Retry analysis' }).click();
  await expect(page.getByText('Mixed · 2').first()).toBeVisible();
  const groupSidebar = page.getByRole('complementary').first();
  await expect(groupSidebar.getByText('Classic 1')).toHaveCount(0);
  await page.getByLabel('Filter group stores').selectOption('clothing');
  await expect(groupSidebar.getByText('Clothing Club', { exact: true })).toBeVisible();
  await expect(groupSidebar.getByText('Accessory Club', { exact: true })).toHaveCount(0);
  await page.getByLabel('Filter group stores').selectOption('mixed');
  await expect(groupSidebar.getByText('Unopened Club', { exact: true })).toBeVisible();
  await page.getByLabel('Filter group stores').selectOption('all');
  await page.getByRole('button', { name: 'Close Store Modal' }).click();
  expect(requestedGroups).toEqual([101, 102, 102, 103, 103, 103, 103]);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Viewed group stores (3)' })).toBeVisible();
  await page.getByRole('button', { name: 'Viewed group stores (3)' }).click();
  await page.getByRole('button', { name: 'Clothing', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Viewed group stores' }).getByText('Clothing Club')).toBeVisible();
  await page.screenshot({ path: 'test-results/viewed-stores-desktop.png' });
  await page.getByRole('button', { name: 'Items', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Viewed group stores' }).getByText('Accessory Club')).toBeVisible();
  await page.getByRole('button', { name: 'Mixed', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Viewed group stores' }).getByText('Unopened Club')).toBeVisible();
  expect(requestedGroups).toEqual([101, 102, 102, 103, 103, 103, 103]);

  await page.getByRole('button', { name: 'Clothing', exact: true }).click();
  await page.getByRole('dialog', { name: 'Viewed group stores' }).getByRole('button', { name: /Clothing Club/ }).click();
  await expect(page.getByText('Clothing · 9').first()).toBeVisible();
  await expect(page.getByText('New', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Store Modal' }).click();

  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Beta');
  await search.press('Enter');
  await expect(page).toHaveURL(/\?u=Beta$/);
  await expect(page.getByRole('button', { name: 'Viewed group stores (3)' })).toBeVisible();
  expect(requestedGroups).toEqual([101, 102, 102, 103, 103, 103, 103, 101]);
});

test('viewed stores remain usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('wornby_viewed_group_stores_v1', JSON.stringify([
      { id: 101, name: 'Clothing Club', iconUrl: null, viewedAt: Date.now(), checkedAt: Date.now(), category: 'clothing', clothingCount: 8, itemCount: 0, unknownCount: 0, totalCount: 8, complete: true, tags: [{ label: 'Classic clothing', count: 8 }], analysisVersion: 2 },
      { id: 102, name: 'Accessory Club', iconUrl: null, viewedAt: Date.now() - 1000, checkedAt: Date.now(), category: 'items', clothingCount: 0, itemCount: 1, unknownCount: 0, totalCount: 1, complete: true, tags: [{ label: 'Accessories', count: 1 }], analysisVersion: 2 },
    ]));
  });
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'Viewed group stores (2)' }).click();
  await page.getByRole('button', { name: 'Items', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Viewed group stores' }).getByText('Accessory Club')).toBeVisible();
  await page.screenshot({ path: 'test-results/viewed-stores-mobile.png' });
});

test('viewed groups keep their positions while the active store changes', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wornby_viewed_group_stores_v1', JSON.stringify([
      { id: 202, name: 'Zeta Group', iconUrl: null, viewedAt: 2, category: 'unknown', clothingCount: 0, itemCount: 0, unknownCount: 0, totalCount: 0, complete: false, tags: [], analysisVersion: 2 },
      { id: 201, name: 'Alpha Group', iconUrl: null, viewedAt: 1, category: 'unknown', clothingCount: 0, itemCount: 0, unknownCount: 0, totalCount: 0, complete: false, tags: [], analysisVersion: 2 },
    ]));
  });
  await page.route(/\/api\/group\/\d+\/store/, (route) => route.fulfill({ json: { items: [], nextPageCursor: null } }));
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'Viewed group stores (2)' }).click();
  const drawer = page.getByRole('dialog', { name: 'Viewed group stores' });
  await expect(drawer.locator('.fancy-scroll > button').first()).toContainText('Alpha Group');
  await drawer.getByRole('button', { name: /Zeta Group/ }).click();

  const sidebar = page.getByRole('complementary').first();
  const rows = sidebar.locator('.fancy-scroll > div');
  await expect(rows.first()).toContainText('Alpha Group');
  await expect(rows.nth(1)).toContainText('Zeta Group');
  await expect(sidebar.getByRole('button', { name: /Zeta Group/ })).toHaveAttribute('aria-current', 'true');
  await sidebar.getByRole('button', { name: /Alpha Group/ }).click();
  await expect(rows.first()).toContainText('Alpha Group');
  await expect(rows.nth(1)).toContainText('Zeta Group');
  await expect(sidebar.getByRole('button', { name: /Alpha Group/ })).toHaveAttribute('aria-current', 'true');
  await expect(sidebar.getByRole('button', { name: /Zeta Group/ })).not.toHaveAttribute('aria-current', 'true');
});

test('missing store images can be retried without reopening the group', async ({ page }) => {
  test.setTimeout(30000);
  const group = { id: 501, name: 'Image Studio', memberCount: 2, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null };
  const imageUrl = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" fill="red"/%3E%3C/svg%3E';
  let thumbnailRequests = 0;
  await page.route('**/api/user/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `event: done\ndata: ${JSON.stringify({
      user: { id: 1, name: 'Alpha', displayName: 'Alpha', hasVerifiedBadge: false },
      thumbnails: { fullBodyUrl: null, headshotUrl: null },
      outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: 0, items: [] },
      groups: [group],
      telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: 0 },
    })}\n\n`,
  }));
  await page.route(/\/api\/group\/501\/store/, (route) => route.fulfill({ json: {
    items: [{ id: 5001, name: 'Red Shirt', description: '', assetType: 11, assetTypeName: 'Shirt', creatorName: 'Image Studio', price: 5, isForSale: true, isOffSale: false, isDeletedOrModerated: false, isFree: false, thumbnailUrl: null, studioLuaCommand: '', catalogUrl: 'https://www.roblox.com/catalog/5001' }],
    nextPageCursor: null,
  } }));
  await page.route('**/api/asset-thumbnails', (route) => {
    thumbnailRequests++;
    return route.fulfill({ json: { thumbnails: thumbnailRequests > 3 ? { 5001: imageUrl } : {} } });
  });

  await page.goto('http://127.0.0.1:5173/');
  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Alpha');
  await search.press('Enter');
  await page.getByRole('tab', { name: /COMMUNITIES/ }).click();
  await page.getByRole('button', { name: 'Browse Group Store' }).click({ force: true });
  await expect(page.getByText('1 image unavailable')).toBeVisible();
  await expect.poll(() => thumbnailRequests).toBe(3);
  await page.getByRole('button', { name: 'Retry images' }).click();
  await expect(page.getByRole('img', { name: 'Red Shirt' })).toHaveAttribute('src', imageUrl);
  await expect(page.getByText('1 image unavailable')).toHaveCount(0);
});
