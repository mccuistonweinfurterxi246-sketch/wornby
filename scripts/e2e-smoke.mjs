// End-to-end smoke test of the real app against the real Roblox API (no mocks), in Chrome.
// Usage: node scripts/e2e-smoke.mjs [baseUrl] [screenshotDir]   (default http://127.0.0.1:5173)
import { chromium } from '@playwright/test';

const BASE = process.argv[2] || 'http://127.0.0.1:5173';
const SHOTS = process.argv[3] || 'test-results/e2e';
const browser = await chromium.launch({ channel: 'chrome' });
// Protected Vercel previews: pass the bypass secret via env (never logged).
const extraHTTPHeaders = process.env.VERCEL_BYPASS ? { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS } : {};
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, extraHTTPHeaders });
const api = [];
page.on('response', (res) => {
  const url = new URL(res.url());
  if (url.pathname.startsWith('/api/')) api.push({ status: res.status(), path: url.pathname + url.search.slice(0, 40), ms: Math.round(res.request().timing().responseEnd) });
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
async function step(name, fn) {
  const started = performance.now();
  try {
    await fn();
    results.push({ step: name, ok: true, ms: Math.round(performance.now() - started) });
  } catch (e) {
    results.push({ step: name, ok: false, ms: Math.round(performance.now() - started), error: e.message.split('\n')[0] });
  }
  await page.screenshot({ path: `${SHOTS}/${results.length}-${name.replace(/\W+/g, '-')}.png` });
}

const search = page.getByRole('textbox', { name: 'Roblox username, user ID, or profile link' });
await step('open app', async () => {
  await page.goto(BASE);
  await search.waitFor({ timeout: 15000 });
});
await step('typeahead suggestions', async () => {
  await search.fill('builder');
  await page.waitForResponse((r) => r.url().includes('/api/users/search') && r.status() === 200, { timeout: 10000 });
});
await step('load profile Shedletsky', async () => {
  const profile = page.waitForResponse((r) => r.url().includes('/api/user/Shedletsky') && r.status() === 200, { timeout: 20000 });
  await search.fill('Shedletsky');
  await search.press('Enter');
  await profile;
  await page.getByText('OUTFIT VALUE', { exact: false }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
});
await step('open first group store', async () => {
  await page.getByRole('tab', { name: /communities/i }).click({ timeout: 10000 });
  const storeResponse = page.waitForResponse((r) => r.url().includes('/store?') && r.status() === 200, { timeout: 20000 });
  const summaryResponse = page.waitForResponse((r) => r.url().includes('/store-summary') && r.status() === 200, { timeout: 20000 });
  // force: the cards animate continuously, so Playwright never sees them as "stable".
  await page.getByRole('button', { name: 'Browse Group Store' }).first().click({ timeout: 10000, force: true });
  await storeResponse;
  // Sections with exact counts from the server summary.
  await summaryResponse;
  await page.getByRole('group', { name: 'Store sections' }).getByRole('button', { name: /CLOTHING\s*\d/ }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
});
await step('group members → hop to a member', async () => {
  const members = page.waitForResponse((r) => r.url().includes('/members') && r.status() === 200, { timeout: 20000 });
  await page.getByRole('tab', { name: 'MEMBERS' }).click({ timeout: 10000 });
  await members;
  const before = page.url();
  const profile = page.waitForResponse((r) => r.url().includes('/api/user/') && r.status() === 200, { timeout: 25000 });
  await page.getByRole('button', { name: /^Open @/ }).first().click({ timeout: 10000 });
  await profile;
  await page.waitForURL((u) => u.toString() !== before && !u.searchParams.has('store'), { timeout: 10000 });
  await page.getByRole('navigation', { name: 'Explore trail' }).first().waitFor({ timeout: 10000 });
});
await step('back restores the members tab', async () => {
  await page.goBack();
  await page.getByRole('button', { name: /^Open @/ }).first().waitFor({ timeout: 20000 });
});
await step('group experiences + assets tabs', async () => {
  const games = page.waitForResponse((r) => r.url().includes('/experiences') && r.status() === 200, { timeout: 20000 });
  await page.getByRole('tab', { name: 'EXPERIENCES' }).click();
  await games;
  // Exact per-type counts first; the list only loads for types that have items.
  const assets = page.waitForResponse((r) => r.url().includes('/assets-summary') && r.status() === 200, { timeout: 20000 });
  await page.getByRole('tab', { name: 'ASSETS' }).click();
  await assets;
  await page.waitForTimeout(1000);
});
await step('creations of a UGC creator (1258172556)', async () => {
  await page.keyboard.press('Escape');
  const profile = page.waitForResponse((r) => r.url().includes('/api/user/1258172556') && r.status() === 200, { timeout: 20000 });
  await search.fill('1258172556');
  await search.press('Enter');
  await profile;
  const creations = page.waitForResponse((r) => r.url().includes('/creations') && r.status() === 200, { timeout: 20000 });
  await page.getByRole('tab', { name: 'CREATIONS' }).click();
  await creations;
  await page.getByText(/^MADE BY @/).first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
});
await step('load profile 156 (builderman) + outfit archive', async () => {
  await page.keyboard.press('Escape');
  const profile = page.waitForResponse((r) => r.url().includes('/api/user/156') && r.status() === 200, { timeout: 20000 });
  await search.fill('156');
  await search.press('Enter');
  await profile;
  const archive = page.waitForResponse((r) => /\/api\/users\/156\/archive(\?|$)/.test(r.url()) && r.status() === 200, { timeout: 30000 });
  await page.getByRole('tab', { name: 'ARCHIVE' }).click();
  await archive;
  await page.getByRole('button', { name: /^View fit / }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
});

console.table(results);
console.log('API calls:');
console.table(api);
console.log(`page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
await browser.close();
process.exit(results.every((r) => r.ok) && api.every((c) => c.status < 500) ? 0 : 1);
