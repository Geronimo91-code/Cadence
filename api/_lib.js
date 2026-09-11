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

export function db() { return getAdmin().firestore(); }

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

export async function callModel({ system, user, maxTokens = 4000, retries = 1 }) {
  const model = process.env.OPENROUTER_MODEL || 'openrouter/free';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://cadence.app',
          'X-Title': 'Cadence',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system + '\n\nRespond with a single JSON object and nothing else. No markdown, no commentary.' },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!r.ok) throw new Error(`Model error ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json();
      const text = data.choices?.[0]?.message?.content || '';
      return extractJson(text);
    } catch (e) {
      lastErr = e;
      console.warn(`callModel attempt ${attempt + 1} failed:`, e.message);
      if (attempt < retries) await new Promise((res) => setTimeout(res, 1500));
    }
  }
  throw lastErr;
}

// Free/open models often wrap JSON in prose or code fences; pull out the first balanced object.
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
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
- Fixed commitments (club practice, matches) are sacred: put them on their day as a session of type "skills" or "match" with fixed=true, keep exercises to a short pre-practice activation, and do not stack a hard session on the same day.
- Respect injuries and limits literally.
- The FIRST goal leads the week; other goals get one focused slot or are woven into sessions.
- If the athlete mentions an existing strength program (e.g. StrongLifts 5x5, a named routine), keep it as-is on its days and build the rest around it.
- Session length must match the athlete's typical session length (±10 min).
- Beginners: fewer exercises, simpler patterns, more cues. Competitive athletes: periodised, sport-specific.
- Warm-up 5–10 min and cool-down 3–5 min in every non-rest session.`;

export function planShape(id) {
  return `{
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
       {"name": "", "sets": 3, "reps": "8", "load": "RPE 7 / 70% / bodyweight / 60 kg if the athlete logged loads", "restSec": 90, "cues": "one or two short cues"}
     ],
     "cooldown": ["item"]
   }
 ],
 "rationale": "2–3 sentences to the athlete explaining the week's logic",
 "nextWeekHint": "one sentence on how the following week should progress if this one goes well"
}
Rest days: type "rest", durationMin 0, empty warmup/exercises/cooldown arrays, intent = the recovery suggestion.`;
}

export function athleteBlock(p, id, ref = new Date()) {
  const goals = (p.goals || [p.goal]).filter(Boolean);
  return `Athlete
- Name: ${p.name}, age ${p.age}, ${p.sex}, ${p.heightCm} cm, ${p.weightKg} kg
- Sports: ${p.sports.join(', ')} (main: ${p.sports[0]})
- Level: ${p.level}
- Goals in order: ${goals.join(' > ')}${p.goalNote ? `\n- Specific aim: ${p.goalNote}` : ''}
- Available days: ${p.days.map((d) => DAY_NAMES[d]).join(', ')}
- Typical session length: ${p.sessionMin} min
- Fixed commitments: ${p.fixed || 'none'}
- Equipment: ${p.equipment.join(', ')}
- Injuries / limits: ${p.injuries || 'none'}
- ${phaseFor(p, ref).text}
- Today: ${DAY_NAMES[(ref.getDay() + 6) % 7]} ${ref.toISOString().slice(0, 10)}; the plan is for ISO week ${id}, Monday to Sunday.`;
}

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.sessions) || plan.sessions.length === 0) throw new Error('missing sessions');
  const byDay = new Map(plan.sessions.map((s) => [Number(s.day), s]));
  plan.sessions = DAY_NAMES.map((_, i) => {
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
  return plan;
}

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
export async function checkLimit(uid, key, max) {
  const ref = db().doc(`usage/${uid}`);
  const day = new Date().toISOString().slice(0, 10);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const cur = d.day === day ? (d[key] || 0) : 0;
    if (cur >= max) return false;
    tx.set(ref, { day, ...(d.day === day ? d : {}), [key]: cur + 1 }, { merge: true });
    return true;
  });
}
