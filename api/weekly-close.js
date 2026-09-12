// GET /api/weekly-close — Vercel cron, Monday 04:00 UTC. Reviews last week for users who logged something and have no plan for this week yet.
import { requireCron, db, weekId, weekIdOffset } from './_lib.js';
import { reviewWeek } from './weekly-review.js';

export default async function handler(req, res) {
  if (!requireCron(req, res)) return;
  const thisWeek = weekId(), lastWeek = weekIdOffset(thisWeek, -1);
  const users = await db().collection('users').limit(200).get();
  const results = { reviewed: 0, skipped: 0, failed: 0 };
  const started = Date.now();
  for (const u of users.docs) {
    if (Date.now() - started > 40000) break; // functions stop at 60s; whoever is left closes next run or manually
    const profile = u.data().profile; if (!profile) continue;
    const [cur, prev, rev] = await Promise.all([
      db().doc(`users/${u.id}/plans/${thisWeek}`).get(),
      db().doc(`users/${u.id}/plans/${lastWeek}`).get(),
      db().doc(`users/${u.id}/reviews/${lastWeek}`).get(),
    ]);
    if (cur.exists || !prev.exists || rev.exists) { results.skipped++; continue; }
    const logs = await db().collection(`users/${u.id}/logs`).where('weekId', '==', lastWeek).limit(1).get();
    if (logs.empty) { results.skipped++; continue; } // nothing logged → leave it to the user
    try { await reviewWeek(u.id, profile, lastWeek); results.reviewed++; }
    catch (e) { console.error('auto review failed', u.id, e.message); results.failed++; }
  }
  res.status(200).json(results);
}
