// GET /api/cron-status — when the scheduled jobs last ran, plus this user's own last reminder. Counts only, no one else's data.
import { requireUser, db } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  const user = await requireUser(req, res);
  if (!user) return;
  const [notify, close, mine] = await Promise.all([
    db().doc('cron/daily-notify').get(),
    db().doc('cron/weekly-close').get(),
    db().doc(`users/${user.uid}/push/main`).get(),
  ]);
  res.status(200).json({
    dailyNotify: notify.exists ? notify.data() : null,
    weeklyClose: close.exists ? close.data() : null,
    myLastReminder: mine.exists ? (mine.data().lastReminder || null) : null,
    subscribed: mine.exists,
  });
}
