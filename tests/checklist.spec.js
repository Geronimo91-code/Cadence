// Phase 1 phone checklist, run by a browser on a throwaway account with a seeded plan (so nothing depends on what the shared test account holds).
// Covers: photo how-to, drill video search, unknown exercise, swap, Back closes only the top sheet, translated labels.
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;

test('phase 1 checklist: exercise how-to', async ({ page }) => {
  test.setTimeout(240000);
  const out = { step: 'start', checks: {}, errors: [] };
  const ok = (name, pass, detail) => { out.checks[name] = { pass: !!pass, detail: detail ?? null }; };
  const email = `cadence-qa-${Date.now()}@example.com`;
  const pass = 'QaPass-' + Math.random().toString(36).slice(2, 10) + '!9';
  try {
    page.on('pageerror', (e) => out.errors.push(e.message));
    await page.goto(URL);
    await expect(page.locator('#auth')).toBeVisible({ timeout: 20000 });
    await page.click('#btnToggleMode');
    await page.fill('#authEmail', email);
    await page.fill('#authPass', pass);
    await page.click('#btnEmail');
    await expect(page.locator('#onboarding:not(.hidden)')).toBeVisible({ timeout: 30000 });

    out.step = 'seed';
    await page.evaluate(async () => {
      const uid = auth.currentUser.uid; const wk = isoWeekId();
      const profile = { name: 'QA', age: 30, sex: 'Male', heightCm: 175, weightKg: 70, sports: ['Running'], level: 'beginner', goals: ['general'], goal: 'general',
        days: [0, 1, 2, 3, 4, 5, 6], sessionMin: 60, sessionTime: '18:00', doubles: 'no', equipment: ['Full gym'], injuries: '', deadline: null, nutrition: null,
        timezone: 'Europe/Brussels', lang: 'en', equipmentConfirmed: true, noDeadline: true, nutritionDeclined: true, updatedAt: new Date().toISOString() };
      await db.doc('users/' + uid).set({ profile, email: auth.currentUser.email });
      const ex = (name) => ({ name, sets: 3, reps: '5', load: '', restSec: 60, cues: 'Keep it tight' });
      const base = { slot: 0, timeOfDay: 'morning', fixed: false, durationMin: 45, intent: 'seeded', warmup: [], cooldown: [] };
      const sessions = [
        { ...base, day: 0, title: 'QA lift', type: 'strength', exercises: [ex('Back squat'), ex('Push jerk'), ex('Zottman curl')] },
        { ...base, day: 1, title: 'QA speed', type: 'speed', exercises: [ex('Sprint 20 m'), ex('A-skip')] },
      ];
      for (let d = 2; d < 7; d++) sessions.push({ ...base, day: d, title: 'QA rest', type: 'rest', exercises: [] });
      await db.doc('users/' + uid + '/plans/' + wk).set({ weekId: wk, phase: 'base', focus: 'QA', sessions, rationale: '', createdAt: new Date().toISOString() });
    });
    await page.reload();
    await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });
    await page.click('.tab[data-view="plan"]');

    const sheets = () => page.locator('.sheet');
    const openSession = async (title) => { await page.locator('button.slot', { hasText: title }).first().click(); await expect(sheets()).toHaveCount(1); };
    const closeSession = async () => { await sheets().first().locator('#btnCloseSheet').click(); await expect(sheets()).toHaveCount(0); };
    const openHow = async (i) => { await page.locator(`.sheet [data-how="${i}"]`).click(); await expect(page.locator('#howtoYT')).toBeVisible(); };
    const closeHow = async () => { await sheets().last().locator('#btnCloseSheet').click(); await page.waitForTimeout(400); };

    // ---- lift session ----
    out.step = 'lift';
    await openSession('QA lift');
    ok('every exercise has a How to button', (await page.locator('.sheet [data-how]').count()) === 3, await page.locator('.sheet [data-how]').count());

    await openHow(0);                                              // Back squat: photos + steps + muscles + exercise search
    const squat = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('.how-imgs img')];
      await Promise.all(imgs.map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))));
      return { photos: imgs.filter((i) => i.naturalWidth > 0).length, steps: document.querySelectorAll('.how-steps li').length, muscles: document.querySelectorAll('.sheet .badge').length, href: document.getElementById('howtoYT').href };
    });
    ok('back squat: 2 photos load', squat.photos === 2, squat);
    ok('back squat: steps and muscles shown', squat.steps > 0 && squat.muscles > 0, squat);
    ok('back squat: lift video search', /exercise%20proper%20form/.test(squat.href), squat.href);

    await expect(sheets()).toHaveCount(2);                           // Back closes only the how-to
    await page.goBack(); await page.waitForTimeout(500);
    ok('Back (phone back button) closes only the how-to sheet', (await sheets().count()) === 1, await sheets().count());

    await openHow(1);                                              // Push jerk: photos added in this release
    const jerk = await page.evaluate(async () => { const imgs = [...document.querySelectorAll('.how-imgs img')]; await Promise.all(imgs.map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; })))); return imgs.filter((i) => i.naturalWidth > 0).length; });
    ok('push jerk: 2 photos load', jerk === 2, jerk);
    await closeHow();

    await openHow(2);                                              // not in the library at all
    const zott = await page.evaluate(() => ({ video: document.getElementById('howtoYT').href, note: [...document.querySelectorAll('.sheet')].pop().querySelector('.intent')?.textContent || '' }));
    ok('unknown exercise: still gets a video link and the no-photo note', /youtube\.com\/results/.test(zott.video) && /No photos/.test(zott.note), zott);
    await closeHow();

    // ---- swap ----
    out.step = 'swap';
    await page.locator('.sheet [data-swap="2"]').click();
    await page.fill('#dlgIn', 'Goblet squat');
    await page.click('#dlgOk');
    await page.waitForTimeout(300);
    await openHow(2);
    const swapped = await page.evaluate(async () => { const imgs = [...document.querySelectorAll('.how-imgs img')]; await Promise.all(imgs.map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; })))); return { title: document.querySelector('.sheet:last-of-type h1')?.textContent, photos: imgs.filter((i) => i.naturalWidth > 0).length }; });
    ok('swap: How to follows the new exercise', swapped.title === 'Goblet squat' && swapped.photos === 2, swapped);
    await closeHow();
    await closeSession();

    // ---- speed session ----
    out.step = 'speed';
    await openSession('QA speed');
    await openHow(0);                                              // Sprint 20 m
    const sprint = await page.evaluate(() => ({ photos: document.querySelectorAll('.how-imgs img').length, note: [...document.querySelectorAll('.sheet')].pop().querySelector('.intent')?.textContent || '', href: document.getElementById('howtoYT').href }));
    ok('sprint: no photos, shows the note', sprint.photos === 0 && /No photos/.test(sprint.note), sprint);
    ok('sprint: video search asks for drill technique', /drill%20technique/.test(sprint.href), sprint.href);
    await closeHow();

    // ---- translated labels ----
    out.step = 'language';
    await closeSession();
    const tr = await page.evaluate(() => { setLang('tr'); return { how: T('How to'), yt: T('Watch on YouTube') }; });
    await openSession('QA speed');
    await page.locator('.sheet [data-how="0"]').first().click();
    await expect(page.locator('#howtoYT')).toBeVisible();
    const trText = await page.evaluate(() => ({ h2: document.querySelector('.sheet:last-of-type .sheet-top h2').textContent, yt: document.getElementById('howtoYT').textContent }));
    ok('Turkish: how-to labels are translated', tr.how !== 'How to' && trText.h2 === tr.how && trText.yt.includes(tr.yt), { tr, trText });
    await page.evaluate(() => setLang('fr'));
    const fr = await page.evaluate(() => T('How to'));
    ok('French: labels are translated', fr !== 'How to', fr);
    out.step = 'done';
    expect(out.errors, 'no page errors').toEqual([]);
    for (const [name, c] of Object.entries(out.checks)) expect.soft(c.pass, name + ' ' + JSON.stringify(c.detail)).toBe(true);
  } finally {
    try { await page.evaluate(() => (auth.currentUser ? api('/api/delete-account') : null)); } catch (_) { /* best effort */ }
    fs.writeFileSync('checklist-result.json', JSON.stringify(out, null, 2));
  }
});
