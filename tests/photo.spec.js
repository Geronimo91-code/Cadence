// Uploads a real photo through the nutrition screen and records what the API said.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;
const out = { step: 'start', payloadBytes: null, status: null, body: null, filled: null, errors: [] };

test('meal photo estimation', async ({ page }) => {
  test.setTimeout(180000);
  try {
    page.on('pageerror', (e) => out.errors.push(e.message));
    await page.goto(URL);
    await page.fill('#authEmail', EMAIL);
    await page.fill('#authPass', PASS);
    await page.click('#btnEmail');
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });

    out.step = 'nutrition';
    await page.click('.tab[data-view="nutrition"]');
    const fileInput = page.locator('#mealFile');
    if (!(await fileInput.count())) { out.step = 'no-photo-input (nutrition may be off)'; return; }

    // measure what the client actually sends
    await page.route('**/api/estimate-meal', async (route) => {
      out.payloadBytes = (route.request().postData() || '').length;
      await route.continue();
    });

    out.step = 'upload';
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/estimate-meal'), { timeout: 120000 }),
      fileInput.setInputFiles('fixtures/meal.jpg'),
    ]);
    out.status = res.status();
    out.body = (await res.text().catch(() => '')).slice(0, 300);
    await page.waitForTimeout(1500);
    out.filled = {
      kcal: await page.locator('#mealK').inputValue(),
      protein: await page.locator('#mealP').inputValue(),
      name: await page.locator('#mealName').inputValue(),
    };
    out.step = 'done';
  } finally {
    fs.writeFileSync('photo-result.json', JSON.stringify(out, null, 2));
  }
});
