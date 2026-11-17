// GET /api/weekly-close — Vercel cron, Monday to Wednesday 04:00 UTC. Closes last week for everyone who logged something and has no plan for this week yet.
// The cron call only finds who needs closing and starts one separate call per athlete (?uid=…), each with its own time budget,
// so a slow AI review for one athlete can no longer stop everyone after them. Tuesday and Wednesday pick up anyone still open.
import { waitUntil } from '@vercel/functions';
import { requireCron, db, weekId, weekIdOffset } from './_lib.js';
import { reviewWeek } from './weekly-review.js';

const PARALLEL = 3; // the free AI allows only a few requests at once; more would push people onto the backup template

export default async function handler(req, res) {
  if (!requireCron(req, res)) return;
  if (req.query?.uid) return closeOne(req, res, String(req.query.uid));
  const thisWeek = weekId(), lastWeek = weekIdOffset(thisWeek, -1);
  const users = await db().collection('users').get();
  const results = { week: lastWeek, eligible: 0, alreadyDone: 0, nothingLogged: 0, noPlan: 0 };
  const due = [];
  for (let i = 0; i < users.docs.length; i += 10) {
    await Promise.all(users.docs.slice(i, i + 10).map(async (u) => {
      const data = u.data(); if (!data.profile) return;
      const s = await status(u.id, thisWeek, lastWeek);
      if (s === 'due') due.push({ uid: u.id, test: /@example\.com$/i.test(data.email || '') });
      else results[s]++;
      if (s === 'nothingLogged') await note(u.id, lastWeek, 'skipped', 'Nothing was logged last week, so it closes when you next open the app.');
    }));
  }
  due.sort((a, b) => a.test - b.test); // real athletes before leftover test accounts
  results.eligible = due.length;
  const origin = `https://${req.headers.host}`;
  const queue = due.map((d) => d.uid);
  const worker = async () => {
    for (let uid; (uid = queue.shift());) {
      await fetch(`${origin}/api/weekly-close?uid=${encodeURIComponent(uid)}`, { headers: { authorization: req.headers.authorization } })
        .catch((e) => console.error('weekly-close dispatch failed', uid, e.message));
    }
  };
  await db().doc('cron/weekly-close').set({ at: new Date().toISOString(), ...results }).catch(() => {});
  // keep this call alive while the per-athlete calls run; anyone it cannot reach in time is closed by tomorrow's run or by the app
  waitUntil(Promise.all(Array.from({ length: PARALLEL }, worker)));
  res.status(200).json(results);
}

async function status(uid, thisWeek, lastWeek) {
  const [cur, prev, rev] = await Promise.all([
    db().doc(`users/${uid}/plans/${thisWeek}`).get(),
    db().doc(`users/${uid}/plans/${lastWeek}`).get(),
    db().doc(`users/${uid}/reviews/${lastWeek}`).get(),
  ]);
  if (cur.exists || rev.exists) return 'alreadyDone';
  if (!prev.exists) return 'noPlan';
  const logs = await db().collection(`users/${uid}/logs`).where('weekId', '==', lastWeek).limit(1).get();
  return logs.empty ? 'nothingLogged' : 'due';
}

// One athlete, in its own function call with the full time budget
async function closeOne(req, res, uid) {
  const thisWeek = weekId(), lastWeek = weekIdOffset(thisWeek, -1);
  const snap = await db().doc(`users/${uid}`).get();
  const profile = snap.data()?.profile;
  if (!profile) return res.status(404).json({ error: 'No such athlete' });
  if ((await status(uid, thisWeek, lastWeek)) !== 'due') return res.status(200).json({ uid, outcome: 'not due' }); // closed meanwhile (app or another run)
  try {
    const out = await reviewWeek(uid, profile, lastWeek);
    if (out.error) throw new Error(out.error);
    await note(uid, lastWeek, out.fallback ? 'closed-backup' : 'closed', out.fallback ? 'Closed automatically; the AI was busy, so next week is the backup template.' : 'Closed automatically and next week was built.');
    res.status(200).json({ uid, outcome: out.fallback ? 'closed-backup' : 'closed' });
  } catch (e) {
    console.error('auto review failed', uid, e.message);
    await note(uid, lastWeek, 'failed', 'Automatic close failed; it will be tried again tomorrow, or close it in the app.');
    res.status(500).json({ uid, outcome: 'failed' });
  }
}

// What happened to this athlete's week, shown on their Profile screen
function note(uid, week, outcome, text) {
  return db().doc(`users/${uid}`).set({ autoClose: { at: new Date().toISOString(), week, outcome, text } }, { merge: true }).catch(() => {});
}
