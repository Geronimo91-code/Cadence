// GET /api/daily-notify — Vercel cron, once per day. Sends each opted-in user today's session.
import webpush from 'web-push';
import { requireCron, db, weekId } from './_lib.js';

export default async function handler(req, res) {
  if (!requireCron(req, res)) return;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    console.error('daily-notify: VAPID keys missing');
    return res.status(503).json({ error: 'VAPID keys missing', sent: 0 });
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const users = await db().collectionGroup('push').get();
  const run = { at: new Date().toISOString(), subscribers: users.size, sent: 0, nudged: 0, rest: 0, skipped: 0, removed: 0, failed: 0 };

  for (const subDoc of users.docs) {
    const uid = subDoc.ref.parent.parent.id;
    const sub = subDoc.data();
    const today = todayInZone(sub.timezone || 'Europe/Brussels');
    let outcome;
    try {
      const plan = await planForWeek(uid, today.weekId);
      let payload = null;
      if (!plan) {
        // no plan this week: say so once a week instead of going quiet
        if (sub.lastNudgeWeek !== today.weekId) {
          payload = { title: 'No plan for this week yet', body: 'Open Cadence to close last week and get your new plan.', url: '/?view=plan' };
          outcome = 'nudged: no plan this week';
        } else outcome = 'skipped: no plan this week (already nudged)';
      } else {
        const todays = (plan.sessions || []).filter((x) => x.day === today.weekday);
        const real = todays.filter((x) => x.type !== 'rest');
        if (!real.length) {
          if (sub.skipRestDays) outcome = 'skipped: rest day';
          else { payload = { title: 'Rest day', body: 'Recover well. Tomorrow is coming.', url: '/' }; outcome = 'sent: rest day'; }
        } else if (real.length === 1) {
          payload = { title: `Today: ${real[0].title}`, body: `${real[0].durationMin} min · ${(real[0].exercises || []).length} exercises`, url: `/?session=${plan.weekId}-${real[0].day}-${real[0].slot || 0}` };
          outcome = 'sent: ' + real[0].title;
        } else {
          payload = { title: `Today: ${real.length} sessions`, body: real.map((x) => `${x.timeOfDay || ''} ${x.title}`.trim()).join(' · '), url: '/' };
          outcome = `sent: ${real.length} sessions`;
        }
      }
      if (payload) {
        await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
        if (outcome.startsWith('nudged')) run.nudged++; else if (outcome.includes('rest')) run.rest++; else run.sent++;
      } else run.skipped++;
      await subDoc.ref.set({ lastReminder: { at: run.at, outcome }, ...(outcome.startsWith('nudged') ? { lastNudgeWeek: today.weekId } : {}) }, { merge: true });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await subDoc.ref.delete(); run.removed++; continue; }
      run.failed++;
      console.error(uid, e.message);
      await subDoc.ref.set({ lastReminder: { at: run.at, outcome: 'failed: ' + String(e.message || e).slice(0, 120) } }, { merge: true }).catch(() => {});
    }
  }
  // a small server-only record of each run, so we can tell "never ran" from "ran and skipped you"
  await db().doc('cron/daily-notify').set(run).catch(() => {});
  res.status(200).json(run);
}

async function planForWeek(uid, id) {
  const d = await db().doc(`users/${uid}/plans/${id}`).get();
  return d.exists ? d.data() : null;
}

function todayInZone(tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const local = new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return { weekday: map[parts.weekday], weekId: weekId(local) };
}
