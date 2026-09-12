// POST /api/delete-account — erases every document under users/{uid} and the auth account
import { requireUser, db, getAdmin } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const udata = (await db().doc(`users/${user.uid}`).get()).data() || {};
    const clubIds = Array.isArray(udata.clubIds) ? udata.clubIds : (udata.clubId ? [udata.clubId] : []);
    for (const clubId of clubIds) {
      await db().doc(`clubs/${clubId}/members/${user.uid}`).delete().catch(() => {});
      await db().doc(`clubs/${clubId}/notes/${user.uid}`).delete().catch(() => {});
      const acts = await db().collection(`clubs/${clubId}/activity`).where('uid', '==', user.uid).get();
      await Promise.all(acts.docs.map((d) => d.ref.delete()));
    }
    await getAdmin().firestore().recursiveDelete(db().doc(`users/${user.uid}`));
    await getAdmin().auth().deleteUser(user.uid);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not delete the account. Try again or contact support.' });
  }
}
