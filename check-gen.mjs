// Reads gen-result.json and exits non-zero when the named check fails, so each workflow step is a readable signal.
import fs from 'fs';
const r = JSON.parse(fs.readFileSync('gen-result.json', 'utf8'));
const what = process.argv[2];
const fail = (msg) => { console.error(msg); process.exit(1); };
console.log(JSON.stringify(r));
if (what === 'reached-api') { if (r.status === null) fail('never got a response from /api/generate-plan (stopped at: ' + r.step + ')'); }
if (what === 'not-timeout') { if (r.status === 504 || r.status === 503) fail('model too slow: HTTP ' + r.status + ' ' + r.error); }
if (what === 'detail') { if (r.status !== 200) fail('server said: ' + r.error); }
if (what === 'http-200') { if (r.status === 429) { console.log('skipped: daily quota reached, not a code failure'); process.exit(0); } if (r.status !== 200) fail('HTTP ' + r.status + ' ' + r.error); }
if (what === 'seven-days') { if (r.days !== 7) fail('expected 7 day rows, got ' + r.days); }
if (what === 'has-sessions') { if (!r.trainable) fail('no trainable sessions in the week'); }
if (what === 'session-view') { if (r.sheetOk !== true) fail('session sheet missing exercises or RPE buttons'); }
if (what === 'not-quota') { if (r.status === 429) fail('daily quota reached: ' + r.error); }
if (what === 'not-server-error') { if (r.status === 500) fail('server error: ' + r.error); }
if (what === 'not-bad-request') { if (r.status === 400) fail('bad request: ' + r.error); }
if (what === 'not-auth') { if (r.status === 401 || r.status === 403) fail('auth problem: ' + r.error); }
if (what === 'layout-fits') { if (r.layout?.overflow?.length) fail('elements wider than the screen: ' + r.layout.overflow.join(', ')); }
if (what === 'no-overlap') { if (r.layout?.overlaps) fail(r.layout.overlaps + ' slot(s) have the time label on top of the title'); }
if (what === 'all-days-shown') { if (r.layout && r.layout.daysShown !== 7) fail('only ' + r.layout.daysShown + ' days rendered: ' + JSON.stringify(r.layout.days)); }
if (what === 'no-page-errors') { if (r.pageErrors.length) fail(r.pageErrors.join(' | ')); }
