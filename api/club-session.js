// POST /api/club-session — a coach pushes a fixed team session into every member's current (or next) week
import { requireUser, db, weekId, weekIdOffset, checkLimit } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await checkLimit(user.uid, 'clubSession', 20))) return res.status(429).json({ error: 'Too many team sessions today. Try again tomorrow.' });

  const { clubId, day, timeOfDay = 'evening', title, durationMin = 90, type = 'skills', intent = '', weeks = 'this' } = req.body || {};
  if (!clubId || typeof day !== 'number' || day < 0 || day > 6 || !title) return res.status(400).json({ error: 'Missing club, day or title' });

  const me = await db().doc(`clubs/${clubId}/members/${user.uid}`).get();
  if (!me.exists || me.data().role !== 'coach') return res.status(403).json({ error: 'Only a coach can add team sessions' });

  const ids = weeks === 'next' ? [weekIdOffset(weekId(), 1)] : weeks === 'both' ? [weekId(), weekIdOffset(weekId(), 1)] : [weekId()];
  const members = await db().collection(`clubs/${clubId}/members`).get();
  const session = {
    day, slot: 0, timeOfDay, title: String(title).slice(0, 60), type, fixed: true, teamSession: true,
    durationMin: Number(durationMin) || 90, intent: String(intent).slice(0, 200) || 'Club session set by your coach.',
    warmup: [], exercises: [], cooldown: [],
  };

  let updated = 0;
  for (const m of members.docs) {
    const uid = m.id;
    for (const id of ids) {
      const ref = db().doc(`users/${uid}/plans/${id}`);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const plan = snap.data();
      const others = (plan.sessions || []).filter((s) => !(s.day === day && (s.teamSession || s.type === 'rest')));
      const sameDay = others.filter((s) => s.day === day);
      if (sameDay.length >= 2) { sameDay.sort((a, b) => (b.fixed ? 0 : 1) - (a.fixed ? 0 : 1)); others.splice(others.indexOf(sameDay[sameDay.length - 1]), 1); }
      const mine = { ...session, slot: others.filter((s) => s.day === day).length ? 1 : 0 };
      const next = [...others, mine].sort((a, b) => a.day - b.day || (a.slot || 0) - (b.slot || 0));
      for (let d = 0; d < 7; d++) next.filter((s) => s.day === d).forEach((s, i) => { s.slot = i; });
      await ref.set({ sessions: next, updatedAt: new Date().toISOString() }, { merge: true });
      updated++;
    }
  }
  await db().doc(`clubs/${clubId}/teamSessions/${day}-${Date.now()}`).set({ ...session, by: user.uid, at: new Date().toISOString(), weeks });
  return res.status(200).json({ ok: true, plansUpdated: updated, members: members.size });
}
