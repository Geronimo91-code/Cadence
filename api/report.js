// Tester feedback, client-side errors, and the admin inbox that reads both.
// POST { type: 'feedback', text, ... }   → saved to feedback/{id}
// POST { type: 'error', message, ... }   → saved to problems/{id}
// POST { action: 'whoami' }              → { admin }
// POST { action: 'inbox' }               → latest feedback + problems (admins only)
import { requireUser, db, checkLimit } from './_lib.js';

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
