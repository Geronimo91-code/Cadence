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
  let sent = 0, removed = 0;

  for (const subDoc of users.docs) {
    const uid = subDoc.ref.parent.parent.id;
    const sub = subDoc.data();
    const today = todayInZone(sub.timezone || 'Europe/Brussels');
    const plan = await planForWeek(uid, today.weekId);
    const todays = (plan?.sessions || []).filter((s) => s.day === today.weekday);
    if (!todays.length) continue;
    const real = todays.filter((s) => s.type !== 'rest');
    if (!real.length && sub.skipRestDays) continue;

    const payload = real.length === 0
      ? { title: 'Rest day', body: 'Recover well. Tomorrow is coming.', url: '/' }
      : real.length === 1
        ? { title: `Today: ${real[0].title}`, body: `${real[0].durationMin} min · ${real[0].exercises.length} exercises`, url: `/?session=${plan.weekId}-${real[0].day}-${real[0].slot || 0}` }
        : { title: `Today: ${real.length} sessions`, body: real.map((s) => `${s.timeOfDay || ''} ${s.title}`.trim()).join(' · '), url: '/' };
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await subDoc.ref.delete(); removed++; }
      else console.error(uid, e.message);
    }
  }
  res.status(200).json({ sent, removed });
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
