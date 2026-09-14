import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;

async function signIn(page) {
  await page.goto(URL);
  await expect(page.locator('#auth')).toBeVisible({ timeout: 20000 });
  await page.fill('#authEmail', EMAIL);
  await page.fill('#authPass', PASS);
  await page.click('#btnEmail');
  await expect(page.locator('#app:not(.hidden), #onboarding:not(.hidden)').first()).toBeVisible({ timeout: 30000 });
  if (await page.locator('#onboarding').isVisible()) throw new Error('Test account has no profile — complete onboarding once with it');
}

test('site and API routes', async ({ request }) => {
  expect((await request.get(URL)).ok()).toBeTruthy();
  expect((await request.get(URL + '/sw.js')).ok()).toBeTruthy();
  expect((await request.get(URL + '/i18n.js')).ok()).toBeTruthy();
  expect((await request.get(URL + '/manifest.json')).ok()).toBeTruthy();
  expect((await request.get(URL + '/api/generate-plan')).status()).toBe(405);
  expect((await request.post(URL + '/api/weekly-review')).status()).toBe(401);
  expect((await request.post(URL + '/api/estimate-meal')).status()).toBe(401);
  expect((await request.get(URL + '/api/daily-notify')).status()).toBe(401);
  expect((await request.get(URL + '/api/calendar')).status()).toBe(400);
  expect((await request.post(URL + '/api/club-session')).status()).toBe(401);
  expect((await request.post(URL + '/api/test-notify')).status()).toBe(401);
  expect((await request.get(URL + '/privacy.html')).ok()).toBeTruthy();
  expect((await request.get(URL + '/terms.html')).ok()).toBeTruthy();
});

test('sign in and tabs', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  for (const [view, title] of [['plan', 'This week'], ['log', 'Log'], ['nutrition', 'Nutrition'], ['club', 'Club'], ['profile', 'Profile'], ['today', 'Today']]) {
    await page.click(`.tab[data-view="${view}"]`);
    await expect(page.locator('#topTitle')).toHaveText(title);
    await expect(page.locator('#view')).not.toContainText('Something went wrong');
  }
  expect(errors, 'uncaught page errors: ' + errors.join(' | ')).toHaveLength(0);
});

test('today fits one screen', async ({ page }) => {
  await signIn(page);
  await page.click('.tab[data-view="today"]');
  await expect(page.locator('.board')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const blocks = [...document.querySelectorAll('#view > *')].map((e) => `${e.className || e.tagName}:${Math.round(e.getBoundingClientRect().height)}`);
    return { scroll: doc.scrollHeight, view: window.innerHeight, cols: document.querySelectorAll('.board .col').length, blocks };
  });
  fs.writeFileSync('today-result.json', JSON.stringify(m, null, 2));
  expect(m.cols, 'week board should show 7 days').toBe(7);
  expect(m.scroll, `page is ${m.scroll}px for a ${m.view}px screen — ${m.blocks.join(', ')}`).toBeLessThanOrEqual(m.view + 40);
});

test('plan and session view', async ({ page }) => {
  await signIn(page);
  await page.click('.tab[data-view="plan"]');
  await expect(page.locator('#view')).toBeVisible();
  const rows = page.locator('.slot');
  if (!(await rows.count())) {
    // No plan on the test account: the empty state must still offer a way forward
    await expect(page.locator('#view')).toContainText(/No plan yet|Build your first week/);
    return;
  }
  const openable = page.locator('button.slot:has(.chev)').first();
  if (!(await openable.count())) return; // rest-only week
  await openable.click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#logEx')).toBeVisible();
  await expect(sheet.locator('#sessRpe button')).toHaveCount(10);
  await expect(sheet.locator('#btnSaveLog')).toBeVisible();
  await sheet.locator('#btnCloseSheet').click();
  await expect(page.locator('.sheet')).toHaveCount(0);
});

test('nutrition and club render', async ({ page }) => {
  await signIn(page);
  await page.click('.tab[data-view="nutrition"]');
  await expect(page.locator('#view')).toBeVisible();
  await page.click('.tab[data-view="log"]');
  await expect(page.locator('#view')).toContainText(/Weight|Progress|Sessions/);
  await page.click('.tab[data-view="club"]');
  await expect(page.locator('#view')).toContainText(/Club|Join|Leaderboard|Members/);
  await page.click('.tab[data-view="profile"]');
  await expect(page.locator('#selLang')).toBeVisible();
  await page.selectOption('#selLang', 'fr');
  await expect(page.locator('.tab[data-view="today"]')).toContainText("Aujourd'hui");
  await page.selectOption('#selLang', 'en');
});
