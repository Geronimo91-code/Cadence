// Manual-dispatch only: clicks "Build my first week" and records the outcome to gen-result.json.
// The workflow then asserts on that file in separate steps, so the reason is visible without log access.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;
const EMAIL = process.env.CADENCE_TEST_EMAIL;
const PASS = process.env.CADENCE_TEST_PASSWORD;
const out = { step: 'start', status: null, error: null, days: null, trainable: null, sheetOk: null, pageErrors: [] };

test('generate a plan end to end', async ({ page }) => {
  test.setTimeout(300000);
  try {
    page.on('pageerror', (e) => out.pageErrors.push(e.message));
    await page.goto(URL);
    out.step = 'signin';
    await page.fill('#authEmail', EMAIL);
    await page.fill('#authPass', PASS);
    await page.click('#btnEmail');
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });

    out.step = 'find-button';
    const build = page.locator('#btnGen');
    const rebuild = page.locator('#btnRebuild');
    let trigger = null;
    if (await build.count()) trigger = build;
    else { await page.click('.tab[data-view="plan"]'); if (await rebuild.count()) { page.once('dialog', (d) => d.accept()); trigger = rebuild; } }
    if (!trigger) { out.step = 'no-trigger'; return; }

    out.step = 'generating';
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/generate-plan'), { timeout: 200000 }),
      trigger.click(),
    ]);
    out.status = res.status();
    if (out.status !== 200) { out.error = (await res.text().catch(() => '')).slice(0, 300); return; }

    out.step = 'render';
    await page.click('.tab[data-view="plan"]');
    await expect(page.locator('.session-row').first()).toBeVisible({ timeout: 30000 });
    out.days = await page.locator('.session-row').count();
    out.trainable = await page.locator('.session-row:has(.chev)').count();
    if (out.trainable) {
      await page.locator('.session-row:has(.chev)').first().click();
      const sheet = page.locator('.sheet');
      await expect(sheet).toBeVisible({ timeout: 10000 });
      out.sheetOk = (await sheet.locator('.ex').count()) > 0 && (await sheet.locator('#sessRpe button').count()) === 10;
    }
    out.step = 'done';
  } finally {
    fs.writeFileSync('gen-result.json', JSON.stringify(out, null, 2));
  }
});
