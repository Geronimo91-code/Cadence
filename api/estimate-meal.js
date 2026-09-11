// POST /api/estimate-meal { description } → { kcal, protein, carbs, fat }
import { requireUser, callModel, checkLimit } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  const description = String(req.body?.description || '').slice(0, 300).trim();
  if (!description) return res.status(400).json({ error: 'Describe the meal' });
  if (!(await checkLimit(user.uid, 'estimate', 40))) return res.status(429).json({ error: 'Daily estimate limit reached. Enter the numbers manually for now.' });
  try {
    const out = await callModel({
      system: 'You estimate nutrition for a described meal or snack, using typical portion sizes unless sizes are given. Return ONLY JSON: {"kcal":number,"protein":number,"carbs":number,"fat":number} in kcal and grams, integers.',
      user: description, maxTokens: 200,
    });
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    return res.status(200).json({ kcal: n(out.kcal), protein: n(out.protein), carbs: n(out.carbs), fat: n(out.fat) });
  } catch (e) {
    console.error(e);
    return res.status(503).json({ error: 'Could not estimate right now. Enter the numbers manually.' });
  }
}
