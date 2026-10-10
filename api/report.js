// Tester feedback, client-side errors, and the admin inbox that reads both.
// POST { type: 'feedback', text, ... }   → saved to feedback/{id}
// POST { type: 'error', message, ... }   → saved to problems/{id}
// POST { action: 'whoami' }              → { admin }
// POST { action: 'inbox' }               → latest feedback + problems (admins only)
// POST { action: 'stats' }               → usage overview and per-user table (admins only)
import { requireUser, db, checkLimit, getAdmin, weekId } from './_lib.js';

const ADMINS = (process.env.ADMIN_EMAILS || 'melihgeron@gmail.com').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  const body = req.body || {};
  const isAdmin = !!user.email && ADMINS.includes(user.email.toLowerCase());

  if (body.action === 'whoami') return res.status(200).json({ admin: isAdmin });

  if (body.action === 'inbox') {
    if (!isAdmin) return res.status(403).json({ error: 'Not allowed' });
    const [fb, pr] = await Promise.all([
      db().collection('feedback').orderBy('createdAt', 'desc').limit(60).get(),
      db().collection('problems').orderBy('createdAt', 'desc').limit(60).get(),
    ]);
    return res.status(200).json({
      feedback: fb.docs.map((d) => ({ id: d.id, ...d.data() })),
      problems: pr.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
  }

  if (body.action === 'stats') {
    if (!isAdmin) return res.status(403).json({ error: 'Not allowed' });
    return res.status(200).json(await buildStats());
  }

  const isFeedback = body.type === 'feedback';
  if (isFeedback && !clip(body.text, 4000).trim()) return res.status(400).json({ error: 'Write a few words first.' });
  const allowed = await checkLimit(user.uid, isFeedback ? 'feedback' : 'clientError', isFeedback ? 20 : 30, isFeedback ? 60 : 150);
  if (!allowed) return res.status(429).json({ error: 'Too many reports today. Try again tomorrow.' });

  const common = {
    uid: user.uid, email: user.email || null, view: clip(body.view, 40), lang: clip(body.lang, 5),
    ua: clip(req.headers['user-agent'], 300), appVersion: clip(body.appVersion, 40), createdAt: new Date().toISOString(),
  };
  if (isFeedback) {
    await db().collection('feedback').add({ ...common, text: clip(body.text, 4000) });
  } else {
    await db().collection('problems').add({ ...common, source: 'app', message: clip(body.message, 500), stack: clip(body.stack, 1500), path: clip(body.path, 120) });
  }
  return res.status(200).json({ ok: true });
}

// ---------------- Admin overview ----------------
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}
const count = async (q) => { try { return (await q.count().get()).data().count; } catch (_) { return 0; } };

async function buildStats() {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
  const d7 = iso(7), d30 = iso(30), today = new Date().toISOString().slice(0, 10), thisWeek = weekId(new Date());

  const authUsers = [];
  let pageToken;
  do { const r = await getAdmin().auth().listUsers(1000, pageToken); authUsers.push(...r.users); pageToken = r.pageToken; } while (pageToken);

  const users = await inBatches(authUsers.slice(0, 400), 10, async (u) => {
    const base = db().doc(`users/${u.uid}`);
    const [doc, usage, push, logs7, logs30, logsAll, lastLog, plans, reviews, meals7] = await Promise.all([
      base.get(), db().doc(`usage/${u.uid}`).get(), base.collection('push').doc('main').get().catch(() => null),
      count(base.collection('logs').where('loggedAt', '>=', d7)), count(base.collection('logs').where('loggedAt', '>=', d30)), count(base.collection('logs')),
      base.collection('logs').orderBy('loggedAt', 'desc').limit(1).get().catch(() => null),
      count(base.collection('plans')), count(base.collection('reviews')), count(base.collection('nutrition').where('updatedAt', '>=', d7)),
    ]);
    const d = doc.exists ? doc.data() : {};
    const p = d.profile || null;
    const us = usage.exists ? usage.data() : {};
    const sameDay = us.day === today, sameWeek = us.week === thisWeek;
    const ai = (k) => ({ day: sameDay ? (us[k] || 0) : 0, week: sameWeek ? (us[k + 'Week'] || 0) : 0 });
    const plan = ai('plan'), review = ai('review'), estimate = ai('estimate');
    return {
      uid: u.uid, email: u.email || null, name: p?.name || u.displayName || null,
      provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
      createdAt: new Date(u.metadata.creationTime).toISOString(),
      lastSignIn: u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).toISOString() : null,
      onboarded: !!p, lang: p?.lang || null, sport: p?.sports?.[0] || null, level: p?.level || null,
      nutrition: !!p?.nutrition, clubs: (d.clubIds || []).length, push: !!(push && push.exists),
      logs7, logs30, logsAll, lastLog: lastLog && !lastLog.empty ? lastLog.docs[0].data().loggedAt : null,
      plans, reviews, meals7,
      aiToday: plan.day + review.day + estimate.day, aiWeek: plan.week + review.week + estimate.week,
      aiBreakdownWeek: { plan: plan.week, review: review.week, meal: estimate.week },
    };
  });

  const [recentProblems, feedbackAll, feedback7, clubs] = await Promise.all([
    db().collection('problems').where('createdAt', '>=', d7).limit(1000).get(),
    count(db().collection('feedback')), count(db().collection('feedback').where('createdAt', '>=', d7)),
    count(db().collection('clubs')),
  ]);

  const tally = (key) => users.reduce((m, u) => { if (u[key]) m[u[key]] = (m[u[key]] || 0) + 1; return m; }, {});
  const signups = {};
  for (let i = 13; i >= 0; i--) signups[iso(i).slice(0, 10)] = 0;
  users.forEach((u) => { const k = u.createdAt.slice(0, 10); if (k in signups) signups[k]++; });
  const sum = (k) => users.reduce((s, u) => s + (u[k] || 0), 0);

  users.sort((a, b) => String(b.lastLog || b.lastSignIn || '').localeCompare(String(a.lastLog || a.lastSignIn || '')));
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      accounts: authUsers.length, onboarded: users.filter((u) => u.onboarded).length,
      active7: users.filter((u) => u.logs7 > 0).length, active30: users.filter((u) => u.logs30 > 0).length,
      signedIn7: users.filter((u) => u.lastSignIn && u.lastSignIn >= d7).length,
      sessions7: sum('logs7'), sessions30: sum('logs30'), sessionsAll: sum('logsAll'),
      plans: sum('plans'), reviews: sum('reviews'), mealDays7: sum('meals7'),
      aiToday: sum('aiToday'), aiWeek: sum('aiWeek'),
      problems7: recentProblems.size, fallbacks7: recentProblems.docs.filter((x) => x.data().fallback).length, feedbackAll, feedback7, clubs,
    },
    languages: tally('lang'), sports: tally('sport'), signups, users,
  };
}
