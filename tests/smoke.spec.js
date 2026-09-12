import { test, expect } from '@playwright/test';

const URL = process.env.CADENCE_URL || 'https://cadence-xi-one.vercel.app';
const EMAIL = process.env.CADENCE_TEST_EMAIL, PASS = process.env.CADENCE_TEST_PASSWORD;

test('site and API routes respond', async ({ request }) => {
  expect((await request.get(URL)).ok()).toBeTruthy();
  const sw = await request.get(URL + '/sw.js'); expect(sw.ok()).toBeTruthy();
  const gp = await request.get(URL + '/api/generate-plan'); expect(gp.status()).toBe(405);
  const rv = await request.post(URL + '/api/weekly-review'); expect(rv.status()).toBe(401);
  const cron = await request.get(URL + '/api/daily-notify'); expect(cron.status()).toBe(401);
});

test('sign in with email and reach the app', async ({ page }) => {
  test.skip(!EMAIL || !PASS, 'CADENCE_TEST_EMAIL / CADENCE_TEST_PASSWORD secrets not set');
  await page.goto(URL);
  await page.fill('#authEmail', EMAIL);
  await page.fill('#authPass', PASS);
  await page.click('#btnEmail');
  await expect(page.locator('#onboarding:not(.hidden), #app:not(.hidden)').first()).toBeVisible({ timeout: 30000 });
  const onboarding = await page.locator('#onboarding').isVisible();
  if (onboarding) {
    await expect(page.locator('#obStep h2')).toContainText("Let's start with you");
    return; // fresh test account: onboarding rendering is enough for a smoke test
  }
  for (const [view, title] of [['plan', 'This week'], ['log', 'Log'], ['nutrition', 'Nutrition'], ['club', 'Club'], ['profile', 'Profile'], ['today', 'Today']]) {
    await page.click(`.tab[data-view="${view}"]`);
    await expect(page.locator('#topTitle')).toHaveText(title);
  }
  await expect(page.locator('#view')).not.toContainText('Something went wrong');
});
