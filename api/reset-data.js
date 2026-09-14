// POST /api/reset-data { scope: 'training' | 'nutrition' | 'all' }
// Clears history while keeping the account and profile. Irreversible.
import { requireUser, db, getAdmin } from './_lib.js';

const GROUPS = {
  training: ['plans', 'logs', 'reviews'],
  nutrition: ['nutrition', 'weights'],
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = ['training', 'nutrition', 'all'].includes(req.body?.scope) ? req.body.scope : null;
  if (!scope) return res.status(400).json({ error: 'Say what to reset' });

  const uid = user.uid;
  const collections = scope === 'all' ? [...GROUPS.training, ...GROUPS.nutrition] : GROUPS[scope];
  const deleted = {};
  try {
    for (const name of collections) {
      const ref = db().collection(`users/${uid}/${name}`);
      const snap = await ref.get();
      deleted[name] = snap.size;
      await getAdmin().firestore().recursiveDelete(ref);
    }
    // the athlete disappears from club feeds along with their training history
    if (scope !== 'nutrition') {
      const udata = (await db().doc(`users/${uid}`).get()).data() || {};
      const clubIds = Array.isArray(udata.clubIds) ? udata.clubIds : (udata.clubId ? [udata.clubId] : []);
      for (const clubId of clubIds) {
        const acts = await db().collection(`clubs/${clubId}/activity`).where('uid', '==', uid).get();
        await Promise.all(acts.docs.map((d) => d.ref.delete()));
        deleted.activity = (deleted.activity || 0) + acts.size;
      }
    }
    return res.status(200).json({ ok: true, deleted });
  } catch (e) {
    console.error('reset-data', e);
    return res.status(500).json({ error: 'Could not reset your data. Try again.' });
  }
}
