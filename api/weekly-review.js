// POST /api/weekly-review — closes the given week: feedback on what was logged + the plan for the following week
import { requireUser, db, callModel, weekId, weekIdOffset, mondayOf, DAY_NAMES, PLAN_RULES, planShape, athleteBlock, validatePlan, checkLimit, nutritionTargets, sessionKey, trainingHistoryBlock, templatePlan } from './_lib.js';

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
  if (!(await checkLimit(uid, 'review', 4, 8))) return res.status(429).json({ error: 'Review limit reached for today.' });
  const wk = (req.body && req.body.weekId) || weekId();
  try {
    const out = await reviewWeek(uid, profile, wk, started);
    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    const busy = /429|rate|no free|unavailable|did not return JSON|missing sessions|timed out|Out of time/i.test(e.message);
    return res.status(busy ? 503 : 500).json({ error: busy ? 'The free model is busy or slow right now. Try again in a minute.' : 'Could not build the review right now', detail: String(e && e.message || e).slice(0, 300) });
  }
}

async function reviewWeek(uid, profile, reviewWeek, started = Date.now()) {
  const planDoc = await db().doc(`users/${uid}/plans/${reviewWeek}`).get();
  if (!planDoc.exists) return { error: 'No plan found for that week' };
  const plan = planDoc.data();
  const nextId = weekIdOffset(reviewWeek, 1);
  const priorPlans = await db().collection(`users/${uid}/plans`).get();
  profile.weekNumber = priorPlans.size + 1;

  const logsSnap = await db().collection(`users/${uid}/logs`).where('weekId', '==', reviewWeek).get();
  const logs = new Map(logsSnap.docs.map((d) => [d.id, d.data()]));
  const weightsSnap = await db().collection(`users/${uid}/weights`).orderBy('at', 'desc').limit(6).get();
  // Training load: session RPE × minutes, this week vs the previous four (acute:chronic)
  const loadWeeks = [reviewWeek, ...[1, 2, 3, 4].map((n) => weekIdOffset(reviewWeek, -n))];
  const loadSnaps = await Promise.all(loadWeeks.map((w) => db().collection(`users/${uid}/logs`).where('weekId', '==', w).get()));
  const weekLoads = loadSnaps.map((snap) => snap.docs.reduce((a, d) => { const l = d.data(); return a + ((l.sessionRpe || 0) * (l.durationMin || 0)); }, 0));
  const acute = weekLoads[0];
  const priors = weekLoads.slice(1).filter((v) => v > 0);
  const chronic = priors.length ? priors.reduce((a, b) => a + b, 0) / priors.length : 0;
  const acwr = chronic ? Math.round((acute / chronic) * 100) / 100 : null;
  const weights = weightsSnap.docs.map((d) => d.data()).reverse();
  const prevReview = await db().doc(`users/${uid}/reviews/${weekIdOffset(reviewWeek, -1)}`).get();
  let coachNote = '';
  try {
    const udata = (await db().doc(`users/${uid}`).get()).data() || {};
    const clubIds = Array.isArray(udata.clubIds) ? udata.clubIds : (udata.clubId ? [udata.clubId] : []);
    const notes = [];
    for (const clubId of clubIds) {
      const n = await db().doc(`clubs/${clubId}/notes/${uid}`).get();
      if (n.exists && n.data().text) {
        const club = await db().doc(`clubs/${clubId}`).get();
        notes.push(`"${n.data().text}" — ${n.data().byName || 'coach'}${club.exists ? ` (${club.data().name})` : ''}`);
      }
    }
    if (notes.length) coachNote = `Coach notes for next week: ${notes.join(' | ')}`;
  } catch (_) {}
  // ---- adherence, computed here so the numbers are exact ----
  const planned = (plan.sessions || []).filter((s) => s.type !== 'rest');
  const stats = { planned: planned.length, done: 0, partial: 0, skipped: 0, missed: 0, avgRpe: null, setsDone: 0, setsTotal: 0, adherence: 0 };
  const rpes = [];
  const sessionLines = planned.map((s) => {
    const l = logs.get(sessionKey(reviewWeek, s.day, s.slot || 0));
    const when = `${DAY_NAMES[s.day]}${s.timeOfDay ? ' ' + s.timeOfDay : ''}`;
    if (!l) { stats.missed++; return `- ${when} · ${s.title} (${s.type}, ${s.durationMin} min): NOT LOGGED (treat as missed)`; }
    stats[l.status === 'done' ? 'done' : l.status === 'partial' ? 'partial' : 'skipped']++;
    if (l.sessionRpe) rpes.push(l.sessionRpe);
    stats.setsDone += l.setsDone || 0; stats.setsTotal += l.setsTotal || 0;
    let line = `- ${when} · ${s.title} (${s.type}): ${String(l.status || 'logged').toUpperCase()}${l.durationMin ? `, ${l.durationMin} min` : ''}${l.sessionRpe ? `, session RPE ${l.sessionRpe}` : ''}${l.note ? `, note: "${l.note}"` : ''}`;
    if (l.readiness) line += `\n    · felt ${l.readiness} before starting`;
    if (l.replacedWith) line += `\n    · replaced the planned session with: "${l.replacedWith}"`;
    if (Array.isArray(l.exercises)) {
      for (const ex of l.exercises) {
        const doneSets = (ex.sets || []).filter((st) => st.done);
        if (!doneSets.length) { line += `\n    · ${ex.name}: not done`; continue; }
        const desc = doneSets.map((st) => `${st.reps ?? '?'}${st.load ? '×' + st.load + 'kg' : ''}`).join(', ');
        line += `\n    · ${ex.name}${ex.added ? ' (added by the athlete)' : ex.swapped ? ' (swapped in by the athlete)' : ` (planned ${ex.prescribed})`}: did ${desc}${ex.rpe ? `, RPE ${ex.rpe}` : ''}${doneSets.length < (ex.sets || []).length ? `, ${(ex.sets || []).length - doneSets.length} set(s) dropped` : ''}`;
      }
    }
    return line;
  });
  stats.avgRpe = rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10 : null;
  stats.adherence = stats.planned ? Math.round(((stats.done + stats.partial * 0.5) / stats.planned) * 100) : 0;

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
  const loadLine = acute
    ? `Training load (session RPE × minutes): this week ${acute}${chronic ? `, four-week average ${Math.round(chronic)}, acute:chronic ratio ${acwr}` : ' (no history yet)'}.`
    : 'Training load: nothing with both RPE and duration logged this week.';
  const weightLine = weights.length > 1 ? `Weight trend: ${weights.map((w) => `${w.kg} kg (${w.at.slice(5, 10)})`).join(' → ')}` : `Weight: ${profile.weightKg} kg (no trend yet)`;
  const nextMonday = mondayOf(nextId);

  const system = `You are the athlete's strength & conditioning coach. You are closing out a training week and writing (1) a short honest review and (2) the plan for next week.

Nutrition (only if the athlete has a nutrition goal): compare the weight trend with the goal — maintain (±0.3 kg), slow gain (+0.2–0.3 kg/week), slow loss (−0.3–0.5 kg/week). If it drifts, set nutritionKcalAdjust to +100 or −100 (never more); otherwise 0.

Review principles:
- Base everything on what was actually logged. Praise what was done, name what was missed without moralising, and interpret notes (pain, fatigue, schedule) literally.
- Progression: if a session was DONE and session RPE ≤ 8, progress it next week (small load or volume increase, or harder variation). RPE 9–10: hold. Adherence below 50% or repeated fatigue/soreness notes: make next week lighter (deload) and say so. Skip reasons that point to schedule problems: move sessions, don't add more.
- When the athlete logged real loads (kg), use those numbers to prescribe next week's loads explicitly.
- Injury or pain mentioned in a note overrides progression for that movement.
- Readiness: repeated "tired" or "sore" entries before sessions mean the athlete is under-recovered — reduce volume before adding intensity.
- Training load: an acute:chronic ratio above 1.3 means the jump in load was large — hold or reduce volume next week and say so plainly. Below 0.8 means detraining — it is safe to add. Between 0.8 and 1.3 is the comfortable zone. Ignore the ratio when there is no four-week history.
- When the athlete swapped, added or replaced exercises or whole sessions, take that as a signal about what actually fits their week and equipment: keep what they chose if it serves the goal, and say so in the adjustments.
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

  const history = await trainingHistoryBlock(uid);
  const userMsg = `${athleteBlock(profile, nextId, nextMonday)}
${history}

Week under review: ${reviewWeek} (phase: ${plan.phase}; focus: ${plan.focus})
Adherence: ${stats.adherence}% — ${stats.done} done, ${stats.partial} partial, ${stats.skipped} skipped, ${stats.missed} not logged, of ${stats.planned} planned. ${stats.setsTotal ? `Sets: ${stats.setsDone}/${stats.setsTotal}.` : ''} ${stats.avgRpe ? `Average session RPE: ${stats.avgRpe}.` : 'No RPE logged.'}
${weightLine}
${loadLine}
${nutritionLine}
${prevReview.exists ? `Previous week's adjustments were: ${(prevReview.data().adjustments || []).join('; ')}` : 'This is the first review.'}
Plan's own hint for next week: ${plan.nextWeekHint || 'none'}
${coachNote}

Session log:
${sessionLines.join('\n')}

Next week is ${nextId}, starting ${DAY_NAMES[0]} ${nextMonday.toISOString().slice(0, 10)}.`;

  {
    let out = null, next, modelFailed = null;
    try {
      out = await callModel({ system, user: userMsg, maxTokens: 9000, retries: 0, deadline: started + 50000 });
      next = validatePlan(out.nextWeek);
      next.source = 'review';
    } catch (e) {
      // The providers are down or slow: still close the week with the real numbers and a template next week
      modelFailed = String(e && e.message || e).slice(0, 200);
      console.warn('review model failed, using fallback:', modelFailed);
      next = templatePlan(profile, nextId);
      out = {};
    }
    next.weekId = nextId; next.createdAt = new Date().toISOString(); next.reviewOf = reviewWeek;
    const fallbackSummary = `You completed ${stats.done} of ${stats.planned} planned sessions${stats.partial ? ` and part of ${stats.partial} more` : ''} — ${stats.adherence}% adherence${stats.avgRpe ? `, average session RPE ${stats.avgRpe}` : ''}. The coaching service was unavailable, so next week follows a standard template built from your settings. Rebuild it later for a tailored plan.`;
    const review = {
      weekId: reviewWeek, nextWeekId: nextId, createdAt: next.createdAt, stats,
      load: { acute, chronic: Math.round(chronic), acwr },
      summary: String(out.summary || fallbackSummary),
      wins: arr(out.wins), watchouts: arr(out.watchouts), adjustments: arr(out.adjustments),
      nutritionNote: String(out.nutritionNote || ''),
      ...(modelFailed ? { fallback: true } : {}),
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
    return { review, plan: next, ...(modelFailed ? { fallback: true } : {}) };
  }
}
function arr(v) { return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 5) : []; }
