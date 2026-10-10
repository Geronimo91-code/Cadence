const skip = [];
if (!process.env.RUN_GENERATE) skip.push('**/generate.spec.js');
if (!process.env.RUN_DAYPREFS) skip.push('**/dayprefs.spec.js');
if (!process.env.RUN_PHOTO) skip.push('**/photo.spec.js');
if (!process.env.RUN_REVIEW) skip.push('**/review.spec.js');
if (!process.env.RUN_CHECKLIST) skip.push('**/checklist.spec.js');
if (!process.env.RUN_DELETION) skip.push('**/deletion.spec.js');
export default { testDir: './tests', testIgnore: skip, timeout: 180000, retries: 1, use: { headless: true, viewport: { width: 390, height: 844 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' } };
