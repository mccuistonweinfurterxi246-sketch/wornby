import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { channel: 'chrome' } });

const APP = 'http://127.0.0.1:5173/';
type G = { id: number; name: string; roleRank?: number };
const group = (g: G) => ({ id: g.id, name: g.name, memberCount: g.id * 10, hasVerifiedBadge: false, roleName: g.roleRank === 255 ? 'Owner' : 'Member', roleRank: g.roleRank ?? 1, iconUrl: null });

/** Players by name: id + groups. Members by group id. */
const PLAYERS: Record<string, { id: number; groups: G[] }> = {
  Alpha: { id: 1, groups: [{ id: 10, name: 'Gee Club', roleRank: 255 }, { id: 30, name: 'Shared Hub' }] },
  Beta: { id: 2, groups: [{ id: 20, name: 'Aitch Crew' }, { id: 30, name: 'Shared Hub' }] },
  Gamma: { id: 3, groups: [{ id: 20, name: 'Aitch Crew' }] },
};
const MEMBERS: Record<number, string[]> = { 10: ['Alpha', 'Beta', 'Ghost'], 20: ['Beta', 'Gamma'], 30: ['Alpha', 'Beta'] };

const WORN_ITEM = { id: 800, name: 'Worn Hat', description: '', assetTypeName: 'Hat', creatorName: 'Roblox', price: 10, isForSale: true, isOffSale: false, isDeletedOrModerated: false, isFree: false, thumbnailUrl: null, studioLuaCommand: '', catalogUrl: 'https://www.roblox.com/catalog/800' };

type Calls = { members: string[]; creations: number; profiles: string[] };

async function mockApi(page: Page, opts: { membersStatus?: () => number } = {}): Promise<Calls> {
  const calls: Calls = { members: [], creations: 0, profiles: [] };
  await page.route('**/api/user/**', async (route) => {
    const q = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '');
    calls.profiles.push(q);
    if (q === '99' || q.toLowerCase() === 'ghost') return route.fulfill({ status: 404, json: { error: 'User not found' } });
    const name = Object.keys(PLAYERS).find((n) => n.toLowerCase() === q.toLowerCase() || String(PLAYERS[n].id) === q) || 'Alpha';
    const p = PLAYERS[name];
    const profile = {
      user: { id: p.id, name, displayName: `${name} D`, hasVerifiedBadge: false },
      thumbnails: { fullBodyUrl: null, headshotUrl: null },
      outfit: { totalValueRobux: 0, hasOffSaleItems: false, offSaleCount: 0, freeCount: 0, pricedCount: 0, itemCount: 1, items: [WORN_ITEM] },
      groups: p.groups.map(group),
      telemetry: { cached: false, timestamp: Date.now(), responseTimeMs: 1, wearingAssetCount: 0 },
    };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(profile)}\n\n` });
  });
  await page.route(/\/api\/group\/\d+$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    const g = Object.values(PLAYERS).flatMap((p) => p.groups).find((x) => x.id === id);
    return route.fulfill({ json: { id, name: g?.name ?? `Group ${id}`, memberCount: id * 10, owner: { userId: 1, username: 'Alpha', displayName: 'Alpha D' } } });
  });
  await page.route(/\/api\/group\/\d+\/store/, (route) => route.fulfill({ json: { items: [], nextPageCursor: null } }));
  await page.route(/\/api\/group\/\d+\/store-status/, (route) => route.fulfill({ json: { hasItems: false } }));
  await page.route(/\/api\/group\/\d+\/store-summary/, (route) => route.fulfill({ json: {
    clothing: { count: 0, more: false }, accessories: { count: 0, more: false }, heads: { count: 0, more: false }, animations: { count: 0, more: false } } }));
  await page.route(/\/api\/(users|group)\/\d+\/assets-summary/, (route) => route.fulfill({ json: { model: 1, decal: 1, mesh: 0 } }));
  await page.route(/\/api\/group\/\d+\/new-items/, (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/asset-thumbnails', (route) => route.fulfill({ json: { thumbnails: {} } }));
  await page.route(/\/api\/group\/(\d+)\/members/, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.match(/group\/(\d+)/)?.[1]);
    calls.members.push(`${id}:${new URL(route.request().url()).searchParams.get('cursor') ?? ''}`);
    const status = opts.membersStatus?.() ?? 200;
    if (status !== 200) return route.fulfill({ status, json: { error: 'Roblox is rate limiting requests right now, try again shortly.' } });
    const members = (MEMBERS[id] || []).map((n) => ({ id: PLAYERS[n]?.id ?? 99, name: n, displayName: `${n} D`, verified: false, role: { name: 'Member', rank: 1 }, headshotUrl: null }));
    return route.fulfill({ json: { members, nextPageCursor: null } });
  });
  await page.route(/\/api\/(users|group)\/\d+\/experiences/, (route) => route.fulfill({ json: { experiences: [
    { universeId: 5, placeId: 55, name: 'Obby World', description: null, moderated: false, visits: 1200, created: '2020-01-01T00:00:00Z', updated: '2024-01-01T00:00:00Z', iconUrl: null },
    { universeId: 6, placeId: 66, name: 'Old Place', description: null, moderated: true, visits: 3, created: '2019-01-01T00:00:00Z', updated: '2019-01-01T00:00:00Z', iconUrl: null },
  ], nextPageCursor: null } }));
  await page.route(/\/api\/(users|group)\/\d+\/assets\?/, (route) => {
    const type = new URL(route.request().url()).searchParams.get('type');
    return route.fulfill({ json: { assets: [{ id: type === 'decal' ? 902 : 901, name: type === 'decal' ? 'Cool Decal' : 'Cool Model', typeId: 10, created: '', updated: '', thumbnailUrl: null }], nextPageCursor: null } });
  });
  await page.route(/\/api\/users\/\d+\/creations/, (route) => {
    calls.creations++;
    return route.fulfill({ json: { items: [{ id: 700, name: 'Made Shirt', description: '', assetTypeName: 'Shirt', creatorName: 'Alpha', creatorType: 'User', price: 5, isForSale: true, isOffSale: false, isDeletedOrModerated: false, isFree: false, thumbnailUrl: null, studioLuaCommand: '', catalogUrl: 'https://www.roblox.com/catalog/700' }], nextPageCursor: null } });
  });
  await page.route(/\/api\/users\/\d+\/archive\/index/, (route) => route.fulfill({ json: { snapshots: [], complete: true } }));
  await page.route(/\/api\/users\/\d+\/archive$/, (route) => route.fulfill({ json: { inventory: 'public', outfits: [], complete: true } }));
  return calls;
}

async function openPlayer(page: Page, name: string) {
  const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
  await search.fill(name);
  await search.press('Enter');
  await expect(page).toHaveURL(new RegExp(`u=${name}`));
}

async function openGroup(page: Page, name: string) {
  await page.getByRole('tab', { name: /COMMUNITIES/ }).click();
  const card = page.locator('[data-group-card]').filter({ hasText: name });
  await card.getByRole('button', { name: 'Browse Group Store' }).click({ force: true });
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

test('group modal shows four tabs and ?gtab follows', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  const tabs = page.getByRole('tablist', { name: 'Group sections' });
  for (const t of ['STORE', 'EXPERIENCES', 'MEMBERS', 'ASSETS']) await expect(tabs.getByRole('tab', { name: t })).toBeVisible();
  await tabs.getByRole('tab', { name: 'MEMBERS' }).click();
  await expect(page).toHaveURL(/gtab=members/);
  await tabs.getByRole('tab', { name: 'STORE' }).click();
  await expect(page).not.toHaveURL(/gtab=/);
});

test('members tab lists members, each a button', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await expect(page.getByRole('button', { name: 'Open @Alpha' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open @Beta' })).toBeVisible();
});

test('experiences tab shows moderated chip', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'EXPERIENCES' }).click();
  await expect(page.getByText('Obby World')).toBeVisible();
  await expect(page.getByText('MODERATED')).toBeVisible();
});

test('assets tab switches type and refetches', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'ASSETS' }).click();
  await expect(page.getByText('Cool Model')).toBeVisible();
  await page.getByRole('button', { name: /DECALS/ }).click();
  await expect(page.getByText('Cool Decal')).toBeVisible();
});

test('feed 429 shows retry', async ({ page }) => {
  let status = 429;
  await mockApi(page, { membersStatus: () => status });
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await expect(page.getByText(/Roblox is busy/)).toBeVisible();
  status = 200;
  await page.getByRole('button', { name: 'RETRY' }).click();
  await expect(page.getByRole('button', { name: 'Open @Beta' })).toBeVisible();
  await page.getByRole('tab', { name: 'STORE' }).click();
  await expect(page.getByText('No items found')).toBeVisible();
});

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Explore trail' }).first();

async function memberHop(page: Page, from: string, groupName: string, to: string) {
  await openGroup(page, groupName);
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await page.getByRole('button', { name: `Open @${to}` }).click();
  await expect(page).toHaveURL(new RegExp(`u=${to}`));
  await expect(page).not.toHaveURL(/store=|gtab=/);
  await expect(page.getByRole('tablist', { name: 'Group sections' })).toHaveCount(0);
}

test('A → group members → B loads with trail A › G › B', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await memberHop(page, 'Alpha', 'Gee Club', 'Beta');
  await expect(crumbs(page)).toContainText(/Alpha D.*Gee Club.*Beta D/);
});

test('back restores group members tab, forward returns to B', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await memberHop(page, 'Alpha', 'Gee Club', 'Beta');
  const memberCalls = calls.members.length;
  await page.goBack();
  await expect(page).toHaveURL(/u=Alpha.*store=10.*gtab=members|u=Alpha.*gtab=members.*store=10/);
  await expect(page.getByRole('button', { name: 'Open @Beta' })).toBeVisible();
  expect(calls.members.length).toBe(memberCalls);
  await page.goForward();
  await expect(page).toHaveURL(/u=Beta/);
  await expect(page.getByRole('heading', { name: 'Gee Club' })).toHaveCount(0);
  await expect(crumbs(page)).toContainText(/Alpha D.*Gee Club.*Beta D/);
});

test('loop A→G→B→G cuts trail to A › G', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await memberHop(page, 'Alpha', 'Shared Hub', 'Beta');
  await openGroup(page, 'Shared Hub');
  const trail = crumbs(page);
  await expect(trail).toContainText(/Alpha D.*Shared Hub/);
  await expect(trail).not.toContainText('Beta D');
});

test('deep link ?u=Beta&store=20&gtab=members opens directly', async ({ page }) => {
  await mockApi(page);
  await page.goto(`${APP}?u=Beta&store=20&gtab=members`);
  await expect(page.getByRole('heading', { name: 'Aitch Crew' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open @Gamma' })).toBeVisible();
});

test('clicking a crumb navigates', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await memberHop(page, 'Alpha', 'Gee Club', 'Beta');
  await crumbs(page).getByRole('button', { name: /Alpha D/ }).click();
  await expect(page).toHaveURL(/u=Alpha/);
  await expect(page.getByRole('heading', { name: 'Alpha D' }).first()).toBeVisible();
});

test('creations tab sections load lazily', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  expect(calls.creations).toBe(0);
  await page.getByRole('tab', { name: 'CREATIONS' }).click();
  await expect(page.getByText('Made Shirt')).toBeVisible();
  expect(calls.creations).toBe(1);
  await expect(page).toHaveURL(/tab=creations/);
});

test('owner groups listed, non-owner groups not', async ({ page }) => {
  await mockApi(page);
  await page.goto(`${APP}?u=Alpha&tab=creations`);
  const fromGroups = page.getByRole('region', { name: 'From their groups' });
  await expect(fromGroups.getByText('Gee Club', { exact: true })).toBeVisible();
  await expect(fromGroups.getByText('Shared Hub')).toHaveCount(0);
});

test('source chips distinguish player, group, worn', async ({ page }) => {
  await mockApi(page);
  await page.goto(`${APP}?u=Alpha&tab=creations`);
  await expect(page.getByRole('region', { name: 'Clothing & accessories' }).getByText('MADE BY @Alpha')).toBeVisible();
  await expect(page.getByText('MADE BY Gee Club')).toBeVisible();
  await page.getByRole('tab', { name: /ARCHIVE/ }).click();
  await expect(page.getByText('WORN', { exact: true })).toBeVisible();
});

test('?tab=creations deep link opens the tab', async ({ page }) => {
  await mockApi(page);
  await page.goto(`${APP}?u=Beta&tab=creations`);
  await expect(page.getByRole('tab', { name: 'CREATIONS' })).toHaveAttribute('aria-selected', 'true');
});


test('member hop uses the id; a failed hop says so and stays put', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await page.getByRole('button', { name: 'Open @Ghost' }).click();
  await expect(page.getByText('User not found')).toBeVisible();
  expect(calls.profiles.at(-1)).toBe('99');
  await expect(page).toHaveURL(/u=Alpha/);
  await page.getByRole('button', { name: 'Open @Beta' }).click();
  await expect(page).toHaveURL(/u=Beta/);
  expect(calls.profiles.at(-1)).toBe('2');
});

test('back after closing a group reopens it on the same section', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tablist', { name: 'Group sections' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/store=|gtab=/);
  await page.goBack();
  await expect(page).toHaveURL(/gtab=members/);
  await expect(page.getByRole('button', { name: 'Open @Beta' })).toBeVisible();
});

test('the next group opens on its store', async ({ page }) => {
  await mockApi(page);
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await page.keyboard.press('Escape');
  await openGroup(page, 'Shared Hub');
  await expect(page.getByRole('tab', { name: 'STORE' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/gtab=/);
});

test('a bundle card copies its wearable head id, not the bundle id', async ({ page }) => {
  await mockApi(page);
  await page.route(/\/api\/group\/10\/store/, (route) => route.fulfill({ json: { items: [{
    id: 231497873499598, wearAssetId: 95289478498426, name: 'low quality small grin', description: '', assetTypeName: 'Avatar Bundle / Pack',
    creatorName: 'Gee Club', creatorType: 'Group', price: 75, isForSale: true, isOffSale: false, isDeletedOrModerated: false, isFree: false,
    thumbnailUrl: null, studioLuaCommand: 'game:GetService("InsertService"):LoadAsset(95289478498426).Parent = workspace',
    catalogUrl: 'https://www.roblox.com/bundles/231497873499598',
  }], nextPageCursor: null } }));
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  const copyButton = page.getByRole('button', { name: 'Copy Numeric Asset ID' }).first();
  await expect(copyButton).toContainText('95289478498426');
  await expect(page.getByText('231497873499598')).toHaveCount(0);
});

test('a hidden member list says so and still offers the owner', async ({ page }) => {
  await mockApi(page);
  await page.route(/\/api\/group\/10\/members/, (route) => route.fulfill({ json: {
    members: [], nextPageCursor: null, hidden: true, owner: { id: 2, name: 'Beta', displayName: 'Beta D' },
  } }));
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'MEMBERS' }).click();
  await expect(page.getByText("Roblox doesn't show this group's member list publicly.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'RETRY' })).toHaveCount(0);
  await expect(page.getByText('Roblox is busy')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open @Beta' }).click();
  await expect(page).toHaveURL(/u=Beta/);
});

const storeItem = (id: number, name: string, assetTypeName: string) => ({
  id, name, description: '', assetTypeName, creatorName: 'Gee Club', creatorType: 'Group', price: 5, isForSale: true, isOffSale: false,
  isDeletedOrModerated: false, isFree: false, thumbnailUrl: null, studioLuaCommand: '', catalogUrl: `https://www.roblox.com/catalog/${id}`, wearAssetId: id,
});

test('store shows four sections with exact counts and loads one section at a time', async ({ page }) => {
  await mockApi(page);
  const sections: string[] = [];
  await page.route(/\/api\/group\/10\/store\?/, (route) => {
    const section = new URL(route.request().url()).searchParams.get('section') || 'none';
    sections.push(section);
    const items = section === 'clothing' ? [storeItem(1, 'Cool Shirt', 'Shirt'), storeItem(2, 'Cool Pants', 'Pants')]
      : section === 'heads' ? [storeItem(3, 'Smile Head', 'Avatar Bundle / Pack')] : [];
    return route.fulfill({ json: { items, nextPageCursor: null } });
  });
  await page.route(/\/api\/group\/10\/store-summary/, (route) => route.fulfill({ json: {
    clothing: { count: 2, more: false }, accessories: { count: 5, more: false }, heads: { count: 548, more: false }, animations: { count: 0, more: false } } }));
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  const bar = page.getByRole('group', { name: 'Store sections' });
  await expect(bar.getByRole('button', { name: /CLOTHING\s*2/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: /ACCESSORIES\s*5/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: /HEADS & FACES\s*548/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: /ANIMATIONS\s*0/ })).toBeVisible();
  await expect(page.getByText('Cool Shirt')).toBeVisible();
  expect(sections).toEqual(['clothing']);
  await bar.getByRole('button', { name: /HEADS & FACES/ }).click();
  await expect(page.getByText('Smile Head')).toBeVisible();
  await expect(page.getByText('Cool Shirt')).toHaveCount(0);
  expect(sections).toEqual(['clothing', 'heads']);
  await expect(page.getByRole('button', { name: 'Asset type' })).toHaveCount(0);
  await expect(page.getByText('Mixed · 555').first()).toBeVisible();
});

test('assets shows only the types the creator has, with counts', async ({ page }) => {
  await mockApi(page);
  await page.route(/\/api\/group\/10\/assets-summary/, (route) => route.fulfill({ json: { model: 3, decal: 0, mesh: 0 } }));
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'ASSETS' }).click();
  await expect(page.getByRole('button', { name: /MODELS\s*3/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /DECALS/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /AUDIO|PLUGINS/ })).toHaveCount(0);
});

test('assets says so when the creator has none', async ({ page }) => {
  await mockApi(page);
  await page.route(/\/api\/group\/10\/assets-summary/, (route) => route.fulfill({ json: { model: 0, decal: 0, mesh: 0 } }));
  await page.goto(APP);
  await openPlayer(page, 'Alpha');
  await openGroup(page, 'Gee Club');
  await page.getByRole('tab', { name: 'ASSETS' }).click();
  await expect(page.getByText('No Creator Store assets published.')).toBeVisible();
});
