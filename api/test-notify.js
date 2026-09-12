// POST /api/test-notify — sends one push to the caller's own subscription, with a specific reason when it can't.
import webpush from 'web-push';
import { requireUser, db } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return res.status(503).json({ error: 'Push is not configured on the server yet (VAPID keys missing in Vercel).' });
  }
  const sub = await db().doc(`users/${user.uid}/push/main`).get();
  if (!sub.exists) return res.status(400).json({ error: 'Reminders are off on this device. Turn the switch on first.' });
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(sub.data().subscription, JSON.stringify({ title: 'Cadence', body: 'Test notification — reminders are working.', url: '/' }));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('test-notify', e.statusCode, e.message);
    if (e.statusCode === 404 || e.statusCode === 410) { await sub.ref.delete(); return res.status(400).json({ error: 'This device\'s subscription expired. Turn reminders off and on again.' }); }
    if (e.statusCode === 403) return res.status(500).json({ error: 'The VAPID keys in Vercel do not match the one in the app. Check VAPID_PUBLIC_KEY.' });
    return res.status(500).json({ error: 'Push failed: ' + (e.message || 'unknown error').slice(0, 120) });
  }
}
