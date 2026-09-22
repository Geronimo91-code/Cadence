// Clicks "Close the week" and records what happens, end to end.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;
const out = { step: 'start', planWeek: null, buttonFound: false, status: null, body: null, reviewSheet: null, toast: null, errors: [] };

test('close the week', async ({ page }) => {
  test.setTimeout(240000);
  try {
    page.on('pageerror', (e) => out.errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(URL);
    await page.fill('#authEmail', EMAIL);
    await page.fill('#authPass', PASS);
    await page.click('#btnEmail');
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });

    out.step = 'plan';
    await page.click('.tab[data-view="plan"]');
    await page.waitForTimeout(1200);
    // make sure we are on this week, not next
    const thisWeek = page.locator('.seg button', { hasText: 'This week' });
    if (await thisWeek.count()) { await thisWeek.click(); await page.waitForTimeout(800); }
    out.planWeek = await page.evaluate(() => document.querySelector('#view .badge')?.parentElement?.textContent?.slice(0, 80) || null);

    const btn = page.locator('#btnClose');
    out.buttonFound = (await btn.count()) > 0;
    if (!out.buttonFound) { out.step = 'no-close-button'; out.viewText = (await page.locator('#view').textContent()).slice(0, 400); return; }

    out.step = 'closing';
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/weekly-review'), { timeout: 150000 }),
      btn.click(),
    ]);
    out.status = res.status();
    out.body = (await res.text().catch(() => '')).slice(0, 500);
    await page.waitForTimeout(2500);
    out.reviewSheet = await page.locator('.sheet').count() > 0;
    out.toast = await page.locator('#toast').textContent().catch(() => null);
    out.step = 'done';
  } finally {
    fs.writeFileSync('review-result.json', JSON.stringify(out, null, 2));
  }
});
