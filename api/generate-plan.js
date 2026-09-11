// POST /api/generate-plan  — builds the first (or a fresh) weekly plan from the user's profile
// Step 2 fills in the prompt design; the request/response contract is fixed here.
import { requireUser, db, callModel, weekId } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;

  const snap = await db().doc(`users/${user.uid}`).get();
  const profile = snap.data()?.profile;
  if (!profile) return res.status(400).json({ error: 'Complete your profile first' });

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'Plan generation is not configured yet' });
  }

  const id = weekId();
  const system = `You are a strength & conditioning coach. Return ONLY JSON matching this shape:
{"weekId":"${id}","phase":"base|build|peak|taper|maintain","focus":"one sentence",
 "sessions":[{"day":0-6 (0=Mon),"title":"","type":"strength|speed|conditioning|skills|mobility|rest",
   "durationMin":0,"exercises":[{"name":"","sets":0,"reps":"","load":"","rpe":0,"notes":""}]}],
 "rationale":"2-3 sentences for the athlete"}`;
  const userMsg = `Athlete profile:\n${JSON.stringify(profile, null, 2)}\nToday: ${new Date().toISOString().slice(0, 10)}`;

  try {
    const plan = await callModel({ system, user: userMsg });
    plan.weekId = id;
    plan.createdAt = new Date().toISOString();
    await db().doc(`users/${user.uid}/plans/${id}`).set(plan);
    return res.status(200).json(plan);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not generate a plan right now' });
  }
}
