// GET /api/daily-notify — Vercel cron, once per day. Sends each opted-in user today's session.
import webpush from 'web-push';
import { requireCron, db } from './_lib.js';

export default async function handler(req, res) {
  if (!requireCron(req, res)) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const users = await db().collectionGroup('push').get();
  let sent = 0, removed = 0;

  for (const subDoc of users.docs) {
    const uid = subDoc.ref.parent.parent.id;
    const sub = subDoc.data();
    const today = todayInZone(sub.timezone || 'Europe/Brussels');
    const plan = await latestPlan(uid);
    const session = plan?.sessions?.find((s) => s.day === today.weekday);
    if (!session) continue;
    if (session.type === 'rest' && sub.skipRestDays) continue;

    const payload = {
      title: session.type === 'rest' ? 'Rest day' : `Today: ${session.title}`,
      body: session.type === 'rest' ? 'Recover well. Tomorrow is coming.' : `${session.durationMin} min · ${session.exercises.length} exercises`,
      url: `/?session=${plan.weekId}-${session.day}`,
    };
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

async function latestPlan(uid) {
  const q = await db().collection(`users/${uid}/plans`).orderBy('createdAt', 'desc').limit(1).get();
  return q.empty ? null : q.docs[0].data();
}

function todayInZone(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date());
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { weekday: map[parts] };
}
