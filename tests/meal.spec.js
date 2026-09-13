// Uploads a real photo through the Nutrition screen and records what the API returns.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;
const out = { step: 'start', status: null, body: null, filled: null, errors: [] };

// a real 8x8 PNG (valid bytes, decodes in any browser)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVQoz2NkYPjPQApgYqAQjBowasCoAaMGjBowasCoAaMGjBowasBQNgAAtxgBc0i3JwAAAAAASUVORK5CYII=';

test('meal photo estimate', async ({ page }) => {
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
    const photo = page.locator('#mealPhoto');
    if (!(await photo.count())) { out.step = 'nutrition-off'; return; }

    out.step = 'upload';
    fs.writeFileSync('/tmp/meal.png', Buffer.from(PNG_B64, 'base64'));
    await page.setInputFiles('#mealFile', '/tmp/meal.png');
    // catch a client-side failure (bad decode) rather than waiting two minutes for a request that never comes
    page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text().slice(0, 120)); });
    const res = await page.waitForResponse((r) => r.url().includes('/api/estimate-meal'), { timeout: 120000 });
    out.status = res.status();
    out.body = (await res.text().catch(() => '')).slice(0, 400);
    await page.waitForTimeout(1500);
    out.filled = {
      kcal: await page.locator('#mealK').inputValue(),
      protein: await page.locator('#mealP').inputValue(),
      name: await page.locator('#mealName').inputValue(),
    };
    out.step = 'done';
  } finally {
    fs.writeFileSync('meal-result.json', JSON.stringify(out, null, 2));
  }
});
