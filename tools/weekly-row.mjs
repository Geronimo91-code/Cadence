// Turns one full live test run into a row for the "Weekly health" history.
// Usage: node tools/weekly-row.mjs <workflow run id>   (needs the gh CLI, signed in)
// Prints one JSON object: { date, checks, passed, passRate, failed, aiPlan, firstPlanS, rebuildS, smoke, deletion, note }
import { execFileSync } from 'node:child_process';

const REPO = 'Geronimo91-code/Cadence';
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 20e6 }));
const file = (name) => { try { return JSON.parse(Buffer.from(gh(`repos/${REPO}/contents/${name}?ref=test-results`).content, 'base64').toString()); } catch (_) { return null; } };

const runId = process.argv[2];
if (!runId) { console.error('usage: node tools/weekly-row.mjs <run id>'); process.exit(1); }
const run = gh(`repos/${REPO}/actions/runs/${runId}`);
const jobs = gh(`repos/${REPO}/actions/runs/${runId}/jobs`).jobs || [];
const steps = jobs.flatMap((j) => j.steps || []).filter((s) => s.conclusion && s.conclusion !== 'skipped');
const started = Date.parse(run.run_started_at || run.created_at);

const checks = [];
// every "Test:" step of the smoke suite is one check
for (const s of steps.filter((x) => /^Test: /.test(x.name))) checks.push({ name: s.name.replace(/^Test: /, ''), pass: s.conclusion === 'success' });
// the full journey and the checklist, if they ran in this run
const cl = file('checklist-result.json');
const fresh = (iso) => iso && Date.parse(iso) >= started - 60000;
let firstPlanS = null, rebuildS = null, aiPlan = null;
if (cl) {
  const j = cl.journey || {};
  if (fresh(j.started)) {
    for (const [k, v] of Object.entries(j.checks || {})) checks.push({ name: k, pass: !!v.pass, ai: /AI-made/.test(k) });
    firstPlanS = j.timings?.['first plan'] ? Math.round(j.timings['first plan'] / 100) / 10 : null;
    rebuildS = j.timings?.rebuild ? Math.round(j.timings.rebuild / 100) / 10 : null;
    aiPlan = j.firstPlan?.source && j.firstPlan.source !== 'template' ? 'yes' : 'no';
  }
  for (const [k, v] of Object.entries(cl.checks || {})) checks.push({ name: k, pass: !!v.pass });
}
const del = steps.find((s) => s.name === 'Deletion: run');
if (del) checks.push({ name: 'account deletion', pass: del.conclusion === 'success' });

// the free AI being busy is the known free-tier limit: tracked in the "AI plan" column, not counted as a failure
const counted = checks.filter((c) => !c.ai);
const passed = counted.filter((c) => c.pass).length;
const failed = counted.filter((c) => !c.pass).map((c) => c.name);
console.log(JSON.stringify({
  date: new Date(started).toISOString().slice(0, 10),
  checks: counted.length, passed, passRate: counted.length ? Math.round((passed / counted.length) * 100) : 0,
  failed: failed.join(', '), aiPlan: aiPlan || 'n/a', firstPlanS, rebuildS,
  smoke: steps.filter((x) => /^Test: /.test(x.name)).every((x) => x.conclusion === 'success') ? 'pass' : 'fail',
  deletion: del ? (del.conclusion === 'success' ? 'pass' : 'fail') : 'n/a',
  runId: String(runId), note: run.conclusion === 'cancelled' ? 'run hit its time limit' : '',
}));
