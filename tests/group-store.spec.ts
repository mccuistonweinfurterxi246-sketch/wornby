import { expect, test } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' } });

test('only opened stores load and viewed classifications survive a reload', async ({ page }) => {
  test.setTimeout(60000);
  const requestedGroups: number[] = [];
  const summaryCalls: Record<number, number> = {};
  const groups = [
    { id: 101, name: 'Clothing Club', memberCount: 10, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null },
    { id: 102, name: 'Accessory Club', memberCount: 20, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null },
    { id: 103, name: 'Unopened Club', memberCount: 30, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null },
  ];
  const item = (id: number, assetType: number, assetTypeName: string) => ({
    id, name: `${assetTypeName} ${id}`, description: '', assetType, assetTypeName,
    creatorName: 'Group', price: 5, isForSale: true, isOffSale: false, isDeletedOrModerated: false,
    isFree: false, thumbnailUrl: null, studioLuaCommand: '', catalogUrl: `https://www.roblox.com/catalog/${id}`,
  });
  const count = (n: number) => ({ count: n, more: false });

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
  await page.route(/\/api\/group\/(\d+)\/store\?/, async (route) => {
    const url = new URL(route.request().url());
    const groupId = Number(url.pathname.match(/\/api\/group\/(\d+)\/store/)?.[1]);
    const section = url.searchParams.get('section');
    requestedGroups.push(groupId);
    const reopened = requestedGroups.filter((id) => id === groupId).length > 1;
    const items = groupId === 101 && section === 'clothing'
      ? [...[2, 11, 12, 64, 65, 66, 67, 68].map((t, i) => item(1000 + i, t, `Clothing ${t}`)), ...(reopened ? [item(1008, 11, 'Shirt')] : [])]
      : groupId === 102 && section === 'accessories' ? [item(2000, 41, 'Hair Accessory')]
      : groupId === 103 && section === 'clothing' ? [item(3000, 11, 'Shirt')]
      : groupId === 103 && section === 'accessories' ? [item(3001, 41, 'Hair Accessory')]
      : [];
    await route.fulfill({ json: { items, nextPageCursor: null } });
  });
  await page.route(/\/api\/group\/(\d+)\/store-summary/, async (route) => {
    const groupId = Number(new URL(route.request().url()).pathname.match(/\/api\/group\/(\d+)\//)?.[1]);
    summaryCalls[groupId] = (summaryCalls[groupId] || 0) + 1;
    const clothing = groupId === 101 ? (summaryCalls[groupId] > 1 ? 9 : 8) : groupId === 103 ? 1 : 0;
    const accessories = groupId === 101 ? 0 : 1;
    await route.fulfill({ json: { clothing: count(clothing), accessories: count(accessories), heads: count(0), animations: count(0) } });
  });
  await page.route('**/api/asset-thumbnails', (route) => route.fulfill({ json: { thumbnails: {} } }));

  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' }).fill('Alpha');
  await page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' }).press('Enter');
  await page.getByRole('tab', { name: /COMMUNITIES/ }).click();
  expect(requestedGroups).toEqual([]);

  await page.getByRole('button', { name: 'Browse Group Store' }).first().click({ force: true });
  await expect(page.getByText('Clothing · 8').first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Store sections' }).getByRole('button', { name: /CLOTHING\s*8/ })).toHaveAttribute('aria-pressed', 'true');
  expect(requestedGroups).toEqual([101]);

  await page.getByRole('button', { name: 'Sort catalog' }).click();
  const sortMenu = page.getByRole('listbox', { name: 'Sort catalog' });
  await expect(sortMenu).toBeVisible();
  expect(await sortMenu.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await sortMenu.hover();
  await page.mouse.wheel(0, 150);
  await expect(sortMenu).toBeVisible();
  await page.screenshot({ path: 'test-results/group-store-desktop.png' });
  await page.getByRole('button', { name: 'Close Store Modal' }).click();

  // The section with items opens first: Accessory Club has no clothing.
  await page.getByRole('button', { name: 'Browse Group Store' }).nth(1).click({ force: true });
  await expect(page.getByText('Items · 1').first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Store sections' }).getByRole('button', { name: /ACCESSORIES\s*1/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close Store Modal' }).click();
  expect(requestedGroups).toEqual([101, 102]);

  await page.getByRole('button', { name: 'Browse Group Store' }).nth(2).click({ force: true });
  await expect(page.getByText('Mixed · 2').first()).toBeVisible();
  const groupSidebar = page.getByRole('complementary').first();
  await page.getByLabel('Filter group stores').selectOption('clothing');
  await expect(groupSidebar.getByText('Clothing Club', { exact: true })).toBeVisible();
  await expect(groupSidebar.getByText('Accessory Club', { exact: true })).toHaveCount(0);
  await page.getByLabel('Filter group stores').selectOption('mixed');
  await expect(groupSidebar.getByText('Unopened Club', { exact: true })).toBeVisible();
  await page.getByLabel('Filter group stores').selectOption('all');
  await page.getByRole('button', { name: 'Close Store Modal' }).click();
  expect(requestedGroups).toEqual([101, 102, 103]);

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
  expect(requestedGroups).toEqual([101, 102, 103]);

  await page.getByRole('button', { name: 'Clothing', exact: true }).click();
  await page.getByRole('dialog', { name: 'Viewed group stores' }).getByRole('button', { name: /Clothing Club/ }).click();
  await expect(page.getByText('Clothing · 9').first()).toBeVisible();
  await expect(page.getByText('New', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Store Modal' }).click();

  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Beta');
  await search.press('Enter');
  await expect(page).toHaveURL(/\?u=Beta(&tab=groups)?$/);
  await expect(page.getByRole('button', { name: 'Viewed group stores (3)' })).toBeVisible();
  expect(requestedGroups).toEqual([101, 102, 103, 101]);
});

test('viewed stores remain usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('wornby_viewed_group_stores_v1', JSON.stringify([
      { id: 101, name: 'Clothing Club', iconUrl: null, viewedAt: Date.now(), checkedAt: Date.now(), category: 'clothing', clothingCount: 8, itemCount: 0, unknownCount: 0, totalCount: 8, complete: true, tags: [{ label: 'Classic clothing', count: 8 }], analysisVersion: 3 },
      { id: 102, name: 'Accessory Club', iconUrl: null, viewedAt: Date.now() - 1000, checkedAt: Date.now(), category: 'items', clothingCount: 0, itemCount: 1, unknownCount: 0, totalCount: 1, complete: true, tags: [{ label: 'Accessories', count: 1 }], analysisVersion: 3 },
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
      { id: 202, name: 'Zeta Group', iconUrl: null, viewedAt: 2, category: 'unknown', clothingCount: 0, itemCount: 0, unknownCount: 0, totalCount: 0, complete: false, tags: [], analysisVersion: 3 },
      { id: 201, name: 'Alpha Group', iconUrl: null, viewedAt: 1, category: 'unknown', clothingCount: 0, itemCount: 0, unknownCount: 0, totalCount: 0, complete: false, tags: [], analysisVersion: 3 },
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

test('store sections fit a phone screen', async ({ page }) => {
  const group = { id: 601, name: 'Mixed Studio', memberCount: 3, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null };
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
  await page.route(/\/api\/group\/601\/store\?/, (route) => route.fulfill({ json: { items: [], nextPageCursor: null } }));
  await page.route(/\/api\/group\/601\/store-summary/, (route) => route.fulfill({ json: {
    clothing: { count: 1, more: false }, accessories: { count: 1200, more: true }, heads: { count: 548, more: false }, animations: { count: 3, more: false } } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/');
  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Alpha');
  await search.press('Enter');
  await page.getByRole('tab', { name: /COMMUNITIES/ }).click();
  await page.getByRole('button', { name: 'Browse Group Store' }).click({ force: true });
  const sections = page.getByRole('group', { name: 'Store sections' });
  for (const name of [/CLOTHING\s*1/, /ACCESSORIES\s*1,200\+/, /HEADS & FACES\s*548/, /ANIMATIONS\s*3/]) {
    await expect(sections.getByRole('button', { name })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/store-sections-mobile.png' });
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
