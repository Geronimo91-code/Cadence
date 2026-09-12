// Walks Edit setup to the availability screen and checks the per-day preference rows work.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;
const out = { step: 'start', servedVersion: null, hasDayPrefsCode: null, rows: null, selects: null, savedPref: null, reviewLine: null, errors: [] };

test('per-day preferences render and save', async ({ page, request }) => {
  test.setTimeout(180000);
  try {
    // what is actually deployed?
    const html = await (await request.get(URL + '/index.html')).text();
    out.hasDayPrefsCode = html.includes('renderDayPrefs');
    const sw = await (await request.get(URL + '/sw.js')).text();
    out.servedVersion = (sw.match(/cadence-v\d+/) || [])[0] || null;

    page.on('pageerror', (e) => out.errors.push(e.message));
    await page.goto(URL);
    await page.fill('#authEmail', EMAIL);
    await page.fill('#authPass', PASS);
    await page.click('#btnEmail');
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });

    out.step = 'edit-setup';
    await page.click('.tab[data-view="profile"]');
    await page.click('#btnEdit');
    await expect(page.locator('#onboarding:not(.hidden)')).toBeVisible();
    // basics → sports → goal → availability
    for (let i = 0; i < 3; i++) { await page.click('#btnObNext'); await page.waitForTimeout(400); }
    await expect(page.locator('#obStep h2')).toContainText(/train/i);

    out.step = 'dayprefs';
    await page.waitForTimeout(500);
    out.rows = await page.locator('.dayrow').count();
    out.selects = await page.locator('.dayrow select').count();
    if (out.rows > 0) {
      const first = page.locator('.dayrow').first();
      await first.locator('select.p-time').selectOption('morning');
      await first.locator('select.p-focus').selectOption('strength');
      out.savedPref = await first.locator('select.p-time').inputValue() + '/' + await first.locator('select.p-focus').inputValue();
      // walk to the review screen and read the Days line
      for (let i = 0; i < 4; i++) { await page.click('#btnObNext'); await page.waitForTimeout(400); }
      const review = await page.locator('.review').textContent().catch(() => '');
      out.reviewLine = (review || '').slice(0, 300);
    }
    out.step = 'done';
  } finally {
    fs.writeFileSync('dayprefs-result.json', JSON.stringify(out, null, 2));
  }
});
