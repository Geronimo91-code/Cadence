// Uploads a real photo through the Nutrition screen and records what the API returns.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;
const out = { step: 'start', status: null, body: null, filled: null, errors: [] };

// a tiny valid JPEG (solid colour) — enough to exercise the upload and the model call
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABkAGQBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';

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
    fs.writeFileSync('/tmp/meal.jpg', Buffer.from(JPEG_B64, 'base64'));
    await page.setInputFiles('#mealFile', '/tmp/meal.jpg');
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
