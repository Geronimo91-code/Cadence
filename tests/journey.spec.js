// Fresh-user journey on the live site: landing → sign-up → full onboarding → first plan (real AI) → session, how-to,
// logging, extra activity, rebuild with an injury note, nutrition, club, profile, feedback, theme/language, then cleanup.
// Runs with the checklist dispatch (title contains "phase 1 checklist"). Results go into checklist-result.json under "journey".
import { test, expect } from '@playwright/test';
import fs from 'fs';

const URL = process.env.CADENCE_URL;

test('phase 1 checklist: fresh user journey', async ({ page }) => {
  test.setTimeout(600000);
  const out = { started: new Date().toISOString(), checks: {}, timings: {}, errors: [], console: [], notes: [] };
  const ok = (name, pass, detail) => { out.checks[name] = { pass: !!pass, detail: detail ?? null }; };
  const time = async (name, fn) => { const t0 = Date.now(); try { return await fn(); } finally { out.timings[name] = Date.now() - t0; } };
  const step = async (name, fn) => { try { await fn(); } catch (e) { ok(name, false, String(e.message || e).slice(0, 300)); } };
  page.on('pageerror', (e) => out.errors.push(e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') out.console.push(m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept());
  const email = `cadence-journey-${Date.now()}@example.com`;
  const pass = 'QaPass-' + Math.random().toString(36).slice(2, 10) + '!9';

  try {
    // ---- landing ----
    await step('landing shows for a new visitor', async () => {
      await time('landing load', () => page.goto(URL));
      await expect(page.locator('#landing')).toBeVisible({ timeout: 20000 });
      ok('landing shows for a new visitor', true);
    });
    await step('landing language switch', async () => {
      await page.click('.ld-langs button[data-lang="fr"]');
      const fr = (await page.textContent('#btnLdStart')).trim();
      await page.click('.ld-langs button[data-lang="en"]');
      ok('landing language switch', fr === 'Commencer', fr);
    });
    await step('landing fits phone width', async () => {
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      ok('landing fits phone width', w <= 391, w + 'px');
    });

    // ---- sign-up ----
    await step('sign-up page', async () => {
      await page.click('#btnLdStart');
      await expect(page.locator('#auth')).toBeVisible();
      const title = (await page.textContent('#authTitle')).trim();
      ok('sign-up page', title === 'Create your account' && !(await page.isVisible('#btnForgot')), title);
    });
    await step('account created', async () => {
      await page.fill('#authEmail', email); await page.fill('#authPass', pass);
      await time('sign-up', async () => { await page.click('#btnEmail'); await expect(page.locator('#onboarding')).toBeVisible({ timeout: 30000 }); });
      ok('account created', true);
    });

    // ---- full onboarding through the real UI ----
    await step('onboarding completed', async () => {
      await page.click('#pathFull');
      const titles = [];
      for (let i = 0; i < 12; i++) {
        if (await page.isVisible('#app:not(.hidden)')) break;
        const title = (await page.textContent('#obStep h2').catch(() => '')).trim(); titles.push(title);
        if (await page.isVisible('#fName')) {
          await page.fill('#fName', 'Journey'); await page.fill('#fAge', '30'); await page.fill('#fHeight', '180'); await page.fill('#fWeight', '75');
          await page.click('#obStep .chip[data-val="Male"]');
        }
        if (await page.isVisible('#obStep .chip[data-val="Ultimate Frisbee"]')) {
          if ((await page.getAttribute('#obStep .chip[data-val="Ultimate Frisbee"]', 'aria-pressed')) !== 'true') await page.click('#obStep .chip[data-val="Ultimate Frisbee"]');
        }
        if (await page.isVisible('#obStep .week .bar')) {
          const bars = page.locator('#obStep .week .bar');
          for (const n of [0, 2, 4]) await bars.nth(n).click();
        }
        // any chip group / option group with nothing chosen: pick the first
        await page.evaluate(() => {
          document.querySelectorAll('#obStep .chips').forEach((g) => { if (!g.querySelector('[aria-pressed="true"]')) g.querySelector('.chip')?.click(); });
          document.querySelectorAll('#obStep .options').forEach((g) => { if (!g.querySelector('[aria-checked="true"]')) g.querySelector('.option')?.click(); });
        });
        const last = /Save and start/i.test(await page.textContent('#btnObNext'));
        await page.click('#btnObNext');
        if (last) { await time('save setup', () => expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 45000 })); break; }
        await page.waitForTimeout(700);
        const toastText = (await page.textContent('#toast').catch(() => '')) || '';
        if (titles.length > 1 && titles[titles.length - 1] === (await page.textContent('#obStep h2').catch(() => '')).trim() && toastText) out.notes.push(`onboarding blocked on "${title}": ${toastText}`);
      }
      await expect(page.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });
      out.onboardingSteps = titles;
      ok('onboarding completed', true, titles.length + ' screens');
    });

    // ---- first plan (real AI) ----
    await step('first plan generated', async () => {
      await page.click('.tab[data-view="today"]');
      if (await page.isVisible('#btnGen')) {
        await time('first plan', async () => { await page.click('#btnGen'); await expect(page.locator('.board')).toBeVisible({ timeout: 200000 }); });
      }
      const plan = await page.evaluate(() => ({ source: state.plan?.source, sessions: state.plan?.sessions?.length, real: state.plan?.sessions?.filter((s) => s.type !== 'rest').length, days: new Set(state.plan?.sessions?.map((s) => s.day)).size, rationale: (state.plan?.rationale || '').slice(0, 300), titles: state.plan?.sessions?.map((s) => `${s.day}:${s.type}:${s.title}`) }));
      out.firstPlan = plan;
      ok('first plan generated', plan.sessions > 0, plan);
      ok('first plan is AI-made (not template)', plan.source !== 'template', plan.source);
      ok('plan covers 7 days', plan.days === 7, plan.days);
    });
    await step('today fits one screen', async () => {
      await page.click('.tab[data-view="today"]'); await page.waitForTimeout(1500);
      const m = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, v: innerHeight, cards: [...document.querySelectorAll('#view > *')].map((e) => e.className || e.tagName) }));
      ok('today fits one screen', m.h <= m.v + 40, m);
    });

    // ---- plan + session + how-to ----
    await step('session opens', async () => {
      await page.click('.tab[data-view="plan"]');
      const gym = page.locator('button.slot', { hasText: /strength|speed/i });
      await ((await gym.count()) ? gym.first() : page.locator('button.slot').first()).click();
      await expect(page.locator('.sheet #btnSaveLog')).toBeVisible({ timeout: 10000 });
      ok('session opens', true);
    });
    await step('how-to with photos and muscle map', async () => {
      const how = page.locator('.sheet [data-how]');
      const n = await how.count();
      let withPhotos = 0, withMap = 0;
      const missing = [];
      for (let i = 0; i < n; i++) {
        await how.nth(i).click(); await page.waitForTimeout(500);
        const top = page.locator('.sheet').last();
        const name = (await top.locator('h1').textContent()).trim();
        if (await top.locator('.how-imgs img').count()) withPhotos++; else missing.push(name);
        if (await top.locator('.bodymap').count()) withMap++;
        await page.goBack(); await page.waitForTimeout(300);
      }
      out.howto = { exercises: n, withPhotos, withMap, missing };
      ok('how-to with photos and muscle map', n > 0 && withPhotos > 0, out.howto);
      ok('session still open after Back', await page.isVisible('.sheet #btnSaveLog'));
    });
    await step('session logged', async () => {
      await page.evaluate(() => { [...document.querySelectorAll('.sheet .setgrid button.check')].slice(0, 6).forEach((x) => x.click()); try { stopRest(); } catch (_) { /* no timer */ } });
      await page.locator('.sheet #sessRpe button').nth(6).click().catch(() => {});
      await time('save session', async () => { await page.click('.sheet #btnSaveLog'); await expect(page.locator('.sheet #btnSaveLog')).toHaveCount(0, { timeout: 15000 }); });
      const logs = await page.evaluate(() => Object.keys(state.logs).length);
      ok('session logged', logs >= 1, logs + ' logs');
    });

    // ---- extra activity ----
    await step('extra activity logged', async () => {
      await page.click('.tab[data-view="plan"]');
      await page.click('#btnExtra');
      await page.fill('#exDur', '90'); await page.locator('#exRpe button').nth(7).click();
      await page.click('#exSave'); await page.waitForTimeout(1500);
      const rows = await page.locator('.extra-row').count();
      ok('extra activity logged', rows >= 1, rows);
    });
    await step('streak shows after two sessions', async () => {
      await page.click('.tab[data-view="today"]'); await page.waitForTimeout(1500);
      const txt = (await page.textContent('#streakPill').catch(() => '')).trim();
      ok('streak shows after two sessions', /streak/i.test(txt), txt);
    });

    // ---- rebuild with an injury note (real AI) ----
    await step('rebuild keeps the injury note', async () => {
      await page.click('.tab[data-view="plan"]');
      await page.click('#btnRebuild');
      await page.fill('#rbNote', 'Left ankle sprain, no jumping this week');
      await time('rebuild', async () => { await page.click('#rbGo'); await expect(page.locator('#rbGo')).toHaveCount(0, { timeout: 200000 }); });
      await page.waitForTimeout(1000);
      const card = await page.isVisible('text=Left ankle sprain');
      const plan = await page.evaluate(() => ({ source: state.plan?.source, note: state.plan?.weekNote, rationale: (state.plan?.rationale || '').slice(0, 400), titles: state.plan?.sessions?.map((s) => `${s.day}:${s.type}:${s.title}`), exercises: state.plan?.sessions?.flatMap((s) => (s.exercises || []).map((e) => e.name)) }));
      out.rebuiltPlan = plan;
      await page.click('#btnRebuild'); const pre = await page.inputValue('#rbNote'); await page.goBack();
      ok('rebuild keeps the injury note', card && plan.note && pre.includes('ankle'), { card, saved: plan.note, prefilled: pre });
      const jumpy = (plan.exercises || []).filter((n) => /jump|hop|bound|plyo|depth/i.test(n));
      ok('rebuilt plan avoids jumping', jumpy.length === 0, jumpy);
    });

    // ---- nutrition ----
    await step('nutrition meal added', async () => {
      await page.click('.tab[data-view="nutrition"]'); await page.waitForTimeout(1000);
      if (!(await page.isVisible('#mealName'))) { ok('nutrition meal added', true, 'nutrition off for this profile'); return; }
      await page.fill('#mealName', 'Chicken wrap'); await page.fill('#mealK', '520'); await page.fill('#mealP', '35');
      await page.click('#mealAdd'); await page.waitForTimeout(1500);
      ok('nutrition meal added', (await page.textContent('#mealList')).includes('Chicken wrap'));
    });

    // ---- club ----
    await step('club created', async () => {
      await page.click('.tab[data-view="club"]'); await page.waitForTimeout(800);
      await page.fill('#clubName', 'QA Journey Club'); await page.click('#btnCreate'); await page.waitForTimeout(2500);
      const txt = await page.textContent('#view');
      ok('club created', /QA Journey Club/.test(txt), txt.slice(0, 120));
    });
    await step('club privacy and join by code', async () => {
      const code = (await page.textContent('.code')).trim();
      const r = await page.evaluate(async (code) => ({
        codeDoc: await db.doc('clubCodes/' + code).get().then((d) => d.exists).catch((e) => e.code),
        listClubs: await db.collection('clubs').limit(1).get().then(() => 'allowed').catch((e) => e.code),
      }), code);
      // a second, unrelated person joins with the code
      const ctx2 = await page.context().browser().newContext();
      const p2 = await ctx2.newPage();
      const email2 = `cadence-joiner-${Date.now()}@example.com`;
      let joined = false;
      try {
        await p2.goto(URL + '?signin'); await expect(p2.locator('#auth')).toBeVisible({ timeout: 20000 });
        await p2.click('#btnToggleMode'); await p2.fill('#authEmail', email2); await p2.fill('#authPass', pass); await p2.click('#btnEmail');
        await expect(p2.locator('#onboarding:not(.hidden)')).toBeVisible({ timeout: 30000 });
        r.outsiderList = await p2.evaluate(() => db.collection('clubs').limit(1).get().then(() => 'allowed').catch((e) => e.code));
        await p2.evaluate(async () => { await db.doc('users/' + auth.currentUser.uid).set({ profile: { name: 'Joiner', age: 30, sex: 'Male', heightCm: 180, weightKg: 75, sports: ['Ultimate Frisbee'], level: 'intermediate', goals: ['speed'], goal: 'speed', days: [1, 3], sessionMin: 60, doubles: 'no', equipment: ['Full gym'], lang: 'en' } }, { merge: true }); });
        await p2.reload(); await expect(p2.locator('#app:not(.hidden)')).toBeVisible({ timeout: 30000 });
        await p2.click('.tab[data-view="club"]'); await p2.waitForTimeout(800);
        await p2.fill('#joinCode', code); await p2.click('#btnJoin'); await p2.waitForTimeout(3000);
        joined = /QA Journey Club/.test(await p2.textContent('#view'));
        r.wrongCode = await p2.evaluate(() => findClubByCode('ZZZZZZ'));
      } finally {
        await p2.evaluate(() => (auth.currentUser ? api('/api/delete-account') : null)).catch(() => {});
        await ctx2.close();
      }
      r.joined = joined;
      out.club = r;
      ok('invite code registered for joining', r.codeDoc === true, r.codeDoc);
      ok('second person joins with the code', joined, r);
      ok('wrong code finds no club', r.wrongCode === null, r.wrongCode);
      ok('outsiders cannot list clubs', r.outsiderList === 'permission-denied', r.outsiderList);
    });

    // ---- profile ----
    await step('profile groups render', async () => {
      await page.click('.tab[data-view="profile"]'); await page.waitForTimeout(800);
      const groups = await page.$$eval('.set-title', (e) => e.map((x) => x.textContent.trim()));
      ok('profile groups render', groups.length >= 4, groups);
    });
    await step('feedback sends', async () => {
      await page.click('#btnFeedback'); await page.fill('#fbText', 'Automated journey test — please ignore.'); await page.click('#fbSend');
      await expect(page.locator('#fbText')).toHaveCount(0, { timeout: 15000 });
      ok('feedback sends', true);
    });
    await step('dark theme and French', async () => {
      await page.selectOption('#selTheme', 'dark'); await page.waitForTimeout(300);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.selectOption('#selLang', 'fr'); await page.waitForTimeout(800);
      const tab = (await page.textContent('.tab[data-view="today"]')).trim();
      await page.selectOption('#selLang', 'en'); await page.waitForTimeout(500);
      await page.selectOption('#selTheme', 'system');
      ok('dark theme and French', bg !== 'rgb(246, 247, 244)' && tab === "Aujourd'hui", { bg, tab });
    });
    await step('every tab loads without errors', async () => {
      const bad = [];
      for (const v of ['today', 'plan', 'log', 'nutrition', 'club', 'profile']) {
        await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(800);
        const t = await page.textContent('#view'); if (/Something went wrong/i.test(t)) bad.push(v);
        const w = await page.evaluate(() => document.documentElement.scrollWidth); if (w > 391) bad.push(v + ' too wide ' + w);
      }
      ok('every tab loads without errors', !bad.length, bad);
    });
    ok('no uncaught page errors', out.errors.length === 0, out.errors);
  } finally {
    try { await page.evaluate(() => (auth.currentUser ? api('/api/delete-account') : null)); out.cleanup = 'deleted'; } catch (e) { out.cleanup = 'failed: ' + e.message; }
    out.finished = new Date().toISOString();
    let all = {};
    try { all = JSON.parse(fs.readFileSync('checklist-result.json', 'utf8')); } catch (_) {}
    all.journey = out;
    fs.writeFileSync('checklist-result.json', JSON.stringify(all, null, 2));
  }
  const failed = Object.entries(out.checks).filter(([, v]) => !v.pass).map(([k]) => k);
  expect(failed, 'failed checks: ' + failed.join(', ')).toEqual([]);
});
