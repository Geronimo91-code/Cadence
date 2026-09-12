// Reads gen-result.json and exits non-zero when the named check fails, so each workflow step is a readable signal.
import fs from 'fs';
const r = JSON.parse(fs.readFileSync('gen-result.json', 'utf8'));
const what = process.argv[2];
const fail = (msg) => { console.error(msg); process.exit(1); };
console.log(JSON.stringify(r));
if (what === 'reached-api') { if (r.status === null) fail('never got a response from /api/generate-plan (stopped at: ' + r.step + ')'); }
if (what === 'not-timeout') { if (r.status === 504 || r.status === 503) fail('model too slow: HTTP ' + r.status + ' ' + r.error); }
if (what === 'http-200') { if (r.status !== 200) fail('HTTP ' + r.status + ' ' + r.error); }
if (what === 'seven-days') { if (r.days !== 7) fail('expected 7 day rows, got ' + r.days); }
if (what === 'has-sessions') { if (!r.trainable) fail('no trainable sessions in the week'); }
if (what === 'session-view') { if (r.sheetOk !== true) fail('session sheet missing exercises or RPE buttons'); }
if (what === 'no-page-errors') { if (r.pageErrors.length) fail(r.pageErrors.join(' | ')); }
