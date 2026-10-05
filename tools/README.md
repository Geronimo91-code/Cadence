# Exercise photos and instructions

`exercise-media.json` and the `exercises/` folder come from the **Free Exercise DB**
(https://github.com/yuhonas/free-exercise-db, public domain / Unlicense).

- `tools/exercise-map.json` maps our exercise names (see `EXERCISE_LIBRARY` in `api/_lib.js`) to Free Exercise DB ids.
  Only movements that genuinely match are mapped; sprints, agility drills and a few mobility drills have no entry and fall back to a video search.
- Photos were resized to 480 px and converted to WebP (about 12 KB each) so they are served from our own domain with no third-party requests.
- `node check-media.mjs` verifies every entry has its files and its name exists in the exercise library; CI runs it on every push.
