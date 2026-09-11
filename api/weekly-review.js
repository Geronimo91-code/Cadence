// POST /api/weekly-review — closes the given week: feedback on what was logged + the plan for the following week
import { requireUser, db, callModel, weekId, weekIdOffset, mondayOf, DAY_NAMES, PLAN_RULES, planShape, athleteBlock, validatePlan } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'Plan generation is not configured yet' });

  const uid = user.uid;
  const userDoc = await db().doc(`users/${uid}`).get();
  const profile = userDoc.data()?.profile;
  if (!profile) return res.status(400).json({ error: 'Complete your profile first' });

  const reviewWeek = (req.body && req.body.weekId) || weekId();
  const planDoc = await db().doc(`users/${uid}/plans/${reviewWeek}`).get();
  if (!planDoc.exists) return res.status(400).json({ error: 'No plan found for that week' });
  const plan = planDoc.data();
  const nextId = weekIdOffset(reviewWeek, 1);

  const logsSnap = await db().collection(`users/${uid}/logs`).where('weekId', '==', reviewWeek).get();
  const logs = new Map(logsSnap.docs.map((d) => [d.data().day, d.data()]));
  const weightsSnap = await db().collection(`users/${uid}/weights`).orderBy('at', 'desc').limit(6).get();
  const weights = weightsSnap.docs.map((d) => d.data()).reverse();
  const prevReview = await db().doc(`users/${uid}/reviews/${weekIdOffset(reviewWeek, -1)}`).get();

  // ---- adherence, computed here so the numbers are exact ----
  const planned = plan.sessions.filter((s) => s.type !== 'rest');
  const stats = { planned: planned.length, done: 0, partial: 0, skipped: 0, missed: 0, avgRpe: null, setsDone: 0, setsTotal: 0 };
  const rpes = [];
  const sessionLines = planned.map((s) => {
    const l = logs.get(s.day);
    if (!l) { stats.missed++; return `- ${DAY_NAMES[s.day]} · ${s.title} (${s.type}, ${s.durationMin} min): NOT LOGGED (treat as missed)`; }
    stats[l.status === 'done' ? 'done' : l.status === 'partial' ? 'partial' : 'skipped']++;
    if (l.sessionRpe) rpes.push(l.sessionRpe);
    stats.setsDone += l.setsDone || 0; stats.setsTotal += l.setsTotal || 0;
    let line = `- ${DAY_NAMES[s.day]} · ${s.title} (${s.type}): ${l.status.toUpperCase()}${l.durationMin ? `, ${l.durationMin} min` : ''}${l.sessionRpe ? `, session RPE ${l.sessionRpe}` : ''}${l.note ? `, note: "${l.note}"` : ''}`;
    if (Array.isArray(l.exercises)) {
      for (const ex of l.exercises) {
        const doneSets = ex.sets.filter((st) => st.done);
        if (!doneSets.length) { line += `\n    · ${ex.name}: not done`; continue; }
        const desc = doneSets.map((st) => `${st.reps ?? '?'}${st.load ? '×' + st.load + 'kg' : ''}`).join(', ');
        line += `\n    · ${ex.name} (planned ${ex.prescribed}): did ${desc}${ex.rpe ? `, RPE ${ex.rpe}` : ''}${doneSets.length < ex.sets.length ? `, ${ex.sets.length - doneSets.length} set(s) dropped` : ''}`;
      }
    }
    return line;
  });
  stats.avgRpe = rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10 : null;
  stats.adherence = stats.planned ? Math.round(((stats.done + stats.partial * 0.5) / stats.planned) * 100) : 0;

  const weightLine = weights.length > 1 ? `Weight trend: ${weights.map((w) => `${w.kg} kg (${w.at.slice(5, 10)})`).join(' → ')}` : `Weight: ${profile.weightKg} kg (no trend yet)`;
  const nextMonday = mondayOf(nextId);

  const system = `You are the athlete's strength & conditioning coach. You are closing out a training week and writing (1) a short honest review and (2) the plan for next week.

Review principles:
- Base everything on what was actually logged. Praise what was done, name what was missed without moralising, and interpret notes (pain, fatigue, schedule) literally.
- Progression: if a session was DONE and session RPE ≤ 8, progress it next week (small load or volume increase, or harder variation). RPE 9–10: hold. Adherence below 50% or repeated fatigue/soreness notes: make next week lighter (deload) and say so. Skip reasons that point to schedule problems: move sessions, don't add more.
- When the athlete logged real loads (kg), use those numbers to prescribe next week's loads explicitly.
- Injury or pain mentioned in a note overrides progression for that movement.
- Stay in the periodisation phase given for next week.

${PLAN_RULES}

Return ONLY a JSON object with this shape:
{
 "summary": "3–4 sentences, written to the athlete, plain and specific",
 "wins": ["1–3 short bullets"],
 "watchouts": ["0–3 short bullets: fatigue, pain, missed patterns"],
 "adjustments": ["2–4 short bullets: exactly what changes next week and why"],
 "nextWeek": ${planShape(nextId)}
}`;

  const userMsg = `${athleteBlock(profile, nextId, nextMonday)}

Week under review: ${reviewWeek} (phase: ${plan.phase}; focus: ${plan.focus})
Adherence: ${stats.adherence}% — ${stats.done} done, ${stats.partial} partial, ${stats.skipped} skipped, ${stats.missed} not logged, of ${stats.planned} planned. ${stats.setsTotal ? `Sets: ${stats.setsDone}/${stats.setsTotal}.` : ''} ${stats.avgRpe ? `Average session RPE: ${stats.avgRpe}.` : 'No RPE logged.'}
${weightLine}
${prevReview.exists ? `Previous week's adjustments were: ${(prevReview.data().adjustments || []).join('; ')}` : 'This is the first review.'}
Plan's own hint for next week: ${plan.nextWeekHint || 'none'}

Session log:
${sessionLines.join('\n')}

Next week is ${nextId}, starting ${DAY_NAMES[0]} ${nextMonday.toISOString().slice(0, 10)}.`;

  try {
    const out = await callModel({ system, user: userMsg, maxTokens: 8000 });
    const next = validatePlan(out.nextWeek);
    next.weekId = nextId; next.createdAt = new Date().toISOString(); next.source = 'review'; next.reviewOf = reviewWeek;
    const review = {
      weekId: reviewWeek, nextWeekId: nextId, createdAt: next.createdAt, stats,
      summary: String(out.summary || ''), wins: arr(out.wins), watchouts: arr(out.watchouts), adjustments: arr(out.adjustments),
    };
    const batch = db().batch();
    batch.set(db().doc(`users/${uid}/reviews/${reviewWeek}`), review);
    batch.set(db().doc(`users/${uid}/plans/${nextId}`), next);
    await batch.commit();
    return res.status(200).json({ review, plan: next });
  } catch (e) {
    console.error(e);
    const busy = /429|rate|no free|unavailable|did not return JSON|missing sessions/i.test(e.message);
    return res.status(busy ? 503 : 500).json({ error: busy ? 'The free model is busy right now. Try again in a minute.' : 'Could not build the review right now' });
  }
}
function arr(v) { return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 5) : []; }
