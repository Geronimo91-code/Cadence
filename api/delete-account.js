// POST /api/delete-account — erases every document under users/{uid} and the auth account
import { requireUser, db, getAdmin } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    await getAdmin().firestore().recursiveDelete(db().doc(`users/${user.uid}`));
    await getAdmin().auth().deleteUser(user.uid);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not delete the account. Try again or contact support.' });
  }
}
