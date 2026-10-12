// Keeps Firestore in step with the repo: publishes firestore.rules when they differ from the live rules,
// and registers every club's invite code in clubCodes. Runs once per server instance; safe to call often.
import fs from 'node:fs';
import { getAdmin, db } from './_lib.js';

let last = null;
export async function syncRules() {
  if (last && !last.error) return last;
  const status = { at: new Date().toISOString(), rules: 'skipped', codesAdded: 0, error: null };
  try {
    const admin = getAdmin();
    const source = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
    const rules = admin.securityRules();
    let current = '';
    try { const rs = await rules.getFirestoreRuleset(); current = (rs.source || []).map((f) => f.content).join('\n'); } catch (e) { status.readError = String(e.message || e).slice(0, 160); }
    if (current.trim() === source.trim()) status.rules = 'unchanged';
    else { await rules.releaseFirestoreRulesetFromSource(source); status.rules = 'published'; }
  } catch (e) { status.error = 'rules: ' + String((e && e.message) || e).slice(0, 200); }
  try {
    const clubs = await db().collection('clubs').get();
    for (const c of clubs.docs) {
      const code = c.data().inviteCode;
      if (!code || !/^[A-Za-z0-9_-]{3,40}$/.test(code)) continue;
      const ref = db().doc('clubCodes/' + code);
      if (!(await ref.get()).exists) { await ref.set({ clubId: c.id, createdBy: c.data().createdBy || 'server' }); status.codesAdded++; }
    }
  } catch (e) { status.error = (status.error ? status.error + '; ' : '') + 'codes: ' + String((e && e.message) || e).slice(0, 200); }
  last = status;
  return status;
}
