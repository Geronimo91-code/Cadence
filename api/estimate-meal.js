// POST /api/estimate-meal { description?, image? (data URL, jpeg ≤ ~1 MB) } → { name, kcal, protein, carbs, fat }
import { requireUser, callModel, checkLimit, db, LANG_NAMES } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  const description = String(req.body?.description || '').slice(0, 300).trim();
  const raw = typeof req.body?.image === 'string' ? req.body.image : '';
  if (raw && !raw.startsWith('data:image/')) return res.status(400).json({ error: 'That image format is not supported.' });
  if (raw.length >= 3_500_000) return res.status(413).json({ error: 'That photo is too large. Try again — Cadence shrinks it first.' });
  const image = raw || null;
  if (!description && !image) return res.status(400).json({ error: 'Describe the meal or add a photo' });
  if (!(await checkLimit(user.uid, 'estimate', 40))) return res.status(429).json({ error: 'Daily estimate limit reached. Enter the numbers manually for now.' });
  let lang = 'English';
  try { lang = LANG_NAMES[(await db().doc(`users/${user.uid}`).get()).data()?.profile?.lang] || 'English'; } catch (_) {}
  try {
    const out = await callModel({
      system: `You estimate nutrition for a meal or snack from a description and/or a photo, using typical portion sizes unless sizes are visible or given. Write the name in ${lang}. Return ONLY JSON: {"name":"short meal name","kcal":number,"protein":number,"carbs":number,"fat":number} in kcal and grams, integers.`,
      user: description || 'Estimate this meal from the photo.', image, maxTokens: 1200, timeoutMs: 35000,
    });
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    return res.status(200).json({ name: String(out.name || description || 'Meal').slice(0, 80), kcal: n(out.kcal), protein: n(out.protein), carbs: n(out.carbs), fat: n(out.fat) });
  } catch (e) {
    console.error(e);
    const msg = String(e && e.message || e);
    const busy = /429|quota|rate|timed out|unavailable/i.test(msg);
    return res.status(busy ? 429 : 503).json({ error: busy ? 'The model is busy right now. Try again in a minute, or enter the numbers manually.' : 'Could not estimate right now. Enter the numbers manually.', detail: msg.slice(0, 300) });
  }
}
