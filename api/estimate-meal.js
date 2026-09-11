// POST /api/estimate-meal { description?, image? (data URL, jpeg ≤ ~1 MB) } → { name, kcal, protein, carbs, fat }
import { requireUser, callModel, checkLimit } from './_lib.js';

export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  const description = String(req.body?.description || '').slice(0, 300).trim();
  const image = typeof req.body?.image === 'string' && req.body.image.startsWith('data:image/') && req.body.image.length < 2_000_000 ? req.body.image : null;
  if (!description && !image) return res.status(400).json({ error: 'Describe the meal or add a photo' });
  if (!(await checkLimit(user.uid, 'estimate', 40))) return res.status(429).json({ error: 'Daily estimate limit reached. Enter the numbers manually for now.' });
  try {
    const out = await callModel({
      system: 'You estimate nutrition for a meal or snack from a description and/or a photo, using typical portion sizes unless sizes are visible or given. Return ONLY JSON: {"name":"short meal name","kcal":number,"protein":number,"carbs":number,"fat":number} in kcal and grams, integers.',
      user: description || 'Estimate this meal from the photo.', image, maxTokens: 300,
    });
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    return res.status(200).json({ name: String(out.name || description || 'Meal').slice(0, 80), kcal: n(out.kcal), protein: n(out.protein), carbs: n(out.carbs), fat: n(out.fat) });
  } catch (e) {
    console.error(e);
    return res.status(503).json({ error: 'Could not estimate right now. Enter the numbers manually.' });
  }
}
