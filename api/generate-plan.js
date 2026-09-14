// POST /api/generate-plan — builds a weekly plan from the user's profile (first plan, or a rebuild)
import { requireUser, db, callModel, weekId, PLAN_RULES, planShape, athleteBlock, validatePlan, checkLimit, templatePlan } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;

  const snap = await db().doc(`users/${user.uid}`).get();
  const profile = snap.data()?.profile;
  if (!profile) return res.status(400).json({ error: 'Complete your profile first' });
  if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Plan generation is not configured yet' });

  if (!(await checkLimit(user.uid, 'plan', 12, 30))) return res.status(429).json({ error: 'You have rebuilt the plan a lot today. Try again tomorrow.' });
  const started = Date.now();
  // one-off overrides for this rebuild; the stored profile is untouched unless the client saved it
  const body = req.body || {};
  if (Array.isArray(body.days) && body.days.length) {
    profile.days = [...new Set(body.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  }
  if (body.dayPrefs && typeof body.dayPrefs === 'object') {
    const clean = {};
    for (const [day, slots] of Object.entries(body.dayPrefs)) {
      const d = Number(day);
      if (!profile.days.includes(d) || !Array.isArray(slots)) continue;
      const ok = slots.slice(0, 2).map((x) => ({
        time: ['morning', 'afternoon', 'evening'].includes(x?.time) ? x.time : '',
        focus: ['strength', 'speed', 'conditioning', 'skills', 'mobility', 'match'].includes(x?.focus) ? x.focus : '',
      })).filter((x) => x.time || x.focus);
      if (ok.length) clean[d] = ok;
    }
    profile.dayPrefs = clean;
  }

  const priorPlans = await db().collection(`users/${user.uid}/plans`).get();
  profile.weekNumber = priorPlans.size + 1;

  const id = weekId();
  const system = `You are an experienced strength & conditioning coach writing a one-week training plan for an athlete. Be specific and practical: real exercise names, sets, reps, loads as a percentage of effort or bodyweight/RPE (never guess kilograms unless the athlete gave a number), rest times, and short coaching cues an athlete can read on a phone at the gym or field.

${PLAN_RULES}

Return ONLY a JSON object with exactly this shape:
${planShape(id)}`;
  const userMsg = athleteBlock(profile, id) + '\nDays already passed this week should still be filled in for reference.';

  try {
    const plan = validatePlan(await callModel({ system, user: userMsg, maxTokens: 9000, retries: 1, deadline: started + 50000 }));
    plan.weekId = id;
    plan.createdAt = new Date().toISOString();
    plan.source = 'profile';
    await db().doc(`users/${user.uid}/plans/${id}`).set(plan);
    return res.status(200).json(plan);
  } catch (e) {
    console.error(e);
    // Rather than leave the athlete with nothing, fall back to a template week built from their settings
    try {
      const plan = templatePlan(profile, id);
      await db().doc(`users/${user.uid}/plans/${id}`).set(plan);
      return res.status(200).json({ ...plan, fallback: true, detail: String(e && e.message || e).slice(0, 200) });
    } catch (inner) {
      console.error('template fallback failed', inner);
      const busy = /429|quota|rate|no free|unavailable|did not return JSON|missing sessions|timed out|Out of time/i.test(String(e && e.message || e));
      return res.status(busy ? 503 : 500).json({ error: busy ? 'The model is busy right now. Try again in a minute.' : 'Could not generate a plan right now', detail: String(e && e.message || e).slice(0, 300) });
    }
  }
}
