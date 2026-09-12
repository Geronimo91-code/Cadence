// Runs only on manual dispatch (it spends model quota): clicks "Build my first week" end to end.
import { test, expect } from '@playwright/test';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;

test('generate a plan end to end', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.fill('#authEmail', EMAIL);
  await page.fill('#authPass', PASS);
  await page.click('#btnEmail');
  await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });

  const build = page.locator('#btnGen');
  if (await build.count()) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/generate-plan'), { timeout: 180000 }),
      build.click(),
    ]);
    const body = await res.text().catch(() => '');
    expect(res.status(), 'generate-plan returned ' + res.status() + ': ' + body.slice(0, 200)).toBe(200);
  }
  await page.click('.tab[data-view="plan"]');
  await expect(page.locator('.session-row').first()).toBeVisible({ timeout: 20000 });
  const counts = await page.locator('.session-row').count();
  expect(counts, 'a full week should list 7 days').toBe(7);
  const openable = page.locator('.session-row:has(.chev)').first();
  await expect(openable, 'at least one trainable session').toBeVisible();
  await openable.click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toContainText('Warm-up');
  await expect(sheet.locator('.ex').first()).toBeVisible();
  expect(errors, 'uncaught page errors: ' + errors.join(' | ')).toHaveLength(0);
});
