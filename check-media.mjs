// Verifies the exercise media: every entry has its photos on disk, every name exists in our exercise library,
// and nothing on disk is orphaned. Run by CI on every push.
import fs from 'fs';

const media = JSON.parse(fs.readFileSync('exercise-media.json', 'utf8'));
const lib = fs.readFileSync('api/_lib.js', 'utf8');
const literal = lib.slice(lib.indexOf('export const EXERCISE_LIBRARY'), lib.indexOf('export const EXERCISE_NAMES')).replace('export const EXERCISE_LIBRARY =', 'return ').replace(/;\s*$/, '');
const names = new Set(Object.values(new Function(literal)()).flat());

const problems = [];
const ids = new Set();
for (const [name, v] of Object.entries(media)) {
  if (!names.has(name)) problems.push(`"${name}" is not in EXERCISE_LIBRARY`);
  if (!v.id || !Array.isArray(v.steps)) problems.push(`"${name}" is missing id or steps`);
  ids.add(v.id);
  for (let i = 0; i < v.images; i++) if (!fs.existsSync(`exercises/${v.id}/${i}.webp`)) problems.push(`missing exercises/${v.id}/${i}.webp`);
}
for (const dir of fs.readdirSync('exercises')) if (!ids.has(dir)) problems.push(`orphan folder exercises/${dir}`);

const bytes = fs.readdirSync('exercises').flatMap((d) => fs.readdirSync(`exercises/${d}`).map((f) => fs.statSync(`exercises/${d}/${f}`).size)).reduce((a, b) => a + b, 0);
console.log(`${Object.keys(media).length} movements, ${(bytes / 1048576).toFixed(2)} MB of photos, ${names.size} names in the library`);
if (problems.length) { console.error('MEDIA PROBLEMS:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log('media ok');
