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
- Respect injuries and limits literally.
- The FIRST goal leads the week; other goals get one focused slot or are woven into sessions.
- If the athlete mentions an existing strength program (e.g. StrongLifts 5x5, a named routine), keep it as-is on its days and build the rest around it.
- Session length must match the athlete's typical session length (±10 min).
- Beginners: fewer exercises, simpler patterns, more cues. Competitive athletes: periodised, sport-specific.
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

export function athleteBlock(p, id, ref = new Date()) {
  const goals = (p.goals || [p.goal]).filter(Boolean);
  return `Athlete
- Name: ${p.name}, age ${p.age}, ${p.sex}, ${p.heightCm} cm, ${p.weightKg} kg
- Sports: ${p.sports.join(', ')} (main: ${p.sports[0]})
- Level: ${p.level}
- Goals in order: ${goals.join(' > ')}${p.goalNote ? `\n- Specific aim: ${p.goalNote}` : ''}
- Available days: ${p.days.map((d) => DAY_NAMES[d]).join(', ')}
- Typical session length: ${p.sessionMin} min
- Two sessions in one day: ${p.doubles === 'often' ? 'yes, happy to train twice on some days (e.g. gym in the morning, club practice in the evening)' : p.doubles === 'sometimes' ? 'occasionally, at most once or twice a week, only when the second one is easy or is club practice' : 'no, one session per day only'}
- Fixed commitments: ${p.fixed || 'none'}
- Equipment: ${p.equipment.join(', ')}
- Injuries / limits: ${p.injuries || 'none'}
- ${phaseFor(p, ref).text}
- Today: ${DAY_NAMES[(ref.getDay() + 6) % 7]} ${ref.toISOString().slice(0, 10)}; the plan is for ISO week ${id}, Monday to Sunday.
- Language: write EVERY athlete-facing string (titles, intent, warm-up, cues, cool-down, rationale, review text) in ${LANG_NAMES[p.lang] || 'English'}. Keep JSON keys and the "type" values in English.`;
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
      name: String(x.name || ''), sets: Number(x.sets) || 0, reps: String(x.reps ?? ''), load: String(x.load ?? ''),
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
    const order = { morning: 0, afternoon: 1, evening: 2 };
    ofDay.sort((a, b) => (a.slot - b.slot) || ((order[a.timeOfDay] ?? 1) - (order[b.timeOfDay] ?? 1)));
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
