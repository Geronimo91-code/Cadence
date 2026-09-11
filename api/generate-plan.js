// POST /api/generate-plan — builds a weekly plan from the user's profile (first plan, or a rebuild)
import { requireUser, db, callModel, weekId, PLAN_RULES, planShape, athleteBlock, validatePlan, checkLimit } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;

  const snap = await db().doc(`users/${user.uid}`).get();
  const profile = snap.data()?.profile;
  if (!profile) return res.status(400).json({ error: 'Complete your profile first' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'Plan generation is not configured yet' });

  if (!(await checkLimit(user.uid, 'plan', 6))) return res.status(429).json({ error: 'You have rebuilt the plan a lot today. Try again tomorrow.' });
  const id = weekId();
  const system = `You are an experienced strength & conditioning coach writing a one-week training plan for an athlete. Be specific and practical: real exercise names, sets, reps, loads as a percentage of effort or bodyweight/RPE (never guess kilograms unless the athlete gave a number), rest times, and short coaching cues an athlete can read on a phone at the gym or field.

${PLAN_RULES}

Return ONLY a JSON object with exactly this shape:
${planShape(id)}`;
  const userMsg = athleteBlock(profile, id) + '\nDays already passed this week should still be filled in for reference.';

  try {
    const plan = validatePlan(await callModel({ system, user: userMsg, maxTokens: 6000 }));
    plan.weekId = id;
    plan.createdAt = new Date().toISOString();
    plan.source = 'profile';
    await db().doc(`users/${user.uid}/plans/${id}`).set(plan);
    return res.status(200).json(plan);
  } catch (e) {
    console.error(e);
    const busy = /429|rate|no free|unavailable|did not return JSON|missing sessions/i.test(e.message);
    return res.status(busy ? 503 : 500).json({ error: busy ? 'The free model is busy right now. Try again in a minute.' : 'Could not generate a plan right now' });
  }
}
