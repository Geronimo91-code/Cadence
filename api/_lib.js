// Shared helpers for Yosh API routes (Vercel serverless, Node 18+)
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

// Records a server-side failure (model errors, fallbacks) in problems/{id} so they show up in the tester inbox.
export async function logProblem(uid, route, err, extra = {}) {
  try {
    await db().collection('problems').add({ source: 'server', route, uid: uid || null, message: String((err && err.message) || err).slice(0, 500), ...extra, createdAt: new Date().toISOString() });
  } catch (_) { /* logging must never break the request */ }
}

export function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !!secret && req.headers.authorization === `Bearer ${secret}`;
  if (!ok) res.status(401).json({ error: 'Unauthorized' });
  return ok;
}

// Providers in order: Gemini (free tier, OpenAI-compatible endpoint) if GEMINI_API_KEY is set, then OpenRouter.
// Free Gemini keys have a daily quota per model, so several Google models are tried in turn: when one is used up
// (429 quota) the next one answers. Models known to be used up are skipped until the quota resets (midnight Pacific).
// tested 10 Nov 2026: 3.5 Flash-Lite wrote a valid week in 4 s; 2.5 Flash is retired for new keys; 3.8 Flash was busy
const GEMINI_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash-lite-latest'];
function providers() {
  const list = [];
  if (process.env.GEMINI_API_KEY) {
    const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.6-flash', ...GEMINI_FALLBACKS])];
    for (const model of models) list.push({ name: 'gemini', model, url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: process.env.GEMINI_API_KEY, extra: { reasoning_effort: 'none', response_format: { type: 'json_object' } } });
  }
  if (process.env.OPENROUTER_API_KEY) list.push({ name: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || 'openrouter/free', headers: { 'HTTP-Referer': 'https://cadence.app', 'X-Title': 'Yosh' } });
  return list;
}
const quotaRef = () => db().doc('system/aiQuota');
function nextQuotaReset() { const d = new Date(); d.setUTCHours(8, 10, 0, 0); if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString(); }
async function usedUp() { try { const snap = await quotaRef().get(); const now = new Date().toISOString(); return Object.fromEntries(Object.entries(snap.data() || {}).filter(([, until]) => until > now)); } catch (_) { return {}; } }
function markUsedUp(model) { try { quotaRef().set({ [model.replace(/[./]/g, '_')]: nextQuotaReset() }, { merge: true }).catch(() => {}); } catch (_) { /* best effort */ } }
const quotaKey = (m) => m.replace(/[./]/g, '_');

// think: let Gemini reason a little before answering (better plans, slower); the retry goes without it
// meta (optional object) is filled with which model answered, how long it took and the tokens used
export async function callModel({ system, user, image, maxTokens = 4000, retries = 1, timeoutMs = 40000, deadline, think = false, meta }) {
  const all = providers();
  if (!all.length) throw new Error('No model provider configured (set GEMINI_API_KEY or OPENROUTER_API_KEY)');
  const skip = await usedUp();
  const provs = all.filter((p) => !skip[quotaKey(p.model)]);
  if (!provs.length) provs.push(...all.slice(-1));
  const endBy = deadline || Date.now() + 50000; // callers that build plans pass a longer deadline (functions may run 300 s)
  const failures = [];
  let lastErr;
  for (const prov of provs) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const left = endBy - Date.now();
      if (left < 6000) throw new Error(failures.concat('Out of time before the model answered').join(' | '));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, left - 1000));
      const t0 = Date.now();
      try {
        const r = await fetch(prov.url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}`, ...(prov.headers || {}) },
          body: JSON.stringify({
            model: prov.model,
            ...(prov.extra || {}),
            ...(think && attempt === 0 && prov.name === 'gemini' && prov.extra ? { reasoning_effort: 'low' } : {}),
            max_tokens: think && attempt === 0 ? maxTokens + 6000 : maxTokens,
            temperature: 0.4,
            messages: [
              { role: 'system', content: system + '\n\nRespond with a single JSON object and nothing else. No markdown, no commentary. Write compact JSON on one line, with no indentation or line breaks.' },
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
          // A model that does not exist for this key: move on to the next one straight away
          if (r.status === 404 && prov.name === 'gemini') { failures.push(`${prov.model} not available`); break; }
          // Daily quota used up: remember it until the reset and move on, a retry would only fail again
          if (r.status === 429 && /quota|exhausted|limit/i.test(body)) { markUsedUp(prov.model); failures.push(`${prov.model} quota used up`); break; }
          throw new Error(`${prov.name} ${prov.model} ${r.status}: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        const data = await r.json();
        const content = data.choices?.[0]?.message?.content || '';
        if (!content.trim()) throw new Error(`${prov.name} returned an empty answer (finish_reason: ${data.choices?.[0]?.finish_reason || 'unknown'})`);
        const parsed = extractJson(content);
        if (meta) Object.assign(meta, { provider: prov.name, model: prov.model, ms: Date.now() - t0, tokensIn: data.usage?.prompt_tokens ?? null, tokensOut: data.usage?.completion_tokens ?? null, cachedIn: data.usage?.prompt_tokens_details?.cached_tokens ?? null, reasoning: !!(think && attempt === 0), failures: failures.slice() });
        return parsed;
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
export function extractJson(text) {
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
  if (!profile.deadline?.date) {
    // no competition date set, but a tournament on the calendar within 12 weeks: that is the target
    const ev = upcomingEvents(profile, ref, 84)[0];
    if (ev) profile = { ...profile, deadline: { name: ev.name, date: ev.start } };
  }
  if (!profile.deadline?.date) return { phase: 'base', text: 'No competition date. Use rolling 4-week blocks: three progressive weeks then a lighter week.' };
  const weeks = Math.round((new Date(profile.deadline.date) - ref) / (7 * 864e5));
  if (weeks < 0) return { phase: 'base', text: `The event "${profile.deadline.name}" is past. Treat this as a new base block.` };
  const phase = weeks <= 1 ? 'taper' : weeks <= 3 ? 'peak' : weeks <= 8 ? 'build' : 'base';
  return { phase, weeks, text: `Target event: "${profile.deadline.name}" on ${profile.deadline.date} — ${weeks} weeks away. Current phase: ${phase}. base = capacity & technique, build = intensity & sport-specific power, peak = sharpness at low volume, taper = freshness, no new stimulus.` };
}

export const PLAN_RULES = `Rules:
- Only schedule sessions on the athlete's available days. Every other day is a "rest" session with a one-line recovery suggestion.
- Set "timeOfDay" to morning, afternoon or evening on every non-rest session; with two sessions the earlier one must come first.
- Fixed commitments (club practice, matches) are sacred: put them on their day as a session of type "skills" or "match" with fixed=true, keep exercises to a short pre-practice activation, and do not stack a hard session on the same day.
- Exercise names: use the exact names from the provided vocabulary wherever the movement exists there. Only invent a name for a sport-specific drill that has no equivalent in the list.
- When the athlete's own history below shows a load for a movement, prescribe from that number (progress it, hold it, or back it off) instead of a generic percentage. When a movement has no logged load yet, give an RPE and a sensible kilogram range so they have somewhere to start.
- Loads must be liftable in a real gym. Use kilograms rounded to 2.5 kg for barbell lifts. For anything held as one implement (goblet squat, kettlebell, dumbbell work, split squats, lunges, curls, raises) give a kilogram range that exists as a dumbbell or kettlebell — never a percentage of bodyweight, and never above 40 kg. For bodyweight movements write "bodyweight" and an RPE. Percentages of bodyweight are only acceptable for barbell squat, deadlift, bench press and overhead press.
- Respect injuries and limits literally. If the athlete wrote a note about this week, it outranks every other rule: work around the pain, absence or constraint they describe, and mention in the rationale how you adapted.
- Where the athlete fixed a day's focus or time, that is not a suggestion: schedule exactly that type at that time. Build the rest of the week around those anchors.
- The FIRST goal leads the week; other goals get one focused slot or are woven into sessions.
- Session length must match the athlete's typical session length (±10 min).
- Beginners: fewer exercises, simpler patterns, more cues. Competitive athletes: periodised, sport-specific.
- Deload: every fourth week of a block is a step back — same movements, roughly 60% of the usual volume, nothing near failure. The athlete's week number is given below; if it is a deload week, say so plainly in the rationale.
- Warm-up 5–10 min and cool-down 3–5 min in every non-rest session (3–4 items each, a few words per item).
- Be brief: cues under 12 words, intent one short sentence, 4–6 exercises per session. Brevity matters more than completeness.
- Each session has a "slot": 0 for the day's first session, 1 for a second one. Only give a day two sessions when the athlete allows doubles (see their profile) and it makes sense — typically a shorter gym or speed session in the morning and club practice or a longer session later. Never two hard high-intensity sessions on the same day, never doubles on consecutive days for a beginner, and keep at least one full rest day in the week.
- If the athlete asks for a named program or a set/rep scheme (StrongLifts 5x5, "do 5x5", 3x10, a named routine), follow it exactly on its strength days and build the rest of the week around it. Write it as numbers: "5x5" means "sets": 5 and "reps": "5" on every main lift, never "reps": "5x5". StrongLifts 5x5 alternates workout A (Back squat 5x5, Bench press 5x5, Barbell row 5x5) and workout B (Back squat 5x5, Overhead press 5x5, Deadlift 1x5), 3 minutes rest; add at most one or two short accessories after the main lifts. A requested program overrides the exercise-count, session-length and deload rules below. Load: progress each lift 2.5 kg from the athlete's last logged load (deadlift 5 kg) when all sets were completed, otherwise repeat it.
- Tournaments listed above: each tournament day is a session of type "match", fixed=true, title "Tournament: <name>", with a short activation warm-up, no gym work, and an intent that covers between games: eat carbohydrates within 30 minutes after each game (banana, rice cakes, a sandwich), sip about 500 ml per hour with electrolytes, 5 minutes of easy mobility between games, stay warm. The two days before a tournament: nothing hard, only a short sharp activation or rest. The day after: easy mobility and recovery only. In the week leading in, cut volume by about 40% but keep some speed.
- If the athlete "Often skips" a weekday, put only a short or easy session there (or rest), never the week's key session.`;

export function planShape(id) {
  return `{
 "weekId": "the ISO week id given in the athlete block",
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
     "targetRpe": 7,                 // how hard the whole session should feel, 1–10 (rest days: 0)
     "intent": "one sentence: what this session does for the athlete",
     "why": "one short sentence to the athlete about why THIS session suits THEM: refer to their position, what they want to improve, a recent test or lift, their recovery, an injury, or their next game/tournament. Concrete, never generic.",
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

// Tournaments the athlete added (profile.events), within the next five weeks
export function upcomingEvents(p, ref = new Date(), days = 35) {
  const today = ref.toISOString().slice(0, 10);
  const until = new Date(ref.getTime() + days * 864e5).toISOString().slice(0, 10);
  return (Array.isArray(p.events) ? p.events : []).filter((e) => e && e.start && e.name).map((e) => {
    const n = Math.max(1, Math.min(5, Number(e.days) || 1));
    const end = new Date(Date.parse(e.start + 'T12:00:00Z') + (n - 1) * 864e5).toISOString().slice(0, 10);
    return { name: String(e.name).slice(0, 60), start: e.start, end, days: n };
  }).filter((e) => e.end >= today && e.start <= until).sort((a, b) => a.start.localeCompare(b.start));
}
function tournamentLines(p, ref) {
  const ev = upcomingEvents(p, ref);
  const near = ev.length ? ev.map((e) => `- TOURNAMENT: "${e.name}" ${e.start}${e.days > 1 ? ` to ${e.end} (${e.days} days)` : ''}`).join('\n') + '\n' : '';
  const later = upcomingEvents(p, ref, 200).filter((e) => !ev.some((x) => x.start === e.start && x.name === e.name)).slice(0, 8);
  return near + (later.length ? `- Season calendar after that (build toward these across the coming weeks): ${later.map((e) => `"${e.name}" ${e.start}`).join(', ')}\n` : '');
}
// Starting numbers from setup: the first loads come from these until there is real history
function baselineLines(p) {
  const b = p.baseline; if (!b || typeof b !== 'object') return '';
  const lift = (name, x) => (x && x.kg > 0 && x.reps > 0 ? `${name} ${x.kg} kg × ${x.reps} (est. 1RM ~${Math.round((x.kg * (1 + Math.min(12, x.reps) / 30)) / 2.5) * 2.5} kg)` : '');
  const parts = [lift('Back squat', b.squat), lift('Bench press', b.bench), lift('Deadlift', b.deadlift), b.pushups > 0 && `max push-ups ${b.pushups}`, b.run5k && `5 km in ${b.run5k}`, b.runMin > 0 && `can run ${b.runMin} min easy`].filter(Boolean);
  return parts.length ? `\n- Starting numbers the athlete gave: ${parts.join('; ')}. Until there is training history, set first working loads at about 70–75% of the estimated 1RM and run volumes from these.` : '';
}

// What the athlete told Yosh over time (question of the day), as "Label: answer" pairs
function aboutLines(p) {
  const a = p.about && typeof p.about === 'object' ? Object.entries(p.about).filter(([, v]) => v != null && String(v).trim()) : [];
  return a.length ? '\n- What the athlete has told you (use it, and refer to it in each session\'s "why"): ' + a.map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`).join('; ') : '';
}
export function athleteBlock(p, id, ref = new Date(), { menu = true } = {}) {
  const goals = (p.goals || [p.goal]).filter(Boolean);
  return `Athlete
- Name: ${p.name}${[p.age && `age ${p.age}`, p.sex, p.heightCm && `${p.heightCm} cm`, p.weightKg && `${p.weightKg} kg`].filter(Boolean).map((x) => ', ' + x).join('') || ' (age, height and weight not given yet: keep loads to RPE)'}
- Sports: ${(p.sports || []).join(', ')} (main: ${(p.sports || [])[0]})${p.position ? `\n- Position: ${p.position}` : ''}${aboutLines(p)}
- Level: ${p.level}${baselineLines(p)}
- Goals in order: ${goals.join(' > ')}${p.goalNote ? `\n- Specific aim: ${p.goalNote}` : ''}
- Available days: ${p.days.map((d) => DAY_NAMES[d]).join(', ')}
${dayPrefBlock(p)}
- Typical session length: ${p.sessionMin} min
- Two sessions in one day: ${p.doubles === 'often' ? 'yes, happy to train twice on some days (e.g. gym in the morning, club practice in the evening)' : p.doubles === 'sometimes' ? 'occasionally, at most once or twice a week, only when the second one is easy or is club practice' : 'no, one session per day only'}
- Fixed commitments: ${p.fixed || 'none'}
- Equipment: ${(p.equipment || []).join(', ') || 'not given: assume bodyweight and a field'}
- Injuries / limits: ${p.injuries || 'none'}${p.weekNote ? `\n- WHAT THE ATHLETE SAID ABOUT THIS WEEK (highest priority, overrides everything else): "${p.weekNote}"` : ''}
- ${phaseFor(p, ref).text}
${tournamentLines(p, ref)}- Week ${p.weekNumber || 1} of the current block${((p.weekNumber || 1) % 4 === 0) ? ' — THIS IS A DELOAD WEEK' : ''}.
- Today: ${DAY_NAMES[(ref.getDay() + 6) % 7]} ${ref.toISOString().slice(0, 10)}; the plan is for ISO week ${id}, Monday to Sunday.
${menu ? `
Exercise vocabulary (use these exact names where the movement fits):
${exerciseMenu(p.equipment)}` : ''}
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

// "5x5" / "3 × 8" written into reps means sets × reps: split it so the app and the watch show every set
function setsReps(sets, reps) {
  const r = String(reps ?? '').trim();
  const m = r.match(/^(\d+)\s*[x×]\s*(\d+(?:\s*-\s*\d+)?)\s*(.*)$/i);
  if (m && (!Number(sets) || Number(sets) === 1 || Number(sets) === Number(m[1]))) return { sets: Number(m[1]), reps: (m[2].replace(/\s+/g, '') + (m[3] ? ' ' + m[3] : '')).trim() };
  return { sets: Number(sets) || 0, reps: r };
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
    targetRpe: Math.max(0, Math.min(10, Math.round(Number(s.targetRpe) || 0))) || null,
    intent: String(s.intent || ''),
    why: String(s.why || '').slice(0, 220),
    warmup: Array.isArray(s.warmup) ? s.warmup.map(String) : [],
    exercises: Array.isArray(s.exercises) ? s.exercises.map((x) => ({
      name: canonicalExercise(x.name), ...setsReps(x.sets, x.reps), load: tidyLoad(x.load, x.name),
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

// Guest (anonymous) accounts cost nothing to create, so they get tighter AI limits plus one shared daily cap,
// which keeps someone making endless guests from using up the free AI quota everyone shares.
export const isGuest = (user) => !!(user && user.firebase && user.firebase.sign_in_provider === 'anonymous');
export async function guestAllowed(user, key, perGuest, allGuests) {
  if (!isGuest(user)) return true;
  if (!(await checkLimit(user.uid, 'guest_' + key, perGuest))) return false;
  return checkLimit('_guests', key, allGuests);
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
// Same names with the equipment kept, so "barbell rows" stays a barbell row instead of snapping to the dumbbell one
const keepKit = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => (w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
const EXACT = new Map(EXERCISE_NAMES.map((n) => [keepKit(n), n]));

// Snap a model-written name onto the library when it clearly means the same movement.
// Scores candidates by how many of their words appear, preferring the one that starts where the athlete's name starts.
export function canonicalExercise(name) {
  const n = normalize(name);
  if (!n) return String(name || '').trim();
  if (EXACT.has(keepKit(name))) return EXACT.get(keepKit(name));
  // the input names its equipment: only accept a library name with the same equipment (or none)
  const kit = (keepKit(name).match(/\b(barbell|dumbbell|kettlebell)\b/) || [])[1];
  const kitOk = (c) => !kit || !/\b(barbell|dumbbell|kettlebell)\b/i.test(c) || c.toLowerCase().includes(kit);
  if (LOOKUP.has(n) && kitOk(LOOKUP.get(n))) return LOOKUP.get(n);
  const words = n.split(' ');
  let best = null, bestScore = 0;
  for (const canonical of EXERCISE_NAMES) {
    const key = normalize(canonical);
    const kw = key.split(' ');
    if (!kw.every((w) => words.includes(w)) || !kitOk(canonical)) continue;
    const leads = words[0] === kw[0] ? 1 : 0;
    const score = kw.length * 10 + leads * 5 + key.length / 100;
    if (score > bestScore) { bestScore = score; best = canonical; }
  }
  return best || String(name || '').trim();
}

const NEEDS_GYM = /Back squat|Front squat|Leg press|^Deadlift|Trap bar|Bench press|Incline bench|Overhead press|Push press|Barbell row|Lat pulldown|Seated cable|Face pull|Cable|Power clean|Hang clean|Push jerk|Clean pull|Hamstring curl|Sled|Assault bike|Rowing intervals|Bike intervals|Back extension|Landmine/;
const NEEDS_WEIGHTS = /Goblet|Dumbbell|Kettlebell|Medicine ball/;
export function exerciseMenu(equipment) {
  const eq = (equipment || []).join(' ');
  const gym = !equipment || !equipment.length || /Full gym/i.test(eq);
  const weights = gym || /Dumbbell|Kettlebell/i.test(eq);
  return Object.entries(EXERCISE_LIBRARY).map(([group, list]) => {
    const keep = list.filter((x) => (gym || !NEEDS_GYM.test(x)) && (weights || !NEEDS_WEIGHTS.test(x)));
    return keep.length ? `${group}: ${keep.join(', ')}` : '';
  }).filter(Boolean).join('\n');
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

// Fixed text of the fallback week, in each app language (exercise names stay as in the library, like AI plans)
const TEMPLATE_TEXT = {
  en: { tournament: "Tournament", tournamentIntent: "Between games: eat carbs within 30 min (banana, rice cakes, sandwich), sip ~500 ml per hour with electrolytes, 5 min easy mobility, stay warm.", rest: 'Rest', restIntent: 'Recovery day — walk, stretch, sleep well.', intent: 'Template session — rebuild the week when the plan service is back for something tailored.', focus: 'A solid default week built from your own settings.', rationale: 'The plan service was unavailable, so this week follows a standard template shaped by your training days, goals and session length. Rebuild it later for a tailored week.',
    titles: { strength: 'Full-body strength', speed: 'Speed and acceleration', conditioning: 'Conditioning', skills: 'Skills and agility', mobility: 'Mobility and recovery', match: 'Match' },
    loads: { 'full effort, full recovery': 'full effort, full recovery', 'sharp, not exhausting': 'sharp, not exhausting', easy: 'easy' }, reps: { '4-6 reps': '4-6 reps' } },
  fr: { tournament: "Tournoi", tournamentIntent: "Entre les matchs : glucides dans les 30 min (banane, galettes de riz, sandwich), ~500 ml par heure avec électrolytes, 5 min de mobilité douce, reste au chaud.", rest: 'Repos', restIntent: 'Journée de récupération — marche, étirements, bon sommeil.', intent: 'Séance modèle — refais la semaine quand le service de plans revient, pour un plan sur mesure.', focus: 'Une semaine de base solide, construite à partir de tes réglages.', rationale: "Le service de plans n'était pas disponible : cette semaine suit un modèle standard basé sur tes jours d'entraînement, tes objectifs et la durée de tes séances. Refais-la plus tard pour une semaine sur mesure.",
    titles: { strength: 'Force corps entier', speed: 'Vitesse et accélération', conditioning: 'Condition physique', skills: 'Technique et agilité', mobility: 'Mobilité et récupération', match: 'Match' },
    loads: { 'full effort, full recovery': 'effort maximal, récupération complète', 'sharp, not exhausting': 'vif, sans s’épuiser', easy: 'facile' }, reps: { '4-6 reps': '4-6 répétitions' } },
  nl: { tournament: "Toernooi", tournamentIntent: "Tussen de wedstrijden: koolhydraten binnen 30 min (banaan, rijstwafels, broodje), ~500 ml per uur met elektrolyten, 5 min rustige mobiliteit, blijf warm.", rest: 'Rust', restIntent: 'Hersteldag — wandelen, stretchen, goed slapen.', intent: 'Standaardtraining — bouw de week opnieuw zodra de planservice terug is, voor een plan op maat.', focus: 'Een degelijke standaardweek, gebouwd op je eigen instellingen.', rationale: 'De planservice was niet beschikbaar, dus deze week volgt een standaardsjabloon op basis van je trainingsdagen, doelen en trainingsduur. Bouw hem later opnieuw voor een week op maat.',
    titles: { strength: 'Kracht hele lichaam', speed: 'Snelheid en acceleratie', conditioning: 'Conditie', skills: 'Techniek en wendbaarheid', mobility: 'Mobiliteit en herstel', match: 'Wedstrijd' },
    loads: { 'full effort, full recovery': 'volle inzet, volledig herstel', 'sharp, not exhausting': 'scherp, niet uitputtend', easy: 'rustig' }, reps: { '4-6 reps': '4-6 herhalingen' } },
  tr: { tournament: "Turnuva", tournamentIntent: "Maçlar arasında: 30 dk içinde karbonhidrat (muz, pirinç patlağı, sandviç), saatte ~500 ml elektrolitli sıvı, 5 dk hafif mobilite, sıcak kal.", rest: 'Dinlenme', restIntent: 'Toparlanma günü — yürü, esne, iyi uyu.', intent: 'Şablon antrenman — plan servisi geri gelince sana özel bir hafta için haftayı yeniden oluştur.', focus: 'Kendi ayarlarından oluşturulmuş sağlam bir standart hafta.', rationale: 'Plan servisi kullanılamıyordu; bu yüzden bu hafta antrenman günlerine, hedeflerine ve antrenman süresine göre hazırlanmış standart bir şablonu izliyor. Sana özel bir hafta için daha sonra yeniden oluştur.',
    titles: { strength: 'Tüm vücut kuvveti', speed: 'Hız ve ivmelenme', conditioning: 'Kondisyon', skills: 'Teknik ve çeviklik', mobility: 'Mobilite ve toparlanma', match: 'Maç' },
    loads: { 'full effort, full recovery': 'tam efor, tam dinlenme', 'sharp, not exhausting': 'keskin, yormadan', easy: 'hafif' }, reps: { '4-6 reps': '4-6 tekrar' } },
  es: { tournament: "Torneo", tournamentIntent: "Entre partidos: carbohidratos en 30 min (plátano, tortitas de arroz, bocadillo), ~500 ml por hora con electrolitos, 5 min de movilidad suave, mantente caliente.", rest: 'Descanso', restIntent: 'Día de recuperación — camina, estira, duerme bien.', intent: 'Sesión de plantilla — rehaz la semana cuando vuelva el servicio de planes para tener algo a medida.', focus: 'Una semana base sólida, creada a partir de tus ajustes.', rationale: 'El servicio de planes no estaba disponible, así que esta semana sigue una plantilla estándar basada en tus días de entrenamiento, objetivos y duración de las sesiones. Rehazla más tarde para tener una semana a medida.',
    titles: { strength: 'Fuerza de cuerpo completo', speed: 'Velocidad y aceleración', conditioning: 'Acondicionamiento', skills: 'Técnica y agilidad', mobility: 'Movilidad y recuperación', match: 'Partido' },
    loads: { 'full effort, full recovery': 'esfuerzo máximo, recuperación completa', 'sharp, not exhausting': 'rápido, sin agotarse', easy: 'suave' }, reps: { '4-6 reps': '4-6 repeticiones' } },
};
// A sensible week built from the athlete's own settings, so a model outage is not a dead end
export function templatePlan(profile, id) {
  const tx = TEMPLATE_TEXT[profile.lang] || TEMPLATE_TEXT.en;
  const days = (profile.days && profile.days.length ? profile.days : [1, 3, 5]).slice(0, 7);
  const goals = (profile.goals || [profile.goal] || []).filter(Boolean);
  const rotation = [...new Set([GOAL_TO_TYPE[goals[0]] || 'strength', 'strength', GOAL_TO_TYPE[goals[1]] || 'speed', 'conditioning'])];
  const prefs = profile.dayPrefs || {};
  const sessions = [];
  let r = 0, slAlt = 0;
  const asked = [profile.weekNote, profile.goalNote].filter(Boolean).join(' ');
  const sch = asked.match(/\b(\d{1,2})\s*[x×]\s*(\d{1,2})\b/);
  const wanted = { stronglifts: /strong\s*lifts?|\b5\s*[x×]\s*5\b/i.test(asked), scheme: sch ? [Number(sch[1]), Number(sch[2])] : null };
  const lastLoad = profile.lastLoads || {};
  if (wanted.stronglifts) rotation.splice(0, rotation.length, 'strength', GOAL_TO_TYPE[goals[1]] && GOAL_TO_TYPE[goals[1]] !== 'strength' ? GOAL_TO_TYPE[goals[1]] : 'speed', 'strength', 'conditioning');
  // tournament days this week, as weekday indexes
  const mon = mondayOf(id);
  const dateOf = (d) => new Date(mon.getTime() + d * 864e5).toISOString().slice(0, 10);
  const evs = upcomingEvents(profile, new Date(mon.getTime() - 864e5), 14);
  const evOn = (d) => evs.find((e) => dateOf(d) >= e.start && dateOf(d) <= e.end);
  const nearEv = (d) => evs.some((e) => { const t = Date.parse(e.start + 'T12:00:00Z') - Date.parse(dateOf(d) + 'T12:00:00Z'); return t > 0 && t <= 2 * 864e5; });
  const afterEv = (d) => evs.some((e) => dateOf(d) === new Date(Date.parse(e.end + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10));
  for (let d = 0; d < 7; d++) {
    const ev = evOn(d);
    if (ev) {
      sessions.push({ day: d, slot: 0, timeOfDay: 'morning', title: `${tx.tournament || 'Tournament'}: ${ev.name}`, type: 'match', fixed: true, durationMin: 0, intent: tx.tournamentIntent || 'Between games: eat carbs within 30 min (banana, rice cakes, sandwich), sip ~500 ml per hour with electrolytes, 5 min easy mobility, stay warm.', warmup: EXERCISE_LIBRARY.warmup.slice(0, 4).map((x) => `${x}, 30 s`), exercises: [], cooldown: EXERCISE_LIBRARY.mobility.slice(0, 2).map((x) => `${x}, 45 s`) });
      continue;
    }
    if (days.includes(d) && (nearEv(d) || afterEv(d))) {
      const tpl = TEMPLATES.mobility;
      sessions.push({ day: d, slot: 0, timeOfDay: null, title: tx.titles.mobility || tpl.title, type: 'mobility', fixed: false, durationMin: Math.min(40, profile.sessionMin || 40), intent: tx.intent, warmup: [], exercises: EXERCISE_LIBRARY.mobility.slice(0, 5).map((name) => ({ name, sets: 2, reps: '45 s', load: tx.loads.easy || 'easy', restSec: 15, cues: '' })), cooldown: [] });
      continue;
    }
    if (!days.includes(d)) {
      sessions.push({ day: d, slot: 0, timeOfDay: null, title: tx.rest, type: 'rest', fixed: false, durationMin: 0, intent: tx.restIntent, warmup: [], exercises: [], cooldown: [] });
      continue;
    }
    const slots = (prefs[d] && prefs[d].length ? prefs[d] : [{ time: '', focus: '' }]).slice(0, 2);
    slots.forEach((slot, i) => {
      const key = slot.focus || rotation[r++ % rotation.length];
      const tpl = TEMPLATES[key] || TEMPLATES.strength;
      let exercises = tpl.pick.flatMap(([group, n]) => (EXERCISE_LIBRARY[group] || []).slice(0, n).map((name) => ({
        name, sets: tpl.sets, reps: tx.reps[tpl.reps] || tpl.reps, load: tx.loads[tpl.load] || tpl.load, restSec: tpl.type === 'speed' ? 180 : 90, cues: '',
      })));
      let title = tx.titles[key] || tpl.title;
      // A program the athlete asked for still applies when the AI is unavailable
      if (tpl.type === 'strength' && wanted.stronglifts) {
        const A = slAlt++ % 2 === 0;
        title = `StrongLifts 5x5 · ${A ? 'A' : 'B'}`;
        exercises = (A ? [['Back squat', 5], ['Bench press', 5], ['Barbell row', 5]] : [['Back squat', 5], ['Overhead press', 5], ['Deadlift', 1]])
          .map(([name, sets]) => ({ name, sets, reps: '5', load: lastLoad[name.toLowerCase()] ? `${lastLoad[name.toLowerCase()]} kg` : 'RPE 7', restSec: 180, cues: '' }));
      } else if (tpl.type === 'strength' && wanted.scheme) {
        exercises = exercises.map((x) => ({ ...x, sets: wanted.scheme[0], reps: String(wanted.scheme[1]) }));
      }
      sessions.push({
        day: d, slot: i, timeOfDay: slot.time || (i ? 'evening' : null),
        title, type: tpl.type, fixed: false,
        durationMin: profile.sessionMin || 60,
        intent: tx.intent,
        warmup: EXERCISE_LIBRARY.warmup.slice(0, 4).map((x) => `${x}, 30 s`),
        exercises, cooldown: EXERCISE_LIBRARY.mobility.slice(0, 3).map((x) => `${x}, 45 s`),
      });
    });
  }
  return {
    weekId: id, phase: 'base', focus: tx.focus,
    sessions, rationale: tx.rationale,
    nextWeekHint: '', source: 'template', createdAt: new Date().toISOString(),
  };
}

// Last working weight per exercise (heaviest completed set of the latest session with that lift), for the backup week
export async function lastLoads(uid) {
  const out = {};
  try {
    const q = await db().collection(`users/${uid}/logs`).orderBy('loggedAt', 'desc').limit(80).get();
    for (const d of q.docs) {
      for (const ex of d.data().exercises || []) {
        const k = String(ex.name || '').toLowerCase();
        if (!k || out[k]) continue;
        const kg = Math.max(0, ...(ex.sets || []).filter((st) => st.done).map((st) => Number(String(st.load ?? '').replace(',', '.')) || 0));
        if (kg > 0) out[k] = kg;
      }
    }
  } catch (_) {}
  return out;
}

// ---------------- StrongLifts-style linear progression, decided by code, not by the model ----------------
// +2.5 kg (deadlift +5) after a session where every set hit its reps; same weight after a miss; −10% after three misses in a row.
const MAIN_LIFTS = { 'back squat': 2.5, 'bench press': 2.5, 'barbell row': 2.5, 'overhead press': 2.5, deadlift: 5 };
const r25 = (kg) => Math.round(kg / 2.5) * 2.5;
export async function liftHistory(uid) {
  const out = {};
  try {
    const q = await db().collection(`users/${uid}/logs`).orderBy('loggedAt', 'desc').limit(120).get();
    for (const d of q.docs) {
      const l = d.data();
      if (l.eased || l.status === 'skipped') continue;
      for (const ex of l.exercises || []) {
        const k = String(ex.name || '').toLowerCase();
        if (!(k in MAIN_LIFTS)) continue;
        const sets = ex.sets || [];
        const done = sets.filter((st) => st.done && Number(st.load) > 0);
        if (!done.length) continue;
        const load = Math.max(...done.map((st) => Number(st.load)));
        const target = Number(String(ex.prescribed || '').match(/[x×]\s*(\d+)/)?.[1]) || 5;
        const success = done.length === sets.length && done.every((st) => Number(st.reps) >= target);
        (out[k] = out[k] || []).push({ load, success, at: l.loggedAt });
      }
    }
  } catch (_) {}
  return out;
}
export function nextLoad(hist, inc) {
  if (!hist?.length) return null;
  const last = hist[0];
  if (last.success) return { kg: r25(last.load + inc), why: 'up' };
  let fails = 0;
  for (const h of hist) { if (h.load !== last.load || h.success) break; fails++; }
  if (fails >= 3) return { kg: r25(last.load * 0.9), why: 'deload' };
  return { kg: last.load, why: 'repeat' };
}
// Applies to sessions that are a 5x5 program; each further session with the same lift in the week adds one more step
export function applyProgression(plan, hist) {
  const running = {};
  const is5x5 = (s) => /strong\s*lifts?|5\s*[x×]\s*5/i.test(s.title || '') || (s.exercises || []).filter((e) => String(e.name || '').toLowerCase() in MAIN_LIFTS && Number(e.sets) === 5 && String(e.reps) === '5').length >= 2;
  for (const s of [...(plan.sessions || [])].sort((a, b) => a.day - b.day || (a.slot || 0) - (b.slot || 0))) {
    if (s.type !== 'strength' || s.eased || !is5x5(s)) continue;
    for (const e of s.exercises || []) {
      const k = String(e.name || '').toLowerCase();
      if (!(k in MAIN_LIFTS)) continue;
      if (running[k]) { running[k] = { kg: running[k].why === 'deload' || running[k].why === 'repeat' ? running[k].kg : r25(running[k].kg + MAIN_LIFTS[k]), why: running[k].why === 'up' ? 'up' : running[k].why }; }
      else running[k] = nextLoad(hist[k], MAIN_LIFTS[k]);
      if (!running[k]) continue;
      e.load = `${running[k].kg} kg`;
      e.progression = running[k].why;
      // once the athlete repeats a weight this week, the next session of the week goes up again if it works
      if (running[k].why !== 'up') running[k] = { ...running[k], why: 'up' };
    }
  }
  return plan;
}

// ---------------- A personal "why" for each session (backup weeks, or when the model left it out) ----------------
const WHY_TEXT = {
  en: { speed: { handler: 'Short, sharp sprints: as a handler your first three steps decide whether you get free for the reset.', cutter: 'Acceleration and top speed: that is what separates you from your defender on deep cuts.', any: 'Speed work early in the week, while your legs are fresh.' }, conditioning: { handler: 'Repeat efforts so you are still sharp on the last point, not just the first.', cutter: 'Repeat sprints with short rest, like a long point of cutting.', any: 'Builds the engine so you recover faster between efforts.' }, strength: { any: 'Strength is what makes your sprints faster and protects you from injuries.', injury: 'Strength with extra care for your {injury}: the safest way to keep it from coming back.' }, skills: { any: 'Your team practice: the plan keeps hard work away from it so you play fresh.' }, match: { any: 'Game day: everything this week is built so you arrive fresh.' }, mobility: { any: 'Easy mobility to stay loose and recover well.' }, improve: 'Focus on your {weak}, the thing you said you most want to improve.' },
  fr: { speed: { handler: 'Sprints courts et vifs : en tant que handler, tes trois premiers pas décident si tu te libères pour le reset.', cutter: 'Accélération et vitesse max : c’est ce qui te sépare de ton défenseur en profondeur.', any: 'Vitesse en début de semaine, quand tes jambes sont fraîches.' }, conditioning: { handler: 'Efforts répétés pour rester vif au dernier point, pas seulement au premier.', cutter: 'Sprints répétés avec peu de repos, comme un long point de coupes.', any: 'Développe ton moteur pour mieux récupérer entre les efforts.' }, strength: { any: 'La force rend tes sprints plus rapides et te protège des blessures.', injury: 'Force avec une attention particulière pour ton {injury} : le meilleur moyen d’éviter la rechute.' }, skills: { any: 'Ton entraînement d’équipe : le plan garde le travail dur loin de lui pour que tu joues frais.' }, match: { any: 'Jour de match : toute la semaine est pensée pour que tu arrives frais.' }, mobility: { any: 'Mobilité douce pour rester souple et bien récupérer.' }, improve: 'Focus sur ton {weak}, ce que tu veux le plus améliorer.' },
  nl: { speed: { handler: 'Korte, scherpe sprints: als handler bepalen je eerste drie passen of je vrijkomt voor de reset.', cutter: 'Acceleratie en topsnelheid: dat maakt het verschil met je verdediger bij diepe cuts.', any: 'Snelheid vroeg in de week, met frisse benen.' }, conditioning: { handler: 'Herhaalde inspanningen zodat je ook bij het laatste punt scherp bent.', cutter: 'Herhaalde sprints met korte rust, zoals een lang punt cutten.', any: 'Bouwt je motor zodat je sneller herstelt tussen inspanningen.' }, strength: { any: 'Kracht maakt je sprints sneller en beschermt je tegen blessures.', injury: 'Kracht met extra zorg voor je {injury}: de veiligste manier om terugval te voorkomen.' }, skills: { any: 'Je teamtraining: het plan houdt zwaar werk ervan weg zodat je fris speelt.' }, match: { any: 'Wedstrijddag: de hele week is erop gebouwd dat je fris aankomt.' }, mobility: { any: 'Rustige mobiliteit om soepel te blijven en goed te herstellen.' }, improve: 'Focus op je {weak}, wat je het liefst wilt verbeteren.' },
  tr: { speed: { handler: 'Kısa, keskin sprintler: handler olarak ilk üç adımın reset için boşa çıkıp çıkmayacağını belirler.', cutter: 'İvmelenme ve son hız: derin kesişlerde seni savunmacından ayıran bu.', any: 'Bacakların tazeyken, hafta başında hız çalışması.' }, conditioning: { handler: 'Tekrarlı eforlar, sadece ilk sayıda değil son sayıda da keskin ol diye.', cutter: 'Kısa dinlenmeli tekrarlı sprintler, uzun bir sayıda kesiş yapar gibi.', any: 'Eforlar arasında daha hızlı toparlanman için motorunu geliştirir.' }, strength: { any: 'Kuvvet sprintlerini hızlandırır ve seni sakatlıklardan korur.', injury: '{injury} için ekstra özenle kuvvet: tekrarlamasını önlemenin en güvenli yolu.' }, skills: { any: 'Takım antrenmanın: plan ağır işi ondan uzak tutar, taze oynarsın.' }, match: { any: 'Maç günü: bütün hafta taze gelmen için kuruldu.' }, mobility: { any: 'Esnek kalman ve iyi toparlanman için hafif mobilite.' }, improve: 'Odak: en çok geliştirmek istediğin {weak}.' },
  es: { speed: { handler: 'Sprints cortos y explosivos: como handler, tus tres primeros pasos deciden si te liberas para el reset.', cutter: 'Aceleración y velocidad máxima: es lo que te separa de tu defensor en los cortes largos.', any: 'Velocidad al inicio de la semana, con las piernas frescas.' }, conditioning: { handler: 'Esfuerzos repetidos para seguir fino en el último punto, no solo en el primero.', cutter: 'Sprints repetidos con poco descanso, como un punto largo de cortes.', any: 'Construye tu motor para recuperar antes entre esfuerzos.' }, strength: { any: 'La fuerza hace tus sprints más rápidos y te protege de lesiones.', injury: 'Fuerza con cuidado extra para tu {injury}: la forma más segura de que no vuelva.' }, skills: { any: 'Tu entrenamiento de equipo: el plan aleja el trabajo duro para que juegues fresco.' }, match: { any: 'Día de partido: toda la semana está pensada para que llegues fresco.' }, mobility: { any: 'Movilidad suave para mantenerte suelto y recuperar bien.' }, improve: 'Enfoque en tu {weak}, lo que más quieres mejorar.' },
};
export function personalWhy(s, p = {}) {
  const tx = WHY_TEXT[p.lang] || WHY_TEXT.en;
  if (s.type === 'rest') return '';
  const t = tx[s.type] || tx.mobility;
  const injury = String(p.about?.['Injury history'] || '').split(',').map((x) => x.trim()).find((x) => x && x !== 'Nothing');
  let why = s.type === 'strength' && injury ? t.injury.replace('{injury}', injury.toLowerCase()) : (t[p.position] || t.any);
  const weak = p.about?.['Wants to improve most'];
  if (weak && ['speed', 'conditioning', 'strength'].includes(s.type) && !(s.type === 'strength' && injury)) why = tx.improve.replace('{weak}', String(weak).toLowerCase());
  // the countdown to the next tournament lives in the Today header, not in every session's reason
  return why;
}
export function applyWhy(plan, p) {
  for (const s of plan.sessions || []) if (!s.why && s.type !== 'rest') s.why = personalWhy(s, p);
  return plan;
}

// ---------------- Weekly fitness tests: a short benchmark block, rotating between two sets ----------------
export const FITNESS_TESTS = {
  sprint10: { name: '10 m sprint test', unit: 's', better: 'lower', sets: 3, reps: 'best of 3', restSec: 150, set: 'A' },
  sprint30: { name: '30 m sprint test', unit: 's', better: 'lower', sets: 3, reps: 'best of 3', restSec: 180, set: 'A' },
  broad: { name: 'Standing broad jump test', unit: 'cm', better: 'higher', sets: 3, reps: 'best of 3', restSec: 60, set: 'A' },
  agility: { name: '5-10-5 agility test', unit: 's', better: 'lower', sets: 4, reps: 'best of 2 each way', restSec: 90, set: 'B' },
  yoyo: { name: 'Yo-Yo IR1 test', unit: 'm', better: 'higher', sets: 1, reps: 'until you miss twice', restSec: 0, set: 'B' },
};
const weekNo = (id) => Number(String(id).split('-W')[1]) || 0;
// Puts this week's tests at the start of the right sessions (after the warm-up, when fresh). Idempotent.
export function applyTests(plan, profile = {}, { fromDay = 0 } = {}) {
  for (const s of plan.sessions || []) if (Array.isArray(s.exercises)) s.exercises = s.exercises.filter((e) => !e.test);
  if (profile.testsOff) return plan;
  // no tests in a tournament week
  const mon = mondayOf(plan.weekId);
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(mon.getTime() + d * 864e5).toISOString().slice(0, 10));
  if (upcomingEvents(profile, new Date(mon.getTime() - 864e5), 8).some((e) => days.some((d) => d >= e.start && d <= e.end))) return plan;
  // injuries come first: a note about pain this week means no testing at all; standing limits drop the tests that load them
  const note = String(profile.weekNote || plan.weekNote || '');
  if (/pain|injur|sprain|strain|hurt|sore|blessure|douleur|pijn|ağrı|sakat|dolor|lesi/i.test(note)) return plan;
  const limits = `${note} ${profile.injuries || ''} ${profile.about?.['Injury history'] || ''}`;
  const blocked = new Set();
  if (/jump|ankle|knee|achilles|saut|cheville|genou|enkel|knie|diz|bilek|tobillo|rodilla/i.test(limits)) blocked.add('broad');
  if (/hamstring|calf|groin|ischio|mollet|kuit|lies|arka adale|baldır|kasık|isquio|gemelo|ingle/i.test(limits)) { blocked.add('sprint10'); blocked.add('sprint30'); blocked.add('agility'); }
  const set = weekNo(plan.weekId) % 2 === 0 ? 'A' : 'B';
  const open = (types) => (plan.sessions || []).filter((s) => s.day >= fromDay && !s.fixed && !s.eased && types.includes(s.type)).sort((a, b) => a.day - b.day)[0];
  const host = open(['speed']) || open(['skills', 'conditioning']) || open(['strength']);
  if (!host) return plan;
  const mk = (key) => { const t = FITNESS_TESTS[key]; return { name: t.name, sets: t.sets, reps: t.reps, load: 'full effort, timed', restSec: t.restSec, cues: '', test: key }; };
  if (set === 'A') host.exercises = [...['sprint10', 'sprint30', 'broad'].filter((k) => !blocked.has(k)).map(mk), ...(host.exercises || [])];
  else {
    if (!blocked.has('agility')) host.exercises = [mk('agility'), ...(host.exercises || [])];
    // the Yo-Yo is exhausting: a conditioning session of its own if there is one, otherwise last in the same session
    const cond = (plan.sessions || []).filter((s) => s !== host && s.day >= fromDay && !s.fixed && !s.eased && s.type === 'conditioning').sort((a, b) => a.day - b.day)[0];
    if (cond) cond.exercises = [mk('yoyo'), ...(cond.exercises || [])];
    else host.exercises.push(mk('yoyo'));
  }
  return plan;
}
// Latest results per test with the previous one, for the weekly review
export async function testSummary(uid) {
  try {
    const q = await db().collection(`users/${uid}/tests`).orderBy('at', 'desc').limit(60).get();
    const by = {};
    for (const d of q.docs) { const t = d.data(); (by[t.key] = by[t.key] || []).push(t); }
    const lines = Object.entries(by).filter(([k]) => FITNESS_TESTS[k]).map(([k, arr]) => {
      const T = FITNESS_TESTS[k]; const [last, prev] = arr; const best = arr.reduce((b, x) => (T.better === 'lower' ? (x.value < b ? x.value : b) : (x.value > b ? x.value : b)), arr[0].value);
      return `${T.name.replace(' test', '')}: ${last.value} ${T.unit} on ${String(last.at).slice(0, 10)}${prev ? ` (previous ${prev.value} ${T.unit} on ${String(prev.at).slice(0, 10)})` : ''}, best ${best} ${T.unit}, ${T.better} is better`;
    });
    return lines.length ? `Fitness test results (use them to judge whether the plan is working; if a test is getting worse, say so and adjust):\n- ${lines.join('\n- ')}` : '';
  } catch (_) { return ''; }
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
      // estimated one-rep max (Epley), from sets of 1–12 reps only
      for (const st of done) { const r = Number(st.reps), l = Number(st.load); if (l > 0 && r >= 1 && r <= 12) { const e = l * (1 + r / 30); if (!cur.e1rm || e > cur.e1rm) cur.e1rm = e; } }
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
    const e1 = e.e1rm ? `, est. 1RM ~${Math.round(e.e1rm / 2.5) * 2.5}kg` : '';
    return `  · ${e.name}: ${e.last} on ${String(e.lastAt).slice(5, 10)}${best}${e1}${rpe} ×${e.sessions}`;
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

// ---------- what happened recently: given to every plan build, not only to the weekly review ----------
export async function recentBlock(uid, ref = new Date()) {
  const lines = [];
  try {
    const since = new Date(ref.getTime() - 10 * 864e5).toISOString();
    const q = await db().collection(`users/${uid}/logs`).orderBy('loggedAt', 'desc').limit(40).get();
    const logs = q.docs.map((d) => d.data()).filter((l) => (l.loggedAt || '') >= since);
    const ses = logs.slice(0, 20).map((l) => {
      const bits = [l.status === 'skipped' ? 'SKIPPED' : (l.status || 'done'), l.durationMin && `${l.durationMin} min`, l.sessionRpe && `RPE ${l.sessionRpe}`, l.readiness && `felt ${l.readiness} before`, l.garmin?.avgHr && `avg HR ${l.garmin.avgHr}`].filter(Boolean).join(', ');
      return `  · ${String(l.loggedAt).slice(5, 10)} ${l.extra || l.source === 'garmin' ? '(extra, not planned) ' : ''}${l.title || l.type} (${l.type || '?'}): ${bits}`;
    });
    if (ses.length) lines.push(`- Last 10 days, session by session (hard recent work means more recovery now; do not pile skipped sessions on top of the new week):\n${ses.join('\n')}`);
  } catch (_) { /* no logs yet */ }
  try {
    const ds = [0, 1, 2].map((i) => new Date(ref.getTime() - i * 864e5).toISOString().slice(0, 10));
    const gd = (await Promise.all(ds.map((d) => db().doc(`users/${uid}/garmin/${d}`).get()))).filter((d) => d.exists).map((d) => d.data());
    if (gd.length) lines.push(`- Watch, last ${gd.length} nights (newest first): ${gd.map((x) => [x.date, x.sleepH != null && `sleep ${x.sleepH} h`, x.readiness != null && `readiness ${x.readiness}`, typeof x.recoveryMin === 'number' && `recovery ${Math.round(x.recoveryMin / 60)} h`, x.hrvStatus && `HRV ${x.hrvStatus}`].filter(Boolean).join(' ')).join('; ')}. If the latest night was poor (readiness under 40, sleep under 6 h or recovery over 24 h), keep today and tomorrow easy.`);
  } catch (_) { /* no watch */ }
  try {
    const r = await db().collection(`users/${uid}/reviews`).orderBy('weekId', 'desc').limit(1).get();
    if (!r.empty) { const v = r.docs[0].data(); const st = v.stats || {}; lines.push(`- Last weekly review (${v.weekId}): did ${st.adherence ?? '?'}% of planned sessions, average session RPE ${st.avgRpe ?? '?'}${st.skipped ? `, ${st.skipped} skipped` : ''}.`); }
  } catch (_) { /* no review yet */ }
  const t = await testSummary(uid); if (t) lines.push(t);
  return lines.join('\n');
}

// ---------- coach check: hard rules the AI sometimes breaks, fixed in code after every plan ----------
const isTeam = (s) => s.type === 'match' || (s.fixed && s.type === 'skills');
const isHard = (s) => !s.fixed && (s.type === 'speed' || s.type === 'conditioning');
const trimSets = (s, f) => { (s.exercises || []).forEach((x) => { if (x.sets > 2) x.sets = Math.max(2, Math.round(x.sets * f)); }); };
const RISKY = [
  { area: /knee/i, ex: /depth jump|bounding|box jump|broad jump/i, swap: 'Glute bridge' },
  { area: /ankle|achilles/i, ex: /depth jump|pogo hop|bounding|box jump|broad jump/i, swap: 'Calf raise' },
  { area: /shoulder/i, ex: /overhead press|push press|push jerk|kettlebell snatch|dip/i, swap: 'Landmine press' },
  { area: /lower back|back pain|lumbar/i, ex: /^deadlift$|power clean|hang clean|clean pull/i, swap: 'Hip thrust' },
  { area: /hamstring/i, ex: /flying sprint|sprint 40 m|sprint 30 m/i, swap: 'Sprint 10 m' },
];
export function coachCheck(plan, profile = {}) {
  const notes = []; const S = plan.sessions || []; const trimmed = new Set();
  const byDay = (d) => S.filter((s) => s.day === d);
  // 1. the day before a team practice or game stays light
  for (let d = 0; d < 6; d++) {
    if (!byDay(d + 1).some(isTeam)) continue;
    for (const s of byDay(d).filter(isHard)) { trimmed.add(s); trimSets(s, 0.5); s.intent = `${s.intent ? s.intent + ' ' : ''}Kept short: team day tomorrow.`.trim(); notes.push(`${DAY_NAMES[d]}: lighter before team day`); }
  }
  // 2. no two hard sessions on consecutive days
  for (let d = 1; d < 7; d++) {
    if (!byDay(d - 1).some(isHard)) continue;
    for (const s of byDay(d).filter(isHard)) { if (trimmed.has(s)) continue; trimSets(s, 0.67); notes.push(`${DAY_NAMES[d]}: trimmed, hard day before`); }
  }
  // 3. a deload week is really lighter
  if ((profile.weekNumber || 1) % 4 === 0) {
    const str = S.filter((s) => s.type === 'strength').flatMap((s) => s.exercises || []);
    const avg = str.length ? str.reduce((a, x) => a + (x.sets || 0), 0) / str.length : 0;
    if (avg > 3) { S.filter((s) => s.type === 'strength').forEach((s) => trimSets(s, 0.6)); notes.push('deload week: strength sets cut'); }
  }
  // 4. injuries: swap the riskiest movements for a safe one
  const hurt = `${profile.injuries || ''} ${profile.weekNote || ''} ${profile.about?.['Injury history'] || ''}`;
  for (const r of RISKY) {
    if (!r.area.test(hurt)) continue;
    for (const s of S) for (const x of s.exercises || []) if (r.ex.test(x.name) && !x.test) { notes.push(`${x.name} → ${r.swap} (${hurt.match(r.area)[0]})`); x.name = r.swap; x.cues = ''; }
  }
  plan.coachChecks = notes.slice(0, 20);
  return plan;
}

// The plan rules, minus the ones that cannot apply to this athlete this week (shorter prompt, fewer distractions)
export function planRules(p = {}, ref = new Date()) {
  const text = `${p.goalNote || ''} ${p.weekNote || ''} ${Object.values(p.about || {}).join(' ')}`;
  const drop = [];
  if (!/5\s*[x×]\s*5|stronglifts|\d\s*[x×]\s*\d|program/i.test(text)) drop.push(/named program or a set\/rep scheme/);
  if (!upcomingEvents(p, ref).length) drop.push(/^- Tournaments listed above/);
  if (!p.doubles || p.doubles === 'no') drop.push(/Each session has a "slot"/);
  if (!p.about?.['Often skips']) drop.push(/"Often skips"/);
  return PLAN_RULES.split('\n').filter((l) => !drop.some((re) => re.test(l))).join('\n');
}

// ---------- one plan request, built the same way everywhere ----------
// Everything identical for most athletes comes first (role, output format, exercise list, the fixed rules), so
// Gemini's automatic prompt cache can reuse it; the athlete's own data comes last.
const PLAN_ROLE = `You are an experienced strength & conditioning coach writing a one-week training plan for an athlete. Be specific and practical: real exercise names, sets, reps, loads from the athlete's own history or starting numbers when given, otherwise an RPE with a sensible kilogram range, rest times, and short coaching cues an athlete can read on a phone at the gym or field.`;
export function planSystem(profile, { fromDay = 0 } = {}) {
  return `${PLAN_ROLE}

Return ONLY a JSON object with exactly this shape:
${planShape('')}

Exercise vocabulary (use these exact names where the movement fits):
${exerciseMenu(profile.equipment)}

${planRules(profile)}${fromDay > 0 ? `
- ONLY write sessions for ${DAY_NAMES[fromDay]} to Sunday (day ${fromDay} to day 6). The earlier days of this week are already over: do not include them, and do not try to make up for them.` : ''}`;
}
export function planUser(profile, id, { history, recent, ref } = {}) {
  return athleteBlock(profile, id, ref, { menu: false }) + (history ? '\n' + history : '') + (recent ? '\n' + recent : '');
}
// days already over keep what the athlete had (or become rest); the model only wrote the rest of the week
export function keepPastDays(plan, fromDay, oldSessions) {
  if (!fromDay) return plan;
  const past = (oldSessions || []).filter((s) => s.day < fromDay);
  const filler = [];
  for (let d = 0; d < fromDay; d++) if (!past.some((s) => s.day === d)) filler.push({ day: d, slot: 0, timeOfDay: null, title: 'Rest', type: 'rest', fixed: false, durationMin: 0, intent: 'Before this plan started.', warmup: [], exercises: [], cooldown: [] });
  plan.sessions = [...past, ...filler, ...(plan.sessions || []).filter((s) => s.day >= fromDay)].sort((a, b) => a.day - b.day || (a.slot || 0) - (b.slot || 0));
  return plan;
}
// what each AI call cost, for the admin panel
export async function logAiCall(uid, route, meta, extra = {}) {
  try { await db().collection('aiCalls').add({ uid: uid || null, route, ...meta, ...extra, at: new Date().toISOString() }); } catch (_) { /* never break the request */ }
}
