// Shared helpers for Cadence API routes (Vercel serverless, Node 18+)
import admin from 'firebase-admin';

let app;
export function getAdmin() {
  if (!app) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
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
    res.status(401).json({ error: 'Session expired, sign in again' });
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
