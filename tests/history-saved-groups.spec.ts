import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' }, reducedMotion: 'reduce' });

const FOLDER_KEY = 'wornby_copied_groups_folder_v1';
const LEGACY_KEY = 'wornby_copied_groups';
const group = (id: number, name = `Club ${id}`) => ({ id, name, memberCount: id, hasVerifiedBadge: false, roleName: 'Member', roleRank: 1, iconUrl: null });
const saved = (id: number) => ({ ...group(id), copiedAt: 1_700_000_000_000 + id, memberCountAtCopy: id });
const players: Record<string, ReturnType<typeof group>[]> = {
  Alpha: [group(101, 'Clothing Club'), group(102, 'Accessory Club')],
  Beta: [group(201, 'Beta Club')],
};

async function mockApi(page: Page) {
  const profileRequests: string[] = [];
  const groupInfoRequests: number[] = [];
  await page.route('**/api/user/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || 'Alpha');
    profileRequests.push(name);
    const profile = {
      user: { id: name === 'Beta' ? 2 : 1, name, displayName: name, hasVerifiedBadge: false },
      thumbnails: { fullBodyUrl: null, headshotUrl: null },
      outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: 0, items: [] },
      groups: players[name] ?? [],
      telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: 0 },
    };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(profile)}\n\n` });
  });
  await page.route(/\/api\/group\/\d+\/store/, (route) => route.fulfill({ json: { items: [], nextPageCursor: null } }));
  await page.route(/\/api\/group\/\d+\/new-items/, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(/\/api\/group\/\d+$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    groupInfoRequests.push(id);
    return route.fulfill({ json: { id, name: id === 101 ? 'Clothing Club' : `Fetched ${id}`, memberCount: 500 } });
  });
  await page.route('**/api/asset-thumbnails', (route) => route.fulfill({ json: { thumbnails: {} } }));
  return { profileRequests, groupInfoRequests };
}

const storeDialog = (page: Page) => page.getByRole('button', { name: 'Close Store Modal' });
const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });
const profileShown = (page: Page, name: string) => expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

test('back and forward restore the player, tab and open store from the URL', async ({ page }) => {
  test.setTimeout(90000);
  const { profileRequests } = await mockApi(page);
  await page.goto('http://127.0.0.1:5173/?u=Alpha');
  await profileShown(page, 'Alpha');

  await tab(page, /COMMUNITIES/).click();
  await expect(page).toHaveURL(/\?u=Alpha&tab=groups$/);
  await page.getByRole('button', { name: 'Browse Group Store' }).first().click();
  await expect(page).toHaveURL(/\?u=Alpha&tab=groups&store=101$/);
  await expect(storeDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(storeDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\?u=Alpha&tab=groups$/);

  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill('Beta');
  await search.press('Enter');
  await expect(page).toHaveURL(/\?u=Beta&tab=groups$/);
  await profileShown(page, 'Beta');
  const historyLength = await page.evaluate(() => history.length);
  const alphaLoads = profileRequests.filter((n) => n === 'Alpha').length;

  // back through: Alpha (store closed) -> Alpha store open -> Alpha groups -> Alpha outfit
  await page.goBack();
  await expect(page).toHaveURL(/\?u=Alpha&tab=groups$/);
  await profileShown(page, 'Alpha');
  await expect(tab(page, /COMMUNITIES/)).toHaveAttribute('aria-selected', 'true');
  await expect(storeDialog(page)).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/store=101$/);
  await expect(storeDialog(page)).toBeVisible();
  await expect(page.getByText('Clothing Club').first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?u=Alpha&tab=groups$/);
  await expect(storeDialog(page)).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\?u=Alpha$/);
  await expect(tab(page, /OUTFIT/)).toHaveAttribute('aria-selected', 'true');

  // and forward again
  await page.goForward();
  await expect(tab(page, /COMMUNITIES/)).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(storeDialog(page)).toBeVisible();
  await page.goForward();
  await expect(storeDialog(page)).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\?u=Beta&tab=groups$/);
  await profileShown(page, 'Beta');
  await expect(tab(page, /COMMUNITIES/)).toHaveAttribute('aria-selected', 'true');

  // tab and store steps of the same player never reload the profile, and back/forward adds no entries
  expect(profileRequests.filter((n) => n === 'Alpha').length - alphaLoads).toBe(1);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // profile -> start page -> back restores the profile with its tab
  await page.getByTitle('Back to search').click();
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await page.goBack();
  await profileShown(page, 'Beta');
  await expect(tab(page, /COMMUNITIES/)).toHaveAttribute('aria-selected', 'true');
});

test('a store link on the start page follows back and forward', async ({ page }) => {
  await mockApi(page);
  await page.goto('http://127.0.0.1:5173/?store=101');
  await expect(storeDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(storeDialog(page)).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\?store=101$/);
  await expect(storeDialog(page)).toBeVisible();
  await page.goForward();
  await expect(storeDialog(page)).toHaveCount(0);
});

test('more than 100 saved groups are kept when saving and when migrating the old list', async ({ page }) => {
  test.setTimeout(60000);
  const { groupInfoRequests } = await mockApi(page);
  const folder = Array.from({ length: 150 }, (_, i) => saved(1001 + i));
  const legacy = Array.from({ length: 41 }, (_, i) => 1140 + i); // 1140..1180: 1151..1180 exist only here
  await page.addInitScript(([folderKey, legacyKey, f, l]) => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.setItem(folderKey as string, JSON.stringify(f));
    localStorage.setItem(legacyKey as string, JSON.stringify(l));
    sessionStorage.setItem('seeded', '1');
  }, [FOLDER_KEY, LEGACY_KEY, folder, legacy]);

  await page.goto('http://127.0.0.1:5173/?u=Alpha&tab=groups');
  await profileShown(page, 'Alpha');
  const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]') as { id: number; name: string; copiedAt: number }[], FOLDER_KEY);
  await expect.poll(async () => (await stored()).length).toBe(180);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBeNull();
  const afterMigration = await stored();
  expect(afterMigration.slice(0, 150)).toEqual(folder.map((e) => expect.objectContaining({ id: e.id, name: e.name, copiedAt: e.copiedAt })));
  expect(afterMigration.slice(150).map((e) => e.id)).toEqual(Array.from({ length: 30 }, (_, i) => 1151 + i));
  await expect(page.getByText('180 SAVED GROUPS')).toBeVisible();

  // migrated names are looked up in small batches, not all at once
  await expect.poll(() => groupInfoRequests.length).toBe(20);
  await page.waitForTimeout(1500);
  expect(groupInfoRequests.length).toBe(20);
  await expect.poll(async () => (await stored()).find((e) => e.id === 1151)?.name).toBe('Fetched 1151');

  await page.getByRole('button', { name: 'Save group' }).first().click();
  await expect.poll(async () => (await stored()).length).toBe(181);
  const afterSave = await stored();
  expect(afterSave[0].id).toBe(101);
  expect(afterSave.slice(1).map((e) => e.id)).toEqual(afterMigration.map((e) => e.id));
  await expect(page.getByText('181 SAVED GROUPS')).toBeVisible();
});

test('a full browser storage shows an error and never overwrites saved groups', async ({ page }) => {
  test.setTimeout(60000);
  await mockApi(page);
  const folder = Array.from({ length: 120 }, (_, i) => saved(1001 + i));
  await page.addInitScript(([folderKey, legacyKey, f]) => {
    // simulate a full storage for the saved-groups folder while window.__storageFull is set
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if ((window as unknown as { __storageFull?: boolean }).__storageFull && key === folderKey) throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(folderKey as string, JSON.stringify(f));
      localStorage.setItem(legacyKey as string, JSON.stringify([500, 501]));
      sessionStorage.setItem('seeded', '1');
      sessionStorage.setItem('full', '1');
    }
    (window as unknown as { __storageFull?: boolean }).__storageFull = sessionStorage.getItem('full') === '1';
  }, [FOLDER_KEY, LEGACY_KEY, folder]);

  // migration while storage is full: error shown, both stored lists left exactly as they were
  await page.goto('http://127.0.0.1:5173/?u=Alpha&tab=groups');
  await profileShown(page, 'Alpha');
  await expect(page.getByText('Browser storage is full')).toBeVisible();
  const raw = () => page.evaluate(([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)], [FOLDER_KEY, LEGACY_KEY]);
  const before = await raw();
  expect(before).toEqual([JSON.stringify(folder), '[500,501]']);

  // saving a new group while full: error, button not marked saved, storage untouched
  await page.getByRole('button', { name: 'Save group' }).first().click();
  await expect(page.getByText(/Clothing Club was not saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save group' }).first()).toBeEnabled();
  expect(await raw()).toEqual(before);
  await expect(page.getByText('Group saved')).toHaveCount(0);

  // once there is room again, the old list merges and nothing was lost
  await page.evaluate(() => sessionStorage.setItem('full', '0'));
  await page.reload();
  await profileShown(page, 'Alpha');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]').length, FOLDER_KEY)).toBe(122);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBeNull();
});
