// Shared helpers for Cadence API routes (Vercel serverless, Node 18+)
import admin from 'firebase-admin';

let app;
export function getAdmin() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel'), { code: 'config' });
    let sa;
    try { sa = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + e.message), { code: 'config' }); }
    if (!sa.project_id || !sa.private_key || !sa.client_email) throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT is missing project_id, private_key or client_email'), { code: 'config' });
    // Restore newlines if the private key was flattened when pasting
    if (!sa.private_key.includes('\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  }
  return admin;
}

let firestoreReady = false;
export function db() {
  const fs = getAdmin().firestore();
  if (!firestoreReady) { try { fs.settings({ ignoreUndefinedProperties: true }); } catch (_) { /* already initialised */ } firestoreReady = true; }
  return fs;
}

// Verifies the Firebase ID token sent as "Authorization: Bearer <token>"
export async function requireUser(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Sign in required' }); return null; }
  try {
    return await getAdmin().auth().verifyIdToken(token);
  } catch (e) {
    console.error('requireUser failed:', e.code || '', e.message);
    if (e.code === 'config') { res.status(500).json({ error: 'Server setup problem: ' + e.message }); return null; }
    if (/audience|project|aud/i.test(e.message)) { res.status(401).json({ error: 'Server is using a service account from a different Firebase project' }); return null; }
    res.status(401).json({ error: 'Could not verify your session. Sign out and back in.' });
    return null;
  }
}

export function requireCron(req, res) {
  const ok = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!ok) res.status(401).json({ error: 'Unauthorized' });
  return ok;
}

// Providers in order: Gemini (free tier, OpenAI-compatible endpoint) if GEMINI_API_KEY is set, then OpenRouter.
function providers() {
  const list = [];
  if (process.env.GEMINI_API_KEY) list.push({ name: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', extra: { reasoning_effort: 'none' } });
  if (process.env.OPENROUTER_API_KEY) list.push({ name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || 'openrouter/free', headers: { 'HTTP-Referer': 'https://cadence.app', 'X-Title': 'Cadence' } });
  return list;
}

export async function callModel({ system, user, image, maxTokens = 4000, retries = 1, timeoutMs = 40000, deadline }) {
  const provs = providers();
  if (!provs.length) throw new Error('No model provider configured (set GEMINI_API_KEY or OPENROUTER_API_KEY)');
  const endBy = deadline || Date.now() + 50000; // stay inside the 60s function limit
  const failures = [];
  let lastErr;
  for (const prov of provs) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const left = endBy - Date.now();
      if (left < 6000) throw new Error(failures.concat('Out of time before the model answered').join(' | '));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, left - 1000));
      try {
        const r = await fetch(prov.url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}`, ...(prov.headers || {}) },
          body: JSON.stringify({
            model: prov.model,
            ...(prov.extra || {}),
            max_tokens: maxTokens,
            temperature: 0.4,
            messages: [
              { role: 'system', content: system + '\n\nRespond with a single JSON object and nothing else. No markdown, no commentary.' },
              { role: 'user', content: image ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image } }] : user },
            ],
          }),
        });
        if (!r.ok) {
          const body = await r.text();
          // Google retires models and names the replacement in the error; switch to it and retry once
          const suggested = r.status === 404 && body.match(/use\s+models\/([a-z0-9.\-]+)/i);
          if (suggested && !prov.switched) { prov.model = suggested[1]; prov.switched = true; console.warn(`${prov.name}: model retired, switching to ${prov.model}`); attempt--; continue; }
          // A model that rejects our optional parameters: drop them and try once more
          if (r.status === 400 && prov.extra && !prov.stripped) { prov.stripped = true; prov.extra = null; console.warn(`${prov.name}: retrying without optional parameters`); attempt--; continue; }
          throw new Error(`${prov.name} ${r.status}: ${body.slice(0, 200)}`);
        }
        const data = await r.json();
        const content = data.choices?.[0]?.message?.content || '';
        if (!content.trim()) throw new Error(`${prov.name} returned an empty answer (finish_reason: ${data.choices?.[0]?.finish_reason || 'unknown'})`);
        return extractJson(content);
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error(`${prov.name} timed out`) : e;
        failures.push(lastErr.message);
        console.warn(`callModel ${prov.name} attempt ${attempt + 1}:`, lastErr.message);
        // Only retry the same provider when there is real time left
        if (attempt >= retries || endBy - Date.now() < 15000) break;
      } finally { clearTimeout(timer); }
    }
  }
  throw new Error(failures.join(' | ') || (lastErr && lastErr.message) || 'model call failed');
}

// Free/open models wrap JSON in prose, and a truncated answer needs repairing before it parses.
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('Model did not return JSON');
  const body = cleaned.slice(start);
  const end = body.lastIndexOf('}');
  if (end !== -1) {
    try { return JSON.parse(body.slice(0, end + 1)); } catch (_) { /* fall through to repair */ }
  }
  return JSON.parse(repairJson(body));
}

// Close whatever the model left open, discarding the final incomplete element
export function repairJson(src) {
  let depth = 0, inStr = false, esc = false, lastSafe = -1;
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') { stack.push(ch); depth++; }
    else if (ch === '}' || ch === ']') { stack.pop(); depth--; if (depth >= 1) lastSafe = i; }
  }
  if (lastSafe === -1) throw new Error('Model did not return usable JSON');
  let out = src.slice(0, lastSafe + 1);
  // rebuild the closers for whatever is still open at that point
  const open = [];
  inStr = false; esc = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') open.push(ch);
    else if (ch === '}' || ch === ']') open.pop();
  }
  while (open.length) out += open.pop() === '{' ? '}' : ']';
  return out;
}

// ISO week id like 2026-W37, used as the plan document id
export function weekId(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------- Plan prompt & validation (shared by generate-plan and weekly-review) ----------------
export const LANG_NAMES = { en: 'English', fr: 'French', nl: 'Dutch', tr: 'Turkish', es: 'Spanish' };
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function phaseFor(profile, ref = new Date()) {
  if (!profile.deadline?.date) return { phase: 'base', text: 'No competition date. Use rolling 4-week blocks: three progressive weeks then a lighter week.' };
  const weeks = Math.round((new Date(profile.deadline.date) - ref) / (7 * 864e5));
  if (weeks < 0) return { phase: 'base', text: `The event "${profile.deadline.name}" is past. Treat this as a new base block.` };
  const phase = weeks <= 1 ? 'taper' : weeks <= 3 ? 'peak' : weeks <= 8 ? 'build' : 'base';
  return { phase, weeks, text: `Target event: "${profile.deadline.name}" on ${profile.deadline.date} — ${weeks} weeks away. Current phase: ${phase}. base = capacity & technique, build = intensity & sport-specific power, peak = sharpness at low volume, taper = freshness, no new stimulus.` };
}

export const PLAN_RULES = `Rules:
- Only schedule sessions on the athlete's available days. Every other day is a "rest" session with a one-line recovery suggestion.
- Each session has a "slot": 0 for the day's first session, 1 for a second one. Only give a day two sessions when the athlete allows doubles (see their profile) and it makes sense — typically a shorter gym or speed session in the morning and club practice or a longer session later. Never two hard high-intensity sessions on the same day, never doubles on consecutive days for a beginner, and keep at least one full rest day in the week.
- Set "timeOfDay" to morning, afternoon or evening on every non-rest session; with two sessions the earlier one must come first.
- Fixed commitments (club practice, matches) are sacred: put them on their day as a session of type "skills" or "match" with fixed=true, keep exercises to a short pre-practice activation, and do not stack a hard session on the same day.
- Exercise names: use the exact names from the provided vocabulary wherever the movement exists there. Only invent a name for a sport-specific drill that has no equivalent in the list.
- When the athlete's own history below shows a load for a movement, prescribe from that number (progress it, hold it, or back it off) instead of a generic percentage. When a movement has no logged load yet, give an RPE and a sensible kilogram range so they have somewhere to start.
- Loads must be liftable in a real gym. Use kilograms rounded to 2.5 kg for barbell lifts. For anything held as one implement (goblet squat, kettlebell, dumbbell work, split squats, lunges, curls, raises) give a kilogram range that exists as a dumbbell or kettlebell — never a percentage of bodyweight, and never above 40 kg. For bodyweight movements write "bodyweight" and an RPE. Percentages of bodyweight are only acceptable for barbell squat, deadlift, bench press and overhead press.
- Respect injuries and limits literally. If the athlete wrote a note about this week, it outranks every other rule: work around the pain, absence or constraint they describe, and mention in the rationale how you adapted.
- Where the athlete fixed a day's focus or time, that is not a suggestion: schedule exactly that type at that time. Build the rest of the week around those anchors.
- The FIRST goal leads the week; other goals get one focused slot or are woven into sessions.
- If the athlete mentions an existing strength program (e.g. StrongLifts 5x5, a named routine), keep it as-is on its days and build the rest around it.
- Session length must match the athlete's typical session length (±10 min).
- Beginners: fewer exercises, simpler patterns, more cues. Competitive athletes: periodised, sport-specific.
- Deload: every fourth week of a block is a step back — same movements, roughly 60% of the usual volume, nothing near failure. The athlete's week number is given below; if it is a deload week, say so plainly in the rationale.
- Warm-up 5–10 min and cool-down 3–5 min in every non-rest session (3–4 items each, a few words per item).
- Be brief: cues under 12 words, intent one short sentence, 4–6 exercises per session. Brevity matters more than completeness.`;

export function planShape(id) {
  return `{
 "weekId": "${id}",
 "phase": "base|build|peak|taper|maintain",
 "focus": "one sentence on what this week is for",
 "sessions": [
   {
     "day": 0,                       // 0=Monday … 6=Sunday; every day appears at least once
     "slot": 0,                      // 0 = only/first session that day, 1 = optional second session
     "timeOfDay": "morning|afternoon|evening",
     "title": "short name",
     "type": "strength|speed|conditioning|skills|match|mobility|rest",
     "fixed": false,
     "durationMin": 45,
     "intent": "one sentence: what this session does for the athlete",
     "warmup": ["item", "item"],
     "exercises": [
       {"name": "", "sets": 3, "reps": "8", "load": "RPE 7 / 70% / bodyweight / 60 kg if the athlete logged loads", "restSec": 90, "cues": "one or two short cues"}
     ],
     "cooldown": ["item"]
   }
 ],
 "rationale": "2–3 sentences to the athlete explaining the week's logic",
 "nextWeekHint": "one sentence on how the following week should progress if this one goes well"
}
Rest days: type "rest", slot 0, durationMin 0, empty warmup/exercises/cooldown arrays, intent = the recovery suggestion.`;
}

function dayPrefBlock(p) {
  const prefs = p.dayPrefs || {};
  const lines = [];
  for (const [day, slots] of Object.entries(prefs)) {
    const parts = (slots || []).filter((x) => x && (x.time || x.focus)).map((x, i) => {
      const bits = [];
      if (x.time) bits.push(`in the ${x.time}`);
      if (x.focus) bits.push(`focus: ${x.focus}`);
      return `${slots.length > 1 ? `session ${i + 1} ` : ''}${bits.join(', ')}`;
    });
    if (parts.length) lines.push(`  · ${DAY_NAMES[Number(day)]}: ${parts.join(' | ')}`);
  }
  if (!lines.length) return '- The athlete set no per-day preferences: choose the days\' focus and timing yourself.';
  return `- The athlete fixed these days themselves. Follow them exactly — the right session type at the right time of day. Days not listed are yours to decide:\n${lines.join('\n')}`;
}

export function athleteBlock(p, id, ref = new Date()) {
  const goals = (p.goals || [p.goal]).filter(Boolean);
  return `Athlete
- Name: ${p.name}, age ${p.age}, ${p.sex}, ${p.heightCm} cm, ${p.weightKg} kg
- Sports: ${p.sports.join(', ')} (main: ${p.sports[0]})
- Level: ${p.level}
- Goals in order: ${goals.join(' > ')}${p.goalNote ? `\n- Specific aim: ${p.goalNote}` : ''}
- Available days: ${p.days.map((d) => DAY_NAMES[d]).join(', ')}
${dayPrefBlock(p)}
- Typical session length: ${p.sessionMin} min
- Two sessions in one day: ${p.doubles === 'often' ? 'yes, happy to train twice on some days (e.g. gym in the morning, club practice in the evening)' : p.doubles === 'sometimes' ? 'occasionally, at most once or twice a week, only when the second one is easy or is club practice' : 'no, one session per day only'}
- Fixed commitments: ${p.fixed || 'none'}
- Equipment: ${p.equipment.join(', ')}
- Injuries / limits: ${p.injuries || 'none'}${p.weekNote ? `\n- WHAT THE ATHLETE SAID ABOUT THIS WEEK (highest priority, overrides everything else): "${p.weekNote}"` : ''}
- ${phaseFor(p, ref).text}
- Week ${p.weekNumber || 1} of the current block${((p.weekNumber || 1) % 4 === 0) ? ' — THIS IS A DELOAD WEEK' : ''}.
- Today: ${DAY_NAMES[(ref.getDay() + 6) % 7]} ${ref.toISOString().slice(0, 10)}; the plan is for ISO week ${id}, Monday to Sunday.

Exercise vocabulary (use these exact names where the movement fits):
${exerciseMenu()}
- Language: write EVERY athlete-facing string (titles, intent, warm-up, cues, cool-down, rationale, review text) in ${LANG_NAMES[p.lang] || 'English'}. Keep JSON keys and the "type" values in English.`;
}

// Snap any kilogram figure the model wrote onto something a gym actually has
const IMPLEMENT_RE = /goblet|kettlebell|dumbbell|split squat|step[- ]up|lunge|curl|raise|fly/i;
function tidyLoad(load, name) {
  return String(load ?? '').replace(/(\d+(?:\.\d+)?)\s*kg/gi, (m, n) => {
    const kg = Number(n);
    if (IMPLEMENT_RE.test(name || '')) {
      const steps = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40];
      const snapped = steps.reduce((best, v) => (Math.abs(v - kg) < Math.abs(best - kg) ? v : best), steps[0]);
      return `${snapped} kg`;
    }
    return `${Math.round(kg / 2.5) * 2.5} kg`;
  });
}

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.sessions) || plan.sessions.length === 0) throw new Error('missing sessions');
  const clean = plan.sessions.map((s) => ({
    day: Math.max(0, Math.min(6, Number(s.day) || 0)),
    slot: Number(s.slot) === 1 ? 1 : 0,
    timeOfDay: ['morning', 'afternoon', 'evening'].includes(s.timeOfDay) ? s.timeOfDay : null,
    title: String(s.title || (s.type === 'rest' ? 'Rest' : 'Session')),
    type: ['strength', 'speed', 'conditioning', 'skills', 'match', 'mobility', 'rest'].includes(s.type) ? s.type : 'conditioning',
    fixed: !!s.fixed,
    durationMin: Number(s.durationMin) || 0,
    intent: String(s.intent || ''),
    warmup: Array.isArray(s.warmup) ? s.warmup.map(String) : [],
    exercises: Array.isArray(s.exercises) ? s.exercises.map((x) => ({
      name: canonicalExercise(x.name), sets: Number(x.sets) || 0, reps: String(x.reps ?? ''), load: tidyLoad(x.load, x.name),
      restSec: Number(x.restSec) || 0, cues: String(x.cues || ''),
    })).filter((x) => x.name) : [],
    cooldown: Array.isArray(s.cooldown) ? s.cooldown.map(String) : [],
  }));
  const out = [];
  for (let d = 0; d < 7; d++) {
    let ofDay = clean.filter((s) => s.day === d);
    const real = ofDay.filter((s) => s.type !== 'rest');
    // A day is either rest, or up to two real sessions; a rest entry alongside real ones is dropped
    ofDay = real.length ? real.slice(0, 2) : [ofDay[0] || { day: d, slot: 0, timeOfDay: null, title: 'Rest', type: 'rest', fixed: false, durationMin: 0, intent: 'Recovery day.', warmup: [], exercises: [], cooldown: [] }];
    // Time of day wins over the model's slot numbering, which is often arbitrary
    const order = { morning: 0, afternoon: 1, evening: 2 };
    const rank = (x) => (x.timeOfDay ? order[x.timeOfDay] : (x.slot || 0) + 0.5);
    ofDay.sort((a, b) => rank(a) - rank(b) || (a.slot || 0) - (b.slot || 0));
    ofDay.forEach((s, i) => { s.slot = i; s.day = d; out.push(s); });
  }
  plan.sessions = out;
  plan.phase = plan.phase || 'base';
  plan.focus = plan.focus || '';
  plan.rationale = plan.rationale || '';
  plan.nextWeekHint = plan.nextWeekHint || '';
  return plan;
}

// Stable id for a session's log document; slot 0 keeps the original shape so older logs still match
export function sessionKey(weekId, day, slot) { return `${weekId}-${day}` + (slot ? `-${slot}` : ''); }

// Monday (UTC) of an ISO week id, and id arithmetic
export function mondayOf(id) {
  const [y, w] = id.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4); monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
  return monday;
}
export function weekIdOffset(id, n) { const d = mondayOf(id); d.setUTCDate(d.getUTCDate() + n * 7); return weekId(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

// ---------------- Nutrition targets (mirrored in index.html — keep in sync) ----------------
export function nutritionTargets(p, trainingDay) {
  const n = p.nutrition; if (!n) return null;
  const w = p.weightKg, h = p.heightCm, a = p.age;
  const base = 10 * w + 6.25 * h - 5 * a;
  const bmr = p.sex === 'Male' ? base + 5 : p.sex === 'Female' ? base - 161 : base - 78;
  const sessions = (p.days || []).length, hours = sessions * ((p.sessionMin || 60) / 60);
  const activity = Math.min(1.9, 1.4 + hours * 0.06);
  const goalDelta = n.goal === 'gain' ? 250 : n.goal === 'lose' ? -400 : 0;
  const tdee = bmr * activity + goalDelta + (n.kcalAdjust || 0);
  const kcal = Math.round(tdee * (trainingDay ? 1.08 : 0.92) / 10) * 10;
  const protein = Math.round(w * (n.goal === 'lose' ? 2.2 : n.goal === 'gain' ? 2.0 : 1.8));
  const fat = Math.round(w * 0.9);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein, carbs, fat, trainingDay };
}

// ---------------- Per-user daily rate limit (usage/{uid}, server-only collection) ----------------
export async function checkLimit(uid, key, max, weekMax) {
  const ref = db().doc(`usage/${uid}`);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const week = weekId(now);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const sameDay = d.day === day, sameWeek = d.week === week;
    const dayCount = sameDay ? (d[key] || 0) : 0;
    const weekCount = sameWeek ? (d[key + 'Week'] || 0) : 0;
    if (dayCount >= max) return false;
    if (weekMax && weekCount >= weekMax) return false;
    const base = sameDay ? { ...d } : {};
    if (!sameWeek) for (const k of Object.keys(base)) if (k.endsWith('Week')) delete base[k];
    tx.set(ref, { ...base, day, week, [key]: dayCount + 1, [key + 'Week']: weekCount + 1 }, { merge: true });
    return true;
  });
}

// ---------------- Exercise vocabulary ----------------
// A fixed list keeps names stable week to week, so history, progression and charts line up.
export const EXERCISE_LIBRARY = {
  'lower push': ['Back squat', 'Front squat', 'Goblet squat', 'Split squat', 'Bulgarian split squat', 'Step-up', 'Leg press', 'Walking lunge', 'Box jump', 'Broad jump', 'Depth jump', 'Pogo hop'],
  'lower pull': ['Deadlift', 'Romanian deadlift', 'Trap bar deadlift', 'Single-leg RDL', 'Hip thrust', 'Glute bridge', 'Nordic curl', 'Hamstring curl', 'Back extension', 'Calf raise'],
  'upper push': ['Bench press', 'Incline bench press', 'Overhead press', 'Push press', 'Dumbbell shoulder press', 'Push-up', 'Dip', 'Landmine press'],
  'upper pull': ['Pull-up', 'Chin-up', 'Lat pulldown', 'Barbell row', 'Dumbbell row', 'Seated cable row', 'Face pull', 'Band pull-apart'],
  core: ['Plank', 'Side plank', 'Dead bug', 'Pallof press', 'Hanging knee raise', 'Ab wheel rollout', 'Hollow hold', 'Copenhagen plank', 'Cable woodchop', 'Medicine ball slam', 'Medicine ball rotational throw'],
  olympic: ['Power clean', 'Hang clean', 'Push jerk', 'Clean pull', 'Kettlebell swing', 'Kettlebell snatch'],
  speed: ['Sprint 10 m', 'Sprint 20 m', 'Sprint 30 m', 'Sprint 40 m', 'Flying sprint', 'Acceleration wall drill', 'A-skip', 'B-skip', 'High knees', 'Bounding', 'Sled push', 'Sled sprint', 'Resisted sprint', 'Hill sprint'],
  agility: ['5-10-5 shuttle', 'T-drill', 'L-drill', 'Ladder quick feet', 'Cone cutting drill', 'Reactive cut drill', 'Lateral shuffle', 'Crossover run', 'Backpedal to sprint', 'Zig-zag run'],
  conditioning: ['Tempo run', 'Interval run 400 m', 'Interval run 800 m', 'Shuttle run repeats', 'Bike intervals', 'Rowing intervals', 'Assault bike sprints', 'Easy run', 'Fartlek run', 'Circuit conditioning'],
  mobility: ['Hip flexor stretch', 'Couch stretch', '90/90 hip switch', 'Thoracic rotation', 'Cat-cow', "World's greatest stretch", 'Ankle dorsiflexion drill', 'Shoulder dislocate', 'Foam roll quads', 'Foam roll glutes', 'Foam roll upper back', 'Hamstring stretch'],
  warmup: ['Leg swings', 'Hip circles', 'Walking knee hug', 'Walking quad pull', 'Inchworm', 'Glute bridge march', 'Banded lateral walk', 'Arm circles', 'Jumping jacks', 'Skip drills', 'Easy jog', 'Dynamic lunge with twist'],
};
export const EXERCISE_NAMES = Object.values(EXERCISE_LIBRARY).flat();

const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/(\d)\s*(m|km|s|min)\b/g, '$1 $2')          // "30m" → "30 m"
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(barbell|dumbbell|db|bb|kb|the|a|with)\b/g, ' ')
  .split(/\s+/).filter(Boolean)
  .map((w) => (w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))  // plurals
  .join(' ')
  .trim();

const LOOKUP = new Map(EXERCISE_NAMES.map((n) => [normalize(n), n]));

// Snap a model-written name onto the library when it clearly means the same movement.
// Scores candidates by how many of their words appear, preferring the one that starts where the athlete's name starts.
export function canonicalExercise(name) {
  const n = normalize(name);
  if (!n) return String(name || '').trim();
  if (LOOKUP.has(n)) return LOOKUP.get(n);
  const words = n.split(' ');
  let best = null, bestScore = 0;
  for (const [key, canonical] of LOOKUP) {
    const kw = key.split(' ');
    if (!kw.every((w) => words.includes(w))) continue;
    const leads = words[0] === kw[0] ? 1 : 0;
    const score = kw.length * 10 + leads * 5 + key.length / 100;
    if (score > bestScore) { bestScore = score; best = canonical; }
  }
  return best || String(name || '').trim();
}

export function exerciseMenu() {
  return Object.entries(EXERCISE_LIBRARY).map(([group, list]) => `${group}: ${list.join(', ')}`).join('\n');
}

// ---------------- Template week (used when no model is available) ----------------
const TEMPLATES = {
  strength: { title: 'Full-body strength', type: 'strength', pick: [['lower push', 1], ['lower pull', 1], ['upper push', 1], ['upper pull', 1], ['core', 1]], sets: 3, reps: '6-8', load: 'RPE 7' },
  speed: { title: 'Speed and acceleration', type: 'speed', pick: [['warmup', 2], ['speed', 3], ['core', 1]], sets: 4, reps: '20-30 m', load: 'full effort, full recovery' },
  conditioning: { title: 'Conditioning', type: 'conditioning', pick: [['warmup', 1], ['conditioning', 2], ['core', 1]], sets: 4, reps: '2-4 min', load: 'RPE 7-8' },
  skills: { title: 'Skills and agility', type: 'skills', pick: [['warmup', 2], ['agility', 3]], sets: 4, reps: '4-6 reps', load: 'sharp, not exhausting' },
  mobility: { title: 'Mobility and recovery', type: 'mobility', pick: [['mobility', 5]], sets: 2, reps: '45 s', load: 'easy' },
  match: { title: 'Match', type: 'match', pick: [['warmup', 3]], sets: 1, reps: '', load: '' },
};
const GOAL_TO_TYPE = { speed: 'speed', strength: 'strength', endurance: 'conditioning', lean: 'strength', fat: 'conditioning', general: 'conditioning' };

// A sensible week built from the athlete's own settings, so a model outage is not a dead end
export function templatePlan(profile, id) {
  const days = (profile.days && profile.days.length ? profile.days : [1, 3, 5]).slice(0, 7);
  const goals = (profile.goals || [profile.goal] || []).filter(Boolean);
  const rotation = [...new Set([GOAL_TO_TYPE[goals[0]] || 'strength', 'strength', GOAL_TO_TYPE[goals[1]] || 'speed', 'conditioning'])];
  const prefs = profile.dayPrefs || {};
  const sessions = [];
  let r = 0;
  for (let d = 0; d < 7; d++) {
    if (!days.includes(d)) {
      sessions.push({ day: d, slot: 0, timeOfDay: null, title: 'Rest', type: 'rest', fixed: false, durationMin: 0, intent: 'Recovery day — walk, stretch, sleep well.', warmup: [], exercises: [], cooldown: [] });
      continue;
    }
    const slots = (prefs[d] && prefs[d].length ? prefs[d] : [{ time: '', focus: '' }]).slice(0, 2);
    slots.forEach((slot, i) => {
      const key = slot.focus || rotation[r++ % rotation.length];
      const tpl = TEMPLATES[key] || TEMPLATES.strength;
      const exercises = tpl.pick.flatMap(([group, n]) => (EXERCISE_LIBRARY[group] || []).slice(0, n).map((name) => ({
        name, sets: tpl.sets, reps: tpl.reps, load: tpl.load, restSec: tpl.type === 'speed' ? 180 : 90, cues: '',
      })));
      sessions.push({
        day: d, slot: i, timeOfDay: slot.time || (i ? 'evening' : null),
        title: tpl.title, type: tpl.type, fixed: false,
        durationMin: profile.sessionMin || 60,
        intent: 'Template session — rebuild the week when the plan service is back for something tailored.',
        warmup: EXERCISE_LIBRARY.warmup.slice(0, 4).map((x) => `${x}, 30 s`),
        exercises, cooldown: EXERCISE_LIBRARY.mobility.slice(0, 3).map((x) => `${x}, 45 s`),
      });
    });
  }
  return {
    weekId: id, phase: 'base', focus: 'A solid default week built from your own settings.',
    sessions, rationale: 'The plan service was unavailable, so this week follows a standard template shaped by your training days, goals and session length. Rebuild it later for a tailored week.',
    nextWeekHint: '', source: 'template', createdAt: new Date().toISOString(),
  };
}

// ---------------- What the athlete has actually lifted ----------------
// Gives the model real numbers to progress from, instead of guessing loads every week.
export async function trainingHistoryBlock(uid, { weeks = 16, maxExercises = 40, maxChars = 4000 } = {}) {
  const since = new Date(Date.now() - weeks * 7 * 864e5).toISOString();
  let docs = [];
  try {
    const q = await db().collection(`users/${uid}/logs`).orderBy('loggedAt', 'desc').limit(260).get();
    docs = q.docs.map((d) => d.data()).filter((l) => (l.loggedAt || '') >= since);
  } catch (e) { console.warn('history block failed', e.message); return ''; }
  if (!docs.length) return '- Training history: nothing logged yet.';

  const byExercise = new Map();
  for (const log of docs) {
    for (const ex of log.exercises || []) {
      const done = (ex.sets || []).filter((st) => st.done);
      if (!done.length) continue;
      const key = (ex.name || '').trim();
      if (!key) continue;
      const cur = byExercise.get(key) || { name: key, sessions: 0, best: null, first: null, firstAt: null, last: null, lastAt: null, rpes: [] };
      cur.sessions++;
      const maxLoad = Math.max(0, ...done.map((st) => st.load || 0));
      if (maxLoad > 0) {
        if (cur.best == null || maxLoad > cur.best) cur.best = maxLoad;
        if (!cur.firstAt || (log.loggedAt || '') < cur.firstAt) { cur.firstAt = log.loggedAt; cur.first = maxLoad; }
      }
      if (!cur.lastAt || (log.loggedAt || '') > cur.lastAt) {
        cur.lastAt = log.loggedAt;
        cur.last = done.map((st) => `${st.reps ?? '?'}${st.load ? '×' + st.load : ''}`).join('/');
      }
      if (ex.rpe) cur.rpes.push(ex.rpe);
      byExercise.set(key, cur);
    }
  }
  if (!byExercise.size) return '- Training history: sessions logged, but no sets recorded.';

  // Rank by how much the exercise matters to this athlete, not just how recent it is:
  // frequency counts, heavy loaded lifts count, and recency breaks ties.
  const now = Date.now();
  const scored = [...byExercise.values()].map((e) => {
    const daysAgo = e.lastAt ? (now - new Date(e.lastAt)) / 864e5 : 999;
    const recency = Math.max(0, 1 - daysAgo / (weeks * 7));
    return { ...e, score: e.sessions * 2 + (e.best ? 3 : 0) + recency * 4 };
  }).sort((a, b) => b.score - a.score).slice(0, maxExercises);

  const line = (e) => {
    const trend = e.best && e.first && e.best > e.first ? ` (from ${e.first})` : '';
    const best = e.best ? `, best ${e.best}kg${trend}` : '';
    const rpe = e.rpes.length ? `, RPE~${Math.round((e.rpes.reduce((a, b) => a + b, 0) / e.rpes.length) * 10) / 10}` : '';
    return `  · ${e.name}: ${e.last} on ${String(e.lastAt).slice(5, 10)}${best}${rpe} ×${e.sessions}`;
  };
  const lines = [];
  let chars = 0;
  for (const e of scored) {
    const l = line(e);
    if (chars + l.length > maxChars) break;
    lines.push(l); chars += l.length;
  }
  const noLoad = scored.filter((e) => e.sessions >= 2 && !e.best).length;
  return `- What the athlete has actually done in the last ${weeks} weeks (reps×kg per set, most important movements first). Prescribe loads from these numbers — progress, hold or back off — rather than generic percentages:\n${lines.join('\n')}${noLoad ? `\n  (${noLoad} movement(s) logged without a load — give an RPE and a kilogram range for those)` : ''}${scored.length < byExercise.size ? `\n  (${byExercise.size - lines.length} rarer movements omitted)` : ''}`;
}
