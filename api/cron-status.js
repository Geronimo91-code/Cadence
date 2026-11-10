// GET /api/cron-status — when the scheduled jobs last ran, plus this user's own last reminder. Counts only, no one else's data.
import { requireUser, requireCron, db } from './_lib.js';
import { runCompare, readCompare, okToken } from './_compare.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  // one-off free-model comparison: started by the cron, read back with a private token (fake athlete, no real data)
  if (req.query?.compare === 'run') { if (!requireCron(req, res)) return; return res.status(200).json(await runCompare()); }
  if (req.query?.compare === 'read') {
    if (!okToken(req.query.t)) return res.status(404).json({ error: 'Not found' });
    // all=1: everything in one file, as a download that can be attached to a chat
    if (req.query.all) {
      const d = await readCompare('all');
      res.setHeader('Content-Disposition', 'attachment; filename="ai-model-test.json"');
      return res.status(200).json(d);
    }
    return res.status(200).json(await readCompare(req.query.m));
  }
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
