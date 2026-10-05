// Account deletion end to end, on a throwaway account (never the shared test account):
// seed data -> delete through the UI -> sign up again with the same email in the same session -> look for leftovers.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;

test('account deletion leaves nothing behind', async ({ page }) => {
  test.setTimeout(240000);
  const out = {
    step: 'start', email: null, oldUid: null, newUid: null, sameUid: null,
    seededToday: null, deleteStatus: null, deleteBody: null,
    reSignup: null, reSignupError: null,
    stateAfterSignup: null, todayShowsOldData: null, reviewCardShowsOld: null,
    clubStillExists: null, afterReload: null, errors: [],
  };
  const email = `cadence-qa-${Date.now()}@example.com`;
  const pass = 'QaPass-' + Math.random().toString(36).slice(2, 10) + '!9';
  out.email = email;

  try {
    page.on('pageerror', (e) => out.errors.push(e.message));
    page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('DELETE') : d.accept()));

    // ---- 1. brand-new account ----
    out.step = 'signup';
    await page.goto(URL);
    await expect(page.locator('#auth')).toBeVisible({ timeout: 20000 });
    await page.click('#btnToggleMode');
    await page.fill('#authEmail', email);
    await page.fill('#authPass', pass);
    await page.click('#btnEmail');
    await expect(page.locator('#onboarding:not(.hidden)')).toBeVisible({ timeout: 30000 });

    // ---- 2. seed recognisable data straight into Firestore ----
    out.step = 'seed';
    const seeded = await page.evaluate(async () => {
      const uid = auth.currentUser.uid;
      const wk = isoWeekId();
      const profile = { name: 'QA', age: 30, sex: 'Male', heightCm: 175, weightKg: 70, sports: ['Running'], level: 'beginner', goals: ['general'], goal: 'general',
        days: [0, 1, 2, 3, 4, 5, 6], sessionMin: 60, sessionTime: '18:00', doubles: 'no', equipment: ['Full gym'], injuries: '', deadline: null, nutrition: null,
        timezone: 'Europe/Brussels', lang: 'en', equipmentConfirmed: true, noDeadline: true, nutritionDeclined: true, updatedAt: new Date().toISOString() };
      await db.doc('users/' + uid).set({ profile, email: auth.currentUser.email });
      await db.collection('users/' + uid + '/weights').add({ kg: 70, at: new Date().toISOString() });
      const sessions = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, slot: 0, timeOfDay: 'morning', title: 'LEAK-CHECK day ' + d, type: 'strength', fixed: false, durationMin: 45,
        intent: 'seeded', warmup: [], exercises: [{ name: 'Back squat', sets: 3, reps: '5', load: '60 kg', restSec: 90, cues: '' }], cooldown: [] }));
      await db.doc('users/' + uid + '/plans/' + wk).set({ weekId: wk, phase: 'base', focus: 'LEAK-CHECK', sessions, rationale: '', createdAt: new Date().toISOString() });
      await db.doc('users/' + uid + '/logs/' + wk + '-0').set({ weekId: wk, day: 0, slot: 0, title: 'LEAK-CHECK day 0', type: 'strength', status: 'done',
        exercises: [{ name: 'Back squat', sets: [{ reps: 5, load: 60, done: true }] }], loggedAt: new Date().toISOString(), setsDone: 1, setsTotal: 1 });
      await db.doc('users/' + uid + '/reviews/' + wk).set({ weekId: wk, createdAt: new Date().toISOString(), summary: 'LEAK-REVIEW', stats: { adherence: 100 } });
      const club = await db.collection('clubs').add({ name: 'QA club ' + uid.slice(0, 5), sport: 'Running', inviteCode: 'QA' + uid.slice(0, 4).toUpperCase(), createdBy: uid, createdAt: new Date().toISOString() });
      await db.doc('clubs/' + club.id + '/members/' + uid).set({ uid, name: 'QA', role: 'coach', code: 'QA' + uid.slice(0, 4).toUpperCase(), hidden: false, joinedAt: new Date().toISOString() });
      await db.doc('users/' + uid).set({ clubIds: [club.id], clubId: club.id }, { merge: true });
      return { uid, clubId: club.id };
    });
    out.oldUid = seeded.uid;
    const clubId = seeded.clubId;

    await page.reload();
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1200);
    out.seededToday = (await page.locator('#view').textContent()).includes('LEAK-CHECK');

    // ---- 3. delete through the real button ----
    out.step = 'delete';
    await page.click('.tab[data-view="profile"]');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/delete-account'), { timeout: 60000 }),
      page.click('#btnDelete'),
    ]);
    out.deleteStatus = res.status();
    out.deleteBody = (await res.text().catch(() => '')).slice(0, 600);
    await expect(page.locator('#auth')).toBeVisible({ timeout: 30000 });

    // ---- 4. register again with the same email, in the same browser session ----
    out.step = 'resignup';
    const label = ((await page.locator('#btnEmail').textContent()) || '').trim();
    if (/sign in/i.test(label)) await page.click('#btnToggleMode');
    await page.fill('#authEmail', email);
    await page.fill('#authPass', pass);
    await page.click('#btnEmail');
    for (let i = 0; i < 40; i++) {
      if (await page.locator('#onboarding:not(.hidden)').count()) { out.reSignup = 'onboarding'; break; }
      if (await page.locator('#app:not(.hidden)').count()) { out.reSignup = 'app (existing profile found!)'; break; }
      const err = ((await page.locator('#authError').textContent().catch(() => '')) || '').trim();
      if (err) { out.reSignup = 'error'; out.reSignupError = err; break; }
      await page.waitForTimeout(500);
    }
    if (out.reSignup !== 'onboarding' && out.reSignup !== 'app (existing profile found!)') return;

    out.newUid = await page.evaluate(() => (auth.currentUser ? auth.currentUser.uid : null));
    out.sameUid = out.newUid === out.oldUid;

    // what does the page still remember from the previous account?
    out.stateAfterSignup = await page.evaluate(() => ({
      planTitles: state.plan ? (state.plan.sessions || []).slice(0, 2).map((s) => s.title) : null,
      plans: state.plans.length, logs: Object.keys(state.logs).length, review: !!state.review,
      exHistorySize: typeof exHistory !== 'undefined' && exHistory ? exHistory.size : null,
      clubIds: state.clubIds, clubName: state.club ? state.club.name : null,
    }));

    // exactly what saving the onboarding form does: store the profile, then open the app
    out.step = 'finish-onboarding';
    await page.evaluate(async () => {
      const uid = auth.currentUser.uid;
      const profile = { name: 'QA2', age: 30, sex: 'Male', heightCm: 175, weightKg: 70, sports: ['Running'], level: 'beginner', goals: ['general'], goal: 'general',
        days: [1, 3, 5], sessionMin: 60, sessionTime: '18:00', doubles: 'no', equipment: ['Full gym'], injuries: '', deadline: null, nutrition: null,
        timezone: 'Europe/Brussels', lang: 'en', equipmentConfirmed: true, noDeadline: true, nutritionDeclined: true, updatedAt: new Date().toISOString() };
      await db.doc('users/' + uid).set({ profile, email: auth.currentUser.email }, { merge: true });
      state.profile = profile;
      enterApp();
    });
    await page.waitForTimeout(1800);
    out.todayShowsOldData = (await page.locator('#view').textContent()).includes('LEAK-CHECK');
    out.reviewCardShowsOld = await page.evaluate(() => !!(state.review && state.review.summary === 'LEAK-REVIEW'));

    // was the club left behind? (club documents are readable by any signed-in user)
    out.clubStillExists = await page.evaluate(async (id) => { try { return (await db.doc('clubs/' + id).get()).exists; } catch (e) { return 'unreadable: ' + e.code; } }, clubId);

    // and with a clean page load, does the server hand the old data to the new account?
    out.step = 'reload';
    await page.reload();
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const text = await page.locator('#view').textContent();
    out.afterReload = { hasOldPlan: text.includes('LEAK-CHECK'), text: text.slice(0, 140) };
    out.step = 'done';
  } finally {
    // never leave test accounts behind
    try { await page.evaluate(() => (auth.currentUser ? api('/api/delete-account') : null)); } catch (_) { /* best effort */ }
    fs.writeFileSync('deletion-result.json', JSON.stringify(out, null, 2));
  }
});
