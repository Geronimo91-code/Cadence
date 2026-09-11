// POST /api/generate-plan  — builds a weekly plan from the user's profile (and, later, from the review)
import { requireUser, db, callModel, weekId } from './_lib.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;

  const snap = await db().doc(`users/${user.uid}`).get();
  const profile = snap.data()?.profile;
  if (!profile) return res.status(400).json({ error: 'Complete your profile first' });
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'Plan generation is not configured yet' });

  const id = weekId();
  const { system, userMsg } = buildPrompt(profile, id);

  try {
    const plan = await callModel({ system, user: userMsg, maxTokens: 6000 });
    validate(plan);
    plan.weekId = id;
    plan.createdAt = new Date().toISOString();
    plan.profileSnapshot = { goals: profile.goals || [profile.goal], deadline: profile.deadline || null, days: profile.days };
    await db().doc(`users/${user.uid}/plans/${id}`).set(plan);
    return res.status(200).json(plan);
  } catch (e) {
    console.error(e);
    const busy = /429|rate|no free|unavailable|did not return JSON|missing sessions/i.test(e.message);
    return res.status(busy ? 503 : 500).json({ error: busy ? 'The free model is busy right now. Try again in a minute.' : 'Could not generate a plan right now' });
  }
}

function buildPrompt(p, id) {
  const today = new Date();
  const goals = (p.goals || [p.goal]).filter(Boolean);
  let deadlineText = 'No competition date. Use rolling 4-week blocks: three progressive weeks then a lighter week.';
  let phase = 'base';
  if (p.deadline?.date) {
    const weeks = Math.round((new Date(p.deadline.date) - today) / (7 * 864e5));
    phase = weeks <= 1 ? 'taper' : weeks <= 3 ? 'peak' : weeks <= 8 ? 'build' : 'base';
    deadlineText = `Target event: "${p.deadline.name}" on ${p.deadline.date} — ${weeks} weeks away. Current phase: ${phase}. base = capacity & technique, build = intensity & sport-specific power, peak = sharpness at low volume, taper = freshness, no new stimulus.`;
  }

  const system = `You are an experienced strength & conditioning coach writing a one-week training plan for an athlete. Be specific and practical: real exercise names, sets, reps, loads as a percentage of effort or bodyweight/RPE (never guess kilograms unless the athlete gave a number), rest times, and short coaching cues an athlete can read on a phone at the gym or field.

Rules:
- Only schedule sessions on the athlete's available days. Every other day is a "rest" session with a one-line recovery suggestion.
- Fixed commitments (club practice, matches) are sacred: put them on their day as a session of type "skills" or "match" with fixed=true, keep exercises to a short pre-practice activation, and do not stack a hard session on the same day.
- Respect injuries and limits literally.
- The FIRST goal leads the week; other goals get one focused slot or are woven into sessions.
- If the athlete mentions an existing strength program (e.g. StrongLifts 5x5, a named routine), keep it as-is on its days and build the rest around it.
- Session length must match the athlete's typical session length (±10 min).
- Beginners: fewer exercises, simpler patterns, more cues. Competitive athletes: periodised, sport-specific.
- Warm-up 5–10 min and cool-down 3–5 min in every non-rest session.

Return ONLY a JSON object with exactly this shape:
{
 "weekId": "${id}",
 "phase": "base|build|peak|taper|maintain",
 "focus": "one sentence on what this week is for",
 "sessions": [
   {
     "day": 0,                       // 0=Monday … 6=Sunday, one entry per day, 7 entries total
     "title": "short name",
     "type": "strength|speed|conditioning|skills|match|mobility|rest",
     "fixed": false,
     "durationMin": 45,
     "intent": "one sentence: what this session does for the athlete",
     "warmup": ["item", "item"],
     "exercises": [
       {"name": "", "sets": 3, "reps": "8", "load": "RPE 7 / 70% / bodyweight", "restSec": 90, "cues": "one or two short cues"}
     ],
     "cooldown": ["item"]
   }
 ],
 "rationale": "2–3 sentences to the athlete explaining the week's logic",
 "nextWeekHint": "one sentence on how next week should progress if this week goes well"
}
Rest days: type "rest", durationMin 0, empty warmup/exercises/cooldown arrays, intent = the recovery suggestion.`;

  const userMsg = `Athlete
- Name: ${p.name}, age ${p.age}, ${p.sex}, ${p.heightCm} cm, ${p.weightKg} kg
- Sports: ${p.sports.join(', ')} (main: ${p.sports[0]})
- Level: ${p.level}
- Goals in order: ${goals.join(' > ')}${p.goalNote ? `\n- Specific aim: ${p.goalNote}` : ''}
- Available days: ${p.days.map((d) => DAYS[d]).join(', ')}
- Typical session length: ${p.sessionMin} min
- Fixed commitments: ${p.fixed || 'none'}
- Equipment: ${p.equipment.join(', ')}
- Injuries / limits: ${p.injuries || 'none'}
- ${deadlineText}
- Today: ${DAYS[(today.getDay() + 6) % 7]} ${today.toISOString().slice(0, 10)}; the plan covers this ISO week (${id}), Monday to Sunday. Days already passed this week should still be filled in for reference.`;

  return { system, userMsg };
}

function validate(plan) {
  if (!Array.isArray(plan.sessions) || plan.sessions.length === 0) throw new Error('missing sessions');
  // Ensure all 7 days exist and fields have sane defaults
  const byDay = new Map(plan.sessions.map((s) => [Number(s.day), s]));
  plan.sessions = DAYS.map((_, i) => {
    const s = byDay.get(i) || { day: i, type: 'rest', title: 'Rest', intent: 'Recovery day.' };
    return {
      day: i,
      title: String(s.title || (s.type === 'rest' ? 'Rest' : 'Session')),
      type: ['strength', 'speed', 'conditioning', 'skills', 'match', 'mobility', 'rest'].includes(s.type) ? s.type : 'conditioning',
      fixed: !!s.fixed,
      durationMin: Number(s.durationMin) || 0,
      intent: String(s.intent || ''),
      warmup: Array.isArray(s.warmup) ? s.warmup.map(String) : [],
      exercises: Array.isArray(s.exercises) ? s.exercises.map((x) => ({
        name: String(x.name || ''), sets: Number(x.sets) || 0, reps: String(x.reps ?? ''), load: String(x.load ?? ''),
        restSec: Number(x.restSec) || 0, cues: String(x.cues || ''),
      })).filter((x) => x.name) : [],
      cooldown: Array.isArray(s.cooldown) ? s.cooldown.map(String) : [],
    };
  });
  plan.phase = plan.phase || 'base';
  plan.focus = plan.focus || '';
  plan.rationale = plan.rationale || '';
  plan.nextWeekHint = plan.nextWeekHint || '';
}
