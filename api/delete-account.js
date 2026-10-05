// POST /api/delete-account — erases everything about the caller, then checks that nothing is left before saying so.
import { requireUser, db, getAdmin } from './_lib.js';

const wipe = (ref) => getAdmin().firestore().recursiveDelete(ref);

// Take the person out of a club. A club left with no members is deleted; one left with no coach hands coaching to its longest-standing member.
async function leaveClub(clubId, uid, report) {
  const clubRef = db().doc(`clubs/${clubId}`);
  if (!(await clubRef.get()).exists) return;
  await db().doc(`clubs/${clubId}/members/${uid}`).delete();
  await db().doc(`clubs/${clubId}/notes/${uid}`).delete();
  const [acts, authored] = await Promise.all([
    db().collection(`clubs/${clubId}/activity`).where('uid', '==', uid).get(),
    db().collection(`clubs/${clubId}/notes`).where('by', '==', uid).get(),
  ]);
  await Promise.all([...acts.docs, ...authored.docs].map((d) => d.ref.delete()));

  const rest = await db().collection(`clubs/${clubId}/members`).get();
  if (rest.empty) { await wipe(clubRef); report.clubsDeleted++; return; }
  const members = rest.docs.map((d) => d.data());
  if (!members.some((m) => m.role === 'coach')) {
    const next = [...members].sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')))[0];
    await db().doc(`clubs/${clubId}/members/${next.uid}`).set({ role: 'coach' }, { merge: true });
    report.coachPromoted++;
  }
}

// Anything still stored for this person, by name
async function leftovers(uid) {
  const found = [];
  const ref = db().doc(`users/${uid}`);
  if ((await ref.get()).exists) found.push('profile');
  for (const col of await ref.listCollections()) {
    if (!(await col.limit(1).get()).empty) found.push(col.id);
  }
  if ((await db().doc(`usage/${uid}`).get()).exists) found.push('usage');
  return found;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res);
  if (!user) return;
  const uid = user.uid;
  const report = { clubsLeft: 0, clubsDeleted: 0, coachPromoted: 0 };

  try {
    const udata = (await db().doc(`users/${uid}`).get()).data() || {};
    const clubIds = Array.isArray(udata.clubIds) ? udata.clubIds : (udata.clubId ? [udata.clubId] : []);
    for (const clubId of clubIds) { await leaveClub(clubId, uid, report); report.clubsLeft++; }

    await wipe(db().doc(`users/${uid}`));
    await db().doc(`usage/${uid}`).delete().catch(() => {});

    let left = await leftovers(uid);
    if (left.length) { await wipe(db().doc(`users/${uid}`)); await db().doc(`usage/${uid}`).delete().catch(() => {}); left = await leftovers(uid); }
    // do not claim success, and do not remove the sign-in, while data is still there: the person can simply try again
    if (left.length) {
      console.error('delete-account: still present', uid, left);
      return res.status(500).json({ error: 'Some data could not be removed. Try again in a minute.', detail: 'still present: ' + left.join(', ') });
    }

    await getAdmin().auth().deleteUser(uid);
    let authUserGone = false;
    try { await getAdmin().auth().getUser(uid); } catch (e) { authUserGone = e.code === 'auth/user-not-found'; }
    return res.status(200).json({ ok: true, ...report, verified: { nothingLeft: true, authUserGone } });
  } catch (e) {
    console.error('delete-account', e);
    return res.status(500).json({ error: 'Could not delete the account. Try again or contact support.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
