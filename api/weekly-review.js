// POST /api/weekly-review — closes the given week: feedback on what was logged + the plan for the following week
import { requireUser, db, callModel, weekId, weekIdOffset, mondayOf, DAY_NAMES, PLAN_RULES, planShape, athleteBlock, validatePlan, checkLimit, nutritionTargets } from './_lib.js';

export { reviewWeek };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Plan generation is not configured yet' });

  const started = Date.now();
  const uid = user.uid;
  const userDoc = await db().doc(`users/${uid}`).get();
  const profile = userDoc.data()?.profile;
  if (!profile) return res.status(400).json({ error: 'Complete your profile first' });
  if (!(await checkLimit(uid, 'review', 4))) return res.status(429).json({ error: 'Review limit reached for today.' });
  const wk = (req.body && req.body.weekId) || weekId();
  try {
    const out = await reviewWeek(uid, profile, wk);
    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    const busy = /429|rate|no free|unavailable|did not return JSON|missing sessions|timed out|Out of time/i.test(e.message);
    return res.status(busy ? 503 : 500).json({ error: busy ? 'The free model is busy or slow right now. Try again in a minute.' : 'Could not build the review right now' });
  }
}

async function reviewWeek(uid, profile, reviewWeek) {
  const planDoc = await db().doc(`users/${uid}/plans/${reviewWeek}`).get();
  if (!planDoc.exists) return { error: 'No plan found for that week' };
  const plan = planDoc.data();
  const nextId = weekIdOffset(reviewWeek, 1);

  const logsSnap = await db().collection(`users/${uid}/logs`).where('weekId', '==', reviewWeek).get();
  const logs = new Map(logsSnap.docs.map((d) => [d.data().day, d.data()]));
  const weightsSnap = await db().collection(`users/${uid}/weights`).orderBy('at', 'desc').limit(6).get();
  const weights = weightsSnap.docs.map((d) => d.data()).reverse();
  const prevReview = await db().doc(`users/${uid}/reviews/${weekIdOffset(reviewWeek, -1)}`).get();
  let coachNote = '';
  try {
    const clubId = (await db().doc(`users/${uid}`).get()).data()?.clubId;
    if (clubId) { const n = await db().doc(`clubs/${clubId}/notes/${uid}`).get(); if (n.exists && n.data().text) coachNote = `Coach's note for next week (from ${n.data().byName || 'coach'}): "${n.data().text}"`; }
  } catch (_) {}

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

  // nutrition adherence for the week (if enabled)
  let nutritionLine = 'Nutrition tracking: off.';
  if (profile.nutrition) {
    const mon = mondayOf(reviewWeek); const days = [];
    for (let i = 0; i < 7; i++) { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i); days.push(d.toISOString().slice(0, 10)); }
    const docs = await Promise.all(days.map((d) => db().doc(`users/${uid}/nutrition/${d}`).get()));
    const logged = docs.map((d, i) => d.exists ? { ...d.data(), day: i } : null).filter((x) => x && x.meals?.length);
    if (logged.length) {
      const tot = logged.reduce((a, d) => { const t = d.meals.reduce((m, x) => ({ kcal: m.kcal + (x.kcal || 0), protein: m.protein + (x.protein || 0) }), { kcal: 0, protein: 0 }); const tg = nutritionTargets(profile, plan.sessions[d.day]?.type !== 'rest'); return { kcal: a.kcal + t.kcal, protein: a.protein + t.protein, tk: a.tk + tg.kcal, tp: a.tp + tg.protein }; }, { kcal: 0, protein: 0, tk: 0, tp: 0 });
      const n = logged.length;
      nutritionLine = `Nutrition (${n} of 7 days logged, goal: ${profile.nutrition.goal}): avg ${Math.round(tot.kcal / n)} kcal vs target ${Math.round(tot.tk / n)}; avg protein ${Math.round(tot.protein / n)} g vs target ${Math.round(tot.tp / n)} g.`;
    } else nutritionLine = `Nutrition tracking on (goal: ${profile.nutrition.goal}) but no meals logged this week.`;
  }
  const weightLine = weights.length > 1 ? `Weight trend: ${weights.map((w) => `${w.kg} kg (${w.at.slice(5, 10)})`).join(' → ')}` : `Weight: ${profile.weightKg} kg (no trend yet)`;
  const nextMonday = mondayOf(nextId);

  const system = `You are the athlete's strength & conditioning coach. You are closing out a training week and writing (1) a short honest review and (2) the plan for next week.

Nutrition (only if the athlete has a nutrition goal): compare the weight trend with the goal — maintain (±0.3 kg), slow gain (+0.2–0.3 kg/week), slow loss (−0.3–0.5 kg/week). If it drifts, set nutritionKcalAdjust to +100 or −100 (never more); otherwise 0.

Review principles:
- Base everything on what was actually logged. Praise what was done, name what was missed without moralising, and interpret notes (pain, fatigue, schedule) literally.
- Progression: if a session was DONE and session RPE ≤ 8, progress it next week (small load or volume increase, or harder variation). RPE 9–10: hold. Adherence below 50% or repeated fatigue/soreness notes: make next week lighter (deload) and say so. Skip reasons that point to schedule problems: move sessions, don't add more.
- When the athlete logged real loads (kg), use those numbers to prescribe next week's loads explicitly.
- Injury or pain mentioned in a note overrides progression for that movement.
- If a coach's note is given, treat it as an instruction from the athlete's coach and follow it, mentioning it in the adjustments.
- Stay in the periodisation phase given for next week.

${PLAN_RULES}

Return ONLY a JSON object with this shape:
{
 "summary": "3–4 sentences, written to the athlete, plain and specific",
 "wins": ["1–3 short bullets"],
 "watchouts": ["0–3 short bullets: fatigue, pain, missed patterns"],
 "adjustments": ["2–4 short bullets: exactly what changes next week and why"],
 "nutritionNote": "one sentence on eating for next week, based on the nutrition line and weight trend; empty string if tracking is off",
 "nutritionKcalAdjust": 0,
 "nextWeek": ${planShape(nextId)}
}`;

  const userMsg = `${athleteBlock(profile, nextId, nextMonday)}

Week under review: ${reviewWeek} (phase: ${plan.phase}; focus: ${plan.focus})
Adherence: ${stats.adherence}% — ${stats.done} done, ${stats.partial} partial, ${stats.skipped} skipped, ${stats.missed} not logged, of ${stats.planned} planned. ${stats.setsTotal ? `Sets: ${stats.setsDone}/${stats.setsTotal}.` : ''} ${stats.avgRpe ? `Average session RPE: ${stats.avgRpe}.` : 'No RPE logged.'}
${weightLine}
${nutritionLine}
${prevReview.exists ? `Previous week's adjustments were: ${(prevReview.data().adjustments || []).join('; ')}` : 'This is the first review.'}
Plan's own hint for next week: ${plan.nextWeekHint || 'none'}
${coachNote}

Session log:
${sessionLines.join('\n')}

Next week is ${nextId}, starting ${DAY_NAMES[0]} ${nextMonday.toISOString().slice(0, 10)}.`;

  {
    const out = await callModel({ system, user: userMsg, maxTokens: 5000, retries: 0, deadline: started + 50000 });
    const next = validatePlan(out.nextWeek);
    next.weekId = nextId; next.createdAt = new Date().toISOString(); next.source = 'review'; next.reviewOf = reviewWeek;
    const review = {
      weekId: reviewWeek, nextWeekId: nextId, createdAt: next.createdAt, stats,
      summary: String(out.summary || ''), wins: arr(out.wins), watchouts: arr(out.watchouts), adjustments: arr(out.adjustments), nutritionNote: String(out.nutritionNote || ''),
    };
    const batch = db().batch();
    batch.set(db().doc(`users/${uid}/reviews/${reviewWeek}`), review);
    batch.set(db().doc(`users/${uid}/plans/${nextId}`), next);
    const adj = Number(out.nutritionKcalAdjust) || 0;
    if (profile.nutrition && (adj === 100 || adj === -100)) {
      const kcalAdjust = Math.max(-400, Math.min(400, (profile.nutrition.kcalAdjust || 0) + adj));
      review.kcalAdjust = kcalAdjust;
      batch.set(db().doc(`users/${uid}`), { profile: { nutrition: { kcalAdjust } } }, { merge: true });
    }
    await batch.commit();
    return { review, plan: next };
  }
}
function arr(v) { return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 5) : []; }
