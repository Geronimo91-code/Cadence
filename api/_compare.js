// One-off comparison of free AI models on the same plan request (fake athlete). Run by a cron, read with a token.
import crypto from 'node:crypto';
import { db, planSystem, planUser, validatePlan, coachCheck, extractJson, EXERCISE_LIBRARY, canonicalExercise } from './_lib.js';

const TOKEN_HASH = 'd705a373bc1842b5f8c647b1eeb4ee2aa970678612f12704bfd45a6bebefc803';
export const okToken = (t) => typeof t === 'string' && crypto.createHash('sha256').update(t).digest('hex') === TOKEN_HASH;

// the 8 candidates: an ordered list of id patterns, the first id the provider actually lists is used
const CANDIDATES = [
  { label: 'Gemini 3.6 Flash (current)', prov: 'gemini', want: [/^gemini-3\.6-flash$/] },
  { label: 'Gemini 3.8 Flash', prov: 'gemini', want: [/^gemini-3\.8-flash$/, /^gemini-3\.8-flash-/, /^gemini-flash-latest$/] },
  { label: 'Gemini 3.5 Flash-Lite', prov: 'gemini', want: [/^gemini-3\.5-flash-lite$/, /^gemini-3\.5-flash-lite-/, /^gemini-flash-lite-latest$/] },
  { label: 'Gemini 2.5 Flash', prov: 'gemini', want: [/^gemini-2\.5-flash$/] },
  { label: 'Gemma 4', prov: 'gemini', want: [/^gemma-4-31b/, /^gemma-4-2\d?b/, /^gemma-4/] },
  { label: 'Nemotron 3 Ultra (OpenRouter)', prov: 'openrouter', want: [/nemotron-3-ultra.*:free$/, /nemotron.*ultra.*:free$/, /nemotron.*:free$/] },
  { label: 'gpt-oss 120B (OpenRouter)', prov: 'openrouter', want: [/gpt-oss-120b:free$/, /gpt-oss.*:free$/] },
  { label: 'Llama 3.3 70B (OpenRouter)', prov: 'openrouter', want: [/llama-3\.3-70b-instruct:free$/, /llama-3.*70b.*:free$/, /llama.*:free$/] },
];

const PROFILE = { name: 'Alex', age: 35, sex: 'Male', heightCm: 172, weightKg: 74, sports: ['Ultimate Frisbee'], position: 'handler', level: 'competitive', goals: ['speed', 'strength'], days: [0, 1, 3, 5], sessionMin: 60, doubles: 'no',
  dayPrefs: { 3: [{ time: 'evening', focus: 'skills' }] }, fixed: 'Team practice or games on Thu', equipment: ['Full gym', 'Field or track'], injuries: 'Recurring: Ankle', lang: 'en', weekNumber: 3, timezone: 'Europe/Brussels',
  about: { 'Plays at': 'Club team', 'Season now': 'Indoor season', 'Injury history': 'Ankle', 'Team practice intensity': 'Hard', 'Prefers training': 'Evening', 'Gym experience': 'More than 3 years', Enjoys: 'Sprints, Lifting', 'Coaching style': 'Push me hard', 'Usual sleep': '6–7 h', 'Life stress': 'Normal', 'Never include': 'burpees' },
  baseline: { squat: { kg: 100, reps: 5 }, bench: { kg: 75, reps: 5 }, pushups: 40, run5k: '24:30' },
  events: [{ name: 'Indoor Nationals', start: '2026-12-05', days: 2 }, { name: 'Windmill', start: '2027-06-12', days: 3 }] };
const HISTORY = `- What the athlete has actually done in the last 16 weeks (reps×kg per set, most important movements first). Prescribe loads from these numbers — progress, hold or back off — rather than generic percentages:
  · Back squat: 5×100/5×100/5×100/5×100 on 11-05, best 100kg (from 85), est. 1RM ~117.5kg, RPE~8 ×9
  · Bench press: 5×75/5×75/5×75/4×75 on 11-03, best 77.5kg (from 70), est. 1RM ~90kg, RPE~8.5 ×8
  · Romanian deadlift: 8×80/8×80/8×80 on 11-05, best 80kg, est. 1RM ~100kg, RPE~7 ×6
  · Pull-up: 8/7/6 on 11-03 ×7
  · Sprint 10 m: 1/1/1/1/1/1 on 11-02 ×5`;
const RECENT = `- Last 10 days, session by session (hard recent work means more recovery now; do not pile skipped sessions on top of the new week):
  · 11-07 (extra, not planned) Indoor game (match): done, 70 min, RPE 8, avg HR 151
  · 11-05 Acceleration + lower body (speed): done, 62 min, RPE 8, felt Normal before
  · 11-03 Upper body + core (strength): done, 48 min, RPE 7
  · 11-01 Repeat sprints (conditioning): SKIPPED
- Watch, last 3 nights (newest first): sleep 6.4 h readiness 47 recovery 18 h HRV balanced; sleep 7.1 h readiness 62; sleep 5.8 h readiness 38.
- Last weekly review: did 75% of planned sessions, average session RPE 7.8, 1 skipped.
Fitness test results:
- 10 m sprint: 1.84 s (previous 1.89 s), best 1.84 s`;

const LIB = new Set(Object.values(EXERCISE_LIBRARY).flat().map((x) => x.toLowerCase()));

async function listModels() {
  const out = { gemini: [], openrouter: [] };
  try { const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + process.env.GEMINI_API_KEY); const j = await r.json(); out.gemini = (j.models || []).map((m) => String(m.name).replace(/^models\//, '')); } catch (_) {}
  try { const r = await fetch('https://openrouter.ai/api/v1/models'); const j = await r.json(); out.openrouter = (j.data || []).map((m) => m.id); } catch (_) {}
  return out;
}
async function ask(c, model, system, user) {
  const gem = c.prov === 'gemini';
  const url = gem ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  const key = gem ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY;
  const body = { model, max_tokens: 12000, temperature: 0.4, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system + '\n\nRespond with a single JSON object and nothing else. No markdown, no commentary. Write compact JSON on one line, with no indentation or line breaks.' }, { role: 'user', content: user }] };
  if (gem && /^gemini/.test(model)) body.reasoning_effort = 'low';
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 150000); const t0 = Date.now();
  try {
    let r = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(gem ? {} : { 'HTTP-Referer': 'https://cadence.app', 'X-Title': 'Cadence model test' }) }, body: JSON.stringify(body) });
    if (r.status === 400) { delete body.response_format; delete body.reasoning_effort; r = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) }); }
    const text = await r.text(); const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ms, error: r.status + ': ' + text.replace(/\s+/g, ' ').slice(0, 300) };
    const j = JSON.parse(text); const content = j.choices?.[0]?.message?.content || '';
    return { ok: true, ms, content, tokensIn: j.usage?.prompt_tokens ?? null, tokensOut: j.usage?.completion_tokens ?? null, finish: j.choices?.[0]?.finish_reason || null };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timed out after 150 s' : String(e.message || e).slice(0, 300) }; }
  finally { clearTimeout(timer); }
}
function grade(raw) {
  let plan; try { plan = extractJson(raw); } catch (e) { return { valid: false, error: 'not valid JSON: ' + String(e.message).slice(0, 120) }; }
  let v; try { v = validatePlan(JSON.parse(JSON.stringify(plan))); } catch (e) { return { valid: false, error: 'wrong shape: ' + e.message }; }
  const days = new Set((plan.sessions || []).map((s) => Number(s.day))).size;
  const real = v.sessions.filter((s) => s.type !== 'rest');
  const ex = real.flatMap((s) => s.exercises);
  const offList = ex.filter((x) => !LIB.has(canonicalExercise(x.name).toLowerCase())).map((x) => x.name);
  const fixed = coachCheck(JSON.parse(JSON.stringify(v)), PROFILE).coachChecks || [];
  const kg = (re) => ex.filter((x) => re.test(x.name)).map((x) => parseFloat(String(x.load).match(/(\d+(?:\.\d+)?)\s*kg/i)?.[1])).filter(Boolean);
  const squat = kg(/^back squat/i), bench = kg(/^bench press/i);
  const loads = { squatKg: squat, benchKg: bench, realistic: squat.every((k) => k >= 70 && k <= 115) && bench.every((k) => k >= 50 && k <= 87.5) };
  const burpees = ex.some((x) => /burpee/i.test(x.name));
  const offDays = real.filter((s) => ![0, 1, 3, 5].includes(s.day)).length;
  const thu = v.sessions.find((s) => s.day === 3);
  return { valid: true, daysWritten: days, sessions: real.length, exercises: ex.length, offList, coachFixes: fixed, loads, burpees, sessionsOnOffDays: offDays, teamDayKept: !!thu && ['skills', 'match'].includes(thu.type),
    phase: plan.phase || null, focus: String(plan.focus || '').slice(0, 300), rationale: String(plan.rationale || '').slice(0, 600),
    week: v.sessions.map((s) => ({ day: s.day, type: s.type, title: s.title, min: s.durationMin, rpe: s.targetRpe, why: s.why, warmup: s.warmup.slice(0, 4), cooldown: s.cooldown.slice(0, 3), ex: s.exercises.map((x) => [x.name, x.sets, x.reps, x.load, x.restSec].join(' | ')) })) };
}
export async function runCompare({ only = null, docId = 'modelCompare', force = false, retries = 0 } = {}) {
  const ref = db().doc('system/' + docId);
  const prev = await ref.get();
  if (!force && prev.exists && prev.data().status === 'done') return { skipped: 'already done', at: prev.data().at };
  await ref.set({ status: 'running', startedAt: new Date().toISOString() });
  const system = planSystem(PROFILE, { fromDay: 0 });
  const user = planUser(PROFILE, '2026-W46', { history: HISTORY, recent: RECENT, ref: new Date('2026-11-09T08:00:00Z') });
  const avail = await listModels();
  const results = await Promise.all(CANDIDATES.filter((c) => !only || only.includes(c.label)).map(async (c) => {
    const ids = avail[c.prov] || [];
    let model = null; for (const re of c.want) { model = ids.find((id) => re.test(id)); if (model) break; }
    if (!model) return { label: c.label, model: null, ok: false, error: 'not offered to this key', sample: ids.filter((i) => c.prov === 'gemini' || /:free$/.test(i)).slice(0, 40) };
    // a busy model (503) gets a few more tries, 20 s apart
    let a = await ask(c, model, system, user); let tries = 1;
    while (!a.ok && /^503/.test(a.error || '') && tries <= retries) { await new Promise((r) => setTimeout(r, 20000)); a = await ask(c, model, system, user); tries++; }
    a.tries = tries;
    if (!a.ok) return { label: c.label, model, ...a };
    return { label: c.label, model, tries: a.tries, ok: true, ms: a.ms, tokensIn: a.tokensIn, tokensOut: a.tokensOut, finish: a.finish, ...grade(a.content), rawStart: a.content.slice(0, 400) };
  }));
  const doc = { status: 'done', at: new Date().toISOString(), promptTokensApprox: Math.round((system.length + user.length) / 4), results };
  await ref.set(JSON.parse(JSON.stringify(doc)));
  return doc;
}
export async function readCompare(m) {
  const d = (await db().doc('system/modelCompare').get()).data();
  if (!d) return { status: 'not run yet' };
  if (m === 'all') return d;
  if (m == null) return { status: d.status, at: d.at, promptTokensApprox: d.promptTokensApprox, summary: (d.results || []).map((r, i) => ({ n: i + 1, label: r.label, model: r.model, ok: r.ok, valid: r.valid ?? null, error: r.error || null, seconds: r.ms ? Math.round(r.ms / 100) / 10 : null, tokensOut: r.tokensOut ?? null, finish: r.finish || null, daysWritten: r.daysWritten ?? null, sessions: r.sessions ?? null, offList: r.offList?.length ?? null, coachFixes: r.coachFixes?.length ?? null, loadsRealistic: r.loads?.realistic ?? null, burpees: r.burpees ?? null, sessionsOnOffDays: r.sessionsOnOffDays ?? null, teamDayKept: r.teamDayKept ?? null })) };
  return (d.results || [])[Number(m) - 1] || { error: 'no such model' };
}
export { grade as _grade };
