// Personal Garmin Connect sync (unofficial API, admin-only).
// Login happens once on the owner's own computer with python-garminconnect (it gets past Garmin's bot
// protection); the resulting DI tokens are pasted into the app. From then on this module refreshes the
// token itself and pulls activities and overnight wellness.
// Tokens live in garminAuth/{uid}, which no client can read (no Firestore rule matches it).
import { db, weekId, mondayOf } from './_lib.js';
import GARMIN_EXERCISES from './_garmin-exercises.js';

const API = 'https://connectapi.garmin.com';
const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const HEADERS = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861',
  'X-Garmin-Client-Platform': 'Android',
  'X-App-Ver': '10861',
  'X-Lang': 'en',
  'X-GCExperience': 'GC5',
  'Accept-Language': 'en-US,en;q=0.9',
};
const SYNC_EVERY_MS = 2 * 3600 * 1000;

const authRef = (uid) => db().doc(`garminAuth/${uid}`);

function jwtPayload(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch (_) { return null; }
}
const expiresSoon = (t) => { const p = jwtPayload(t); return !p || !Number.isFinite(Number(p.exp)) ? false : Date.now() / 1000 > Number(p.exp) - 900; };

class GarminError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

async function refresh(tok) {
  if (!tok.di_refresh_token || !tok.di_client_id) throw new GarminError('No refresh token saved. Connect again.', 'auth');
  const r = await fetch(DI_TOKEN_URL, {
    method: 'POST',
    headers: { ...HEADERS, Authorization: 'Basic ' + Buffer.from(tok.di_client_id + ':').toString('base64'), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: tok.di_client_id, refresh_token: tok.di_refresh_token }),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
    throw new GarminError(`Garmin refused to renew the session (${r.status}${/cloudflare|challenge/i.test(body) ? ', blocked by bot protection' : ''}).`, r.status === 400 || r.status === 401 ? 'auth' : 'refresh');
  }
  const d = await r.json();
  tok.di_token = d.access_token;
  tok.di_refresh_token = d.refresh_token || tok.di_refresh_token;
  tok.di_client_id = (jwtPayload(d.access_token) || {}).client_id || tok.di_client_id;
  tok.dirty = true;
}

// GET a connectapi path; renews the token once on expiry or 401
async function call(tok, path, params, { method = 'GET', body } = {}) {
  if (expiresSoon(tok.di_token)) await refresh(tok);
  const url = API + path + (params ? '?' + new URLSearchParams(params) : '');
  const go = () => fetch(url, { method, headers: { ...HEADERS, Authorization: 'Bearer ' + tok.di_token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let r = await go();
  if (r.status === 401) { await refresh(tok); r = await go(); }
  if (r.status === 204) return null;
  if (!r.ok) {
    const detail = method === 'GET' ? '' : ' ' + (await r.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ');
    throw new GarminError(`Garmin answered ${r.status} for ${path.split('/')[1]}.${detail}`, r.status === 401 ? 'auth' : r.status === 429 ? 'rate' : 'api');
  }
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

const ymd = (d) => d.toISOString().slice(0, 10);
const dayIndex = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };
const weekOf = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return weekId(new Date(y, m - 1, d)); };

// Garmin activity type → Cadence session type
export function kindOf(typeKey) {
  const k = String(typeKey || '').toLowerCase();
  if (/ultimate|disc|soccer|football|basketball|volleyball|rugby|hockey|handball|lacrosse|tennis|padel|squash|badminton|team_sport/.test(k)) return 'skills';
  if (/strength|weight|crossfit/.test(k)) return 'strength';
  if (/yoga|pilates|stretch|mobility|breath|meditation|walking|hiking/.test(k)) return 'mobility';
  if (/sprint|track/.test(k)) return 'speed';
  return 'conditioning'; // running, cycling, swimming, hiit, cardio, rowing, other
}
// Perceived effort: the athlete's own rating on the watch if any, else from Garmin's aerobic training effect
function rpeOf(a) {
  const own = Number(a.directWorkoutRpe || a.workoutRpe);
  if (own > 0) return Math.max(1, Math.min(10, Math.round(own > 10 ? own / 10 : own)));
  const te = Number(a.aerobicTrainingEffect);
  if (te > 0) return Math.max(2, Math.min(10, Math.round(1.5 + te * 1.6)));
  return null;
}
const round1 = (v) => (Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v) * 10) / 10 : null);

async function syncActivities(tok, uid, since) {
  const list = await call(tok, '/activitylist-service/activities/search/activities', { startDate: since, endDate: ymd(new Date(Date.now() + 86400000)), start: '0', limit: '50' }) || [];
  let added = 0;
  for (const a of list) {
    if (!a || !a.activityId || !a.startTimeLocal) continue;
    const date = String(a.startTimeLocal).slice(0, 10);
    const wk = weekOf(date), day = dayIndex(date);
    const key = `${wk}-${day}-g${a.activityId}`;
    const ref = db().doc(`users/${uid}/logs/${key}`);
    const snap = await ref.get();
    const garmin = {
      id: String(a.activityId), typeKey: a.activityType?.typeKey || null, start: a.startTimeLocal,
      distanceKm: a.distance ? round1(a.distance / 1000) : null, avgHr: a.averageHR ? Math.round(a.averageHR) : null, maxHr: a.maxHR ? Math.round(a.maxHR) : null,
      aerobicTE: round1(a.aerobicTrainingEffect), anaerobicTE: round1(a.anaerobicTrainingEffect), load: a.activityTrainingLoad ? Math.round(a.activityTrainingLoad) : null, kcal: a.calories ? Math.round(a.calories) : null,
    };
    if (snap.exists) { await ref.set({ garmin }, { merge: true }); continue; } // keep the athlete's own edits
    const now = new Date().toISOString();
    await ref.set({
      weekId: wk, day, slot: 'g' + a.activityId, extra: true, source: 'garmin', garmin,
      title: String(a.activityName || 'Garmin activity').slice(0, 60), type: kindOf(garmin.typeKey), status: 'done',
      durationMin: Math.max(1, Math.round((a.duration || a.movingDuration || 0) / 60)), sessionRpe: rpeOf(a), note: '',
      exercises: null, setsDone: 0, setsTotal: 0, loggedAt: String(a.startTimeGMT || a.startTimeLocal).replace(' ', 'T') + 'Z', updatedAt: now,
    });
    added++;
  }
  return added;
}

async function syncDay(tok, uid, date) {
  const dn = tok.displayName;
  const safe = (p) => p.catch((e) => { if (e.code === 'auth') throw e; return null; });
  const [sleep, sum, hrv, ready] = await Promise.all([
    safe(call(tok, `/wellness-service/wellness/dailySleepData/${encodeURIComponent(dn)}`, { date, nonSleepBufferMinutes: '60' })),
    safe(call(tok, `/usersummary-service/usersummary/daily/${encodeURIComponent(dn)}`, { calendarDate: date })),
    safe(call(tok, `/hrv-service/hrv/${date}`)),
    safe(call(tok, `/metrics-service/metrics/trainingreadiness/${date}`)),
  ]);
  const s = sleep?.dailySleepDTO || {};
  const r = Array.isArray(ready) ? ready[0] : ready;
  const out = {
    date,
    sleepH: s.sleepTimeSeconds ? round1(s.sleepTimeSeconds / 3600) : null,
    sleepScore: s.sleepScores?.overall?.value ?? null,
    restingHr: sum?.restingHeartRate ?? sleep?.restingHeartRate ?? null,
    hrv: hrv?.hrvSummary?.lastNightAvg ?? sleep?.avgOvernightHrv ?? null,
    hrvStatus: hrv?.hrvSummary?.status ?? sleep?.hrvStatus ?? null,
    bodyBattery: sum?.bodyBatteryHighestValue ?? null,
    stress: sum?.averageStressLevel > 0 ? sum.averageStressLevel : null,
    readiness: r?.score ?? null, readinessLevel: r?.level ?? null,
    steps: sum?.totalSteps ?? null,
    syncedAt: new Date().toISOString(),
  };
  if (Object.entries(out).some(([k, v]) => !['date', 'syncedAt'].includes(k) && v !== null)) await db().doc(`users/${uid}/garmin/${date}`).set(out);
  return out;
}

async function saveTok(uid, tok, extra) {
  const { dirty, ...rest } = tok;
  await authRef(uid).set({ ...rest, ...extra }, { merge: true });
}

const publicStatus = (d) => (d ? { connected: true, displayName: d.fullName || d.displayName || null, lastSync: d.lastSync || null, lastError: d.lastError || null, connectedAt: d.connectedAt || null, pushPlan: d.pushPlan !== false } : { connected: false });

export async function garminStatus(uid) { const s = await authRef(uid).get(); return publicStatus(s.exists ? s.data() : null); }

// Save pasted tokens, check them against the API, and pull the last two weeks
export async function garminConnect(uid, pasted) {
  let t;
  try { t = typeof pasted === 'string' ? JSON.parse(pasted.trim()) : pasted; } catch (_) { throw new GarminError('That is not the token text. Paste everything the script printed, from { to }.', 'input'); }
  if (!t || !t.di_token || !t.di_refresh_token || !t.di_client_id) throw new GarminError('The token text is missing di_token, di_refresh_token or di_client_id.', 'input');
  const tok = { di_token: String(t.di_token), di_refresh_token: String(t.di_refresh_token), di_client_id: String(t.di_client_id) };
  const prof = await call(tok, '/userprofile-service/socialProfile');
  if (!prof?.displayName) throw new GarminError('Garmin accepted the token but returned no profile.', 'api');
  tok.displayName = prof.displayName;
  await saveTok(uid, tok, { fullName: prof.fullName || null, connectedAt: new Date().toISOString(), lastSync: null, lastError: null });
  return garminSync(uid, { force: true, days: 14 });
}

export async function garminSync(uid, { force = false, days = 3 } = {}) {
  const snap = await authRef(uid).get();
  if (!snap.exists) return { connected: false };
  const d = snap.data();
  if (!force && d.lastSync && Date.now() - Date.parse(d.lastSync) < SYNC_EVERY_MS) return { ...publicStatus(d), skipped: true };
  const tok = { di_token: d.di_token, di_refresh_token: d.di_refresh_token, di_client_id: d.di_client_id, displayName: d.displayName };
  const result = { activities: 0, days: 0 };
  try {
    const since = ymd(new Date(Date.now() - days * 86400000));
    result.activities = await syncActivities(tok, uid, since);
    for (let i = Math.min(days, 7) - 1; i >= 0; i--) { await syncDay(tok, uid, ymd(new Date(Date.now() - i * 86400000))); result.days++; }
    const lastSync = new Date().toISOString();
    await saveTok(uid, tok, { lastSync, lastError: null });
    return { ...publicStatus({ ...d, lastSync, lastError: null }), ...result };
  } catch (e) {
    const lastError = String(e.message || e).slice(0, 200);
    if (tok.dirty) await saveTok(uid, tok, {}); // a renewed token must not be lost, the old refresh token is now dead
    await authRef(uid).set({ lastError, lastErrorAt: new Date().toISOString() }, { merge: true });
    return { ...publicStatus({ ...d, lastError }), ...result, error: lastError, code: e.code || null };
  }
}

export async function garminDisconnect(uid) {
  await authRef(uid).delete();
  return { connected: false };
}

// Used by the daily cron: everyone who connected
export async function garminSyncAll() {
  const q = await db().collection('garminAuth').get();
  const out = [];
  for (const d of q.docs) {
    const r = { uid: d.id.slice(0, 6), ...(await garminSync(d.id, { force: true, days: 2 })) };
    if (!r.error) { try { r.push = await garminPushPlan(d.id); } catch (e) { r.push = String(e.message || e).slice(0, 120); } }
    out.push(r);
  }
  return out;
}

// Phone flow: the app shows a short pairing code; the login notebook (tools/garmin-login.ipynb, run in
// Google Colab) sends the tokens with that code, so nothing has to be copied between apps.
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function garminPairStart(uid) {
  const { randomInt } = await import('node:crypto');
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
  const old = await db().collection('garminPair').where('uid', '==', uid).get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));
  await db().doc(`garminPair/${code}`).set({ uid, exp: Date.now() + 20 * 60000 });
  return { code: code.slice(0, 4) + '-' + code.slice(4), expiresInMin: 20 };
}
export async function garminPairFinish(rawCode, tokens) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) throw new GarminError('That pairing code looks wrong. It has 8 letters and numbers, like K7Q2-M9XD.', 'input');
  const ref = db().doc(`garminPair/${code}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().exp < Date.now()) throw new GarminError('That pairing code is unknown or expired. Tap Connect in Cadence again for a new one.', 'input');
  const { uid } = snap.data();
  await ref.delete(); // single use
  return garminConnect(uid, tokens);
}

// ---------------- Plan → Garmin workouts on the calendar ----------------
// Each upcoming Cadence session becomes a Garmin workout scheduled on its day, so it reaches the watch.
// garminPush/{uid} remembers what was sent (workout id + a fingerprint), so only changed sessions are re-sent.
const COND = {
  lap: { conditionTypeId: 1, conditionTypeKey: 'lap.button', displayOrder: 1, displayable: true },
  time: { conditionTypeId: 2, conditionTypeKey: 'time', displayOrder: 2, displayable: true },
  reps: { conditionTypeId: 10, conditionTypeKey: 'reps', displayOrder: 10, displayable: true },
  iter: { conditionTypeId: 7, conditionTypeKey: 'iterations', displayOrder: 7, displayable: false },
};
const STEP = { warmup: [1, 'warmup'], cooldown: [2, 'cooldown'], interval: [3, 'interval'], rest: [5, 'rest'], repeat: [6, 'repeat'] };
const NO_TARGET = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 };
const SPORTS = { strength: { sportTypeId: 5, sportTypeKey: 'strength_training', displayOrder: 5 }, running: { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 }, cardio: { sportTypeId: 6, sportTypeKey: 'cardio_training', displayOrder: 6 } };
const stepType = (k) => ({ stepTypeId: STEP[k][0], stepTypeKey: STEP[k][1], displayOrder: STEP[k][0] });
const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

// "8" / "6-8" → reps; "45 s" / "2-4 min" → seconds; anything else (metres, "max") → press lap when done
function endOf(reps) {
  const r = String(reps || '').toLowerCase();
  const nums = (r.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const top = nums.length ? Math.max(...nums.slice(0, 2)) : null;
  if (top && /\b(s|sec|secs|seconds?)\b/.test(r)) return { cond: COND.time, value: top };
  if (top && /\bmin/.test(r)) return { cond: COND.time, value: top * 60 };
  if (top && !/\d\s*(m|km|yd)\b/.test(r) && !/[a-z]{3,}/.test(r.replace(/reps?|each|side|leg|arm/g, ''))) return { cond: COND.reps, value: nums[0] };
  return { cond: COND.lap, value: null };
}
const kgOf = (load) => { const m = String(load || '').match(/(\d+(?:[.,]\d+)?)\s*kg/i); return m ? Number(m[1].replace(',', '.')) : null; };

export function sessionToWorkout(sess, dateLabel) {
  const exs = sess.exercises || [];
  const runny = /sprint|run|tempo|stride|shuttle|interval|bound|skip|acceleration/i;
  const sport = sess.type === 'strength' ? 'strength' : (['speed', 'conditioning'].includes(sess.type) && exs.some((e) => runny.test(e.name))) ? 'running' : 'cardio';
  const withExercises = sport !== 'running';
  let order = 0;
  const step = (kind, end, desc, extra = {}) => ({ type: 'ExecutableStepDTO', stepOrder: ++order, stepType: stepType(kind), endCondition: end.cond, ...(end.value != null ? { endConditionValue: end.value } : {}), targetType: NO_TARGET, ...(desc ? { description: clip(desc, 250) } : {}), ...extra });
  const steps = [];
  if ((sess.warmup || []).length) steps.push(step('warmup', { cond: COND.lap }, 'Warm-up: ' + sess.warmup.join(' · ')));
  const plan = [];
  for (const e of exs) {
    const end = endOf(e.reps);
    const sets = Math.max(1, Math.min(20, Number(e.sets) || 1));
    const kg = kgOf(e.load);
    const map = GARMIN_EXERCISES[String(e.name || '').toLowerCase()];
    const ex = withExercises && map ? { category: map[0], exerciseName: map[1] } : {};
    const desc = [e.name, e.reps && `${e.reps}`, e.load && !kg ? e.load : '', e.cues].filter(Boolean).join(' · ');
    const extra = { ...ex, ...(kg && withExercises ? { weightValue: kg * 1000, weightUnit: { unitId: 8, unitKey: 'kilogram', factor: 1000.0 } } : {}) };
    // Every set is its own step, no repeat blocks: older watches (Instinct 2, Fenix 6…) reject repeat options
    plan.push({ end, desc, extra, sets, rest: Number(e.restSec) || 0 });
  }
  // Garmin caps a workout at 50 steps: if needed, drop the rest timers between sets (rest goes into the note), last exercises first
  const count = () => plan.reduce((a, x) => a + (x.merged ? 1 : x.sets + (x.rest ? x.sets - 1 : 0)), 0) + (sess.warmup?.length ? 1 : 0) + (sess.cooldown?.length ? 1 : 0);
  for (let i = plan.length - 1; i >= 0 && count() > 50; i--) { if (plan[i].rest) { plan[i].desc += ` · rest ${plan[i].rest} s`; plan[i].rest = 0; } }
  for (let i = plan.length - 1; i >= 0 && count() > 50; i--) { if (plan[i].sets > 1) { plan[i].merged = true; plan[i].desc = `${plan[i].sets} sets: ${plan[i].desc}`; plan[i].end = { cond: COND.lap, value: null }; } }
  for (const x of plan) {
    if (x.merged) { steps.push(step('interval', x.end, x.desc, x.extra)); continue; }
    for (let k = 1; k <= x.sets; k++) {
      steps.push(step('interval', x.end, x.sets > 1 ? `${x.desc} (set ${k}/${x.sets})` : x.desc, x.extra));
      if (x.rest && k < x.sets) steps.push(step('rest', { cond: COND.time, value: x.rest }, null));
    }
  }
  if ((sess.cooldown || []).length) steps.push(step('cooldown', { cond: COND.lap }, 'Cool-down: ' + sess.cooldown.join(' · ')));
  return {
    workoutName: clip(`Cadence ${dateLabel} · ${sess.title}`, 80),
    description: clip(sess.intent || '', 500),
    sportType: SPORTS[sport],
    estimatedDurationInSecs: (Number(sess.durationMin) || 45) * 60,
    workoutSegments: [{ segmentOrder: 1, sportType: SPORTS[sport], workoutSteps: steps }],
  };
}

const pushRef = (uid) => db().doc(`garminPush/${uid}`);
const fingerprint = (o) => { let h = 0; const s = JSON.stringify(o); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function garminPushPlan(uid, { force = false } = {}) {
  const snap = await authRef(uid).get();
  if (!snap.exists) return { connected: false };
  const d = snap.data();
  if (d.pushPlan === false) return { pushed: 0, off: true };
  const tok = { di_token: d.di_token, di_refresh_token: d.di_refresh_token, di_client_id: d.di_client_id, displayName: d.displayName };
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });
  const weeks = [weekId(new Date(today + 'T12:00:00')), weekId(new Date(Date.parse(today + 'T12:00:00') + 7 * 86400000))];
  const wanted = {};
  for (const wk of weeks) {
    const p = await db().doc(`users/${uid}/plans/${wk}`).get();
    if (!p.exists) continue;
    const mon = mondayOf(wk);
    for (const s of p.data().sessions || []) {
      if (['rest', 'match'].includes(s.type) || !(s.exercises || []).length) continue;
      const dt = new Date(mon); dt.setUTCDate(mon.getUTCDate() + s.day);
      const date = dt.toISOString().slice(0, 10);
      if (date < today) continue;
      const key = `${wk}-${s.day}-${s.slot || 0}`;
      const logged = await db().doc(`users/${uid}/logs/${wk}-${s.day}${s.slot ? '-' + s.slot : ''}`).get();
      if (logged.exists) continue;
      const workout = sessionToWorkout(s, `${DAY_SHORT[s.day]} ${date.slice(8)}/${date.slice(5, 7)}`);
      wanted[key] = { date, workout, fp: fingerprint({ date, workout }) };
    }
  }
  const prev = (await pushRef(uid).get()).data()?.sessions || {};
  const next = {}; const out = { pushed: 0, kept: 0, removed: 0, errors: [] };
  try {
    // drop workouts whose session changed or left the plan (only future ones; past ones stay as history)
    for (const [key, old] of Object.entries(prev)) {
      if (!force && wanted[key] && wanted[key].fp === old.fp) { next[key] = old; out.kept++; continue; }
      if (!wanted[key] && old.date <= today) { if (old.date === today) next[key] = old; continue; } // done or past: leave it on the watch
      { await call(tok, `/workout-service/workout/${old.workoutId}`, null, { method: 'DELETE' }).catch((e) => { if (e.code === 'auth') throw e; }); out.removed++; }
    }
    if (force) {
      // also remove Cadence workouts this record lost track of (older versions that were never replaced)
      const known = new Set(Object.values(next).map((x) => String(x.workoutId)));
      const list = await call(tok, '/workout-service/workouts', { start: '0', limit: '200' }).catch((e) => { if (e.code === 'auth') throw e; return []; }) || [];
      for (const w of Array.isArray(list) ? list : []) {
        if (!/^Cadence /.test(w.workoutName || '') || known.has(String(w.workoutId))) continue;
        const dm = String(w.workoutName).match(/ (\d{2})\/(\d{2}) /); // "Cadence Mon 19/10 · …"
        if (dm && `${today.slice(0, 4)}-${dm[2]}-${dm[1]}` < today) continue; // past ones stay as history
        await call(tok, `/workout-service/workout/${w.workoutId}`, null, { method: 'DELETE' }).catch((e) => { if (e.code === 'auth') throw e; });
        out.removed++;
      }
    }
    for (const [key, w] of Object.entries(wanted)) {
      if (next[key]) continue;
      try {
        const made = await call(tok, '/workout-service/workout', null, { method: 'POST', body: w.workout });
        if (!made?.workoutId) throw new GarminError('Garmin did not return a workout id.', 'api');
        const sch = await call(tok, `/workout-service/schedule/${made.workoutId}`, null, { method: 'POST', body: { date: w.date } });
        next[key] = { workoutId: made.workoutId, scheduleId: sch?.workoutScheduleId || null, date: w.date, fp: w.fp, title: w.workout.workoutName };
        out.pushed++;
      } catch (e) { if (e.code === 'auth') throw e; out.errors.push(`${w.workout.workoutName}: ${e.message}`.slice(0, 200)); }
    }
  } finally {
    await pushRef(uid).set({ sessions: next, at: new Date().toISOString(), lastErrors: out.errors.slice(0, 5) });
    if (tok.dirty) await saveTok(uid, tok, {});
  }
  return out;
}

export async function garminSetPush(uid, on) { await authRef(uid).set({ pushPlan: !!on }, { merge: true }); return { pushPlan: !!on }; }
