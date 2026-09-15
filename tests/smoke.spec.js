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
  expect((await request.post(URL + '/api/reset-data')).status()).toBe(401);
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
  await expect(page.locator('#view')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scroll: doc.scrollHeight,
      view: window.innerHeight,
      cols: document.querySelectorAll('.board .col').length,
      state: document.querySelector('.board') ? 'week in progress'
        : /Next week/i.test(document.querySelector('#view').textContent) ? 'next week ready'
        : /No plan yet/i.test(document.querySelector('#view').textContent) ? 'no plan'
        : /is over/i.test(document.querySelector('#view').textContent) ? 'week over' : 'unknown',
      blocks: [...document.querySelectorAll('#view > *')].map((e) => `${e.className || e.tagName}:${Math.round(e.getBoundingClientRect().height)}`),
    };
  });
  fs.writeFileSync('today-result.json', JSON.stringify(m, null, 2));
  expect(m.state, 'Today should be in a known state').not.toBe('unknown');
  if (m.state === 'week in progress') expect(m.cols, 'week board should show 7 days').toBe(7);
  expect(m.scroll, `page is ${m.scroll}px for a ${m.view}px screen (${m.state}) — ${m.blocks.join(', ')}`).toBeLessThanOrEqual(m.view + 40);
});

test('dark theme applies', async ({ page }) => {
  await signIn(page);
  await page.click('.tab[data-view="profile"]');
  await page.selectOption('#selTheme', 'dark');
  await page.waitForTimeout(400);
  const c = await page.evaluate(() => {
    const st = getComputedStyle(document.body);
    return { bg: st.backgroundColor, ink: st.color, attr: document.documentElement.dataset.theme,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--green').trim() };
  });
  expect(c.attr).toBe('dark');
  expect(c.bg, 'dark background').toMatch(/rgb\(14, 16, 18\)/);
  expect(c.accent.toLowerCase(), 'orange accent').toBe('#f0862a');
  await page.selectOption('#selTheme', 'light');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(back).toMatch(/rgb\(246, 247, 244\)/);
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
