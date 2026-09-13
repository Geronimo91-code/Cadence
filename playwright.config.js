const extra = [];
if (!process.env.RUN_GENERATE) extra.push('**/generate.spec.js');
if (!process.env.RUN_DAYPREFS) extra.push('**/dayprefs.spec.js');
if (!process.env.RUN_MEAL) extra.push('**/meal.spec.js');
export default { testDir: './tests', testIgnore: extra, timeout: 180000, retries: 1, use: { headless: true, viewport: { width: 390, height: 844 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' } };
