// Runs on every Vercel deploy (buildCommand). Publishes firestore.rules when they changed,
// and registers every club's invite code in clubCodes so joining by code works without the coach opening the app.
// Never fails the build: the result goes to /rules-status.json (counts only, no data).
import fs from 'node:fs';
import { getAdmin, db } from '../api/_lib.js';

const status = { at: new Date().toISOString(), rules: 'skipped', codesAdded: 0, error: null };
try {
  const admin = getAdmin();
  const source = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const rules = admin.securityRules();
  let current = '';
  try { const rs = await rules.getFirestoreRuleset(); current = (rs.source || []).map((f) => f.content).join('\n'); } catch (_) {}
  if (current.trim() === source.trim()) status.rules = 'unchanged';
  else { await rules.releaseFirestoreRulesetFromSource(source); status.rules = 'published'; }

  const clubs = await db().collection('clubs').get();
  for (const c of clubs.docs) {
    const code = c.data().inviteCode;
    if (!code || !/^[A-Za-z0-9_-]{3,40}$/.test(code)) continue;
    const ref = db().doc('clubCodes/' + code);
    if (!(await ref.get()).exists) { await ref.set({ clubId: c.id, createdBy: c.data().createdBy || 'deploy' }); status.codesAdded++; }
  }
} catch (e) {
  status.error = String((e && e.message) || e).slice(0, 200);
}
console.log('publish-rules', JSON.stringify(status));
fs.writeFileSync(new URL('../rules-status.json', import.meta.url), JSON.stringify(status));
process.exit(0);
