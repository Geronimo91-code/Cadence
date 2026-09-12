// Publishes gen-result.json to the test-results branch so failures are readable without log access.
import fs from 'fs';
const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY, branch = 'test-results';
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(init.headers || {}) } });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
};
const main = async () => {
  const head = await api('/git/ref/heads/main');
  const exists = await api(`/git/ref/heads/${branch}`);
  if (!exists.ok) await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.body.object.sha }) });
  const path = process.env.RESULT_FILE || 'gen-result.json';
  const cur = await api(`/contents/${path}?ref=${branch}`);
  const content = Buffer.from(fs.readFileSync(path)).toString('base64');
  const res = await api(`/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message: `test result ${new Date().toISOString()}`, content, branch, ...(cur.ok ? { sha: cur.body.sha } : {}) }) });
  console.log('published', res.status);
};
main();
