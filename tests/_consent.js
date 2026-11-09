// Sign-up needs the consent box ticked; accounts made before consent existed get a one-time prompt after signing in.
export async function consentBefore(page) {
  if (await page.isVisible('#consentBox')) await page.check('#consentBox');
}
export async function consentAfter(page) {
  await page.waitForSelector('#consentAgree, #app:not(.hidden), #onboarding:not(.hidden), #authError:not(:empty)', { timeout: 30000 }).catch(() => {});
  if (await page.isVisible('#consentAgree')) { await page.check('#consentBox2'); await page.click('#consentAgree'); }
}
