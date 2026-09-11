# Cadence

Weekly training plans built from your profile, logged in the app, rebuilt every week. Single-file PWA on Vercel, Firebase Auth + Firestore, OpenRouter for plan generation.

## Files
- `index.html` — the whole app (auth, onboarding, views)
- `sw.js`, `manifest.json`, `icon.svg` — PWA
- `api/_lib.js` — Firebase Admin, token check, OpenRouter call
- `api/generate-plan.js` — POST, builds a weekly plan from the profile
- `api/weekly-review.js` — POST, closes a week: review + next week's plan from the logs
- `api/weekly-close.js` — Monday cron, auto-closes last week for users who logged sessions
- `api/estimate-meal.js` — POST, macro estimate from a meal description
- `api/calendar.js` — GET, per-user iCal feed (token in the URL)
- `api/delete-account.js` — POST, erases the user's data and auth account
- `api/daily-notify.js` — daily cron, sends today's session by Web Push
- `firestore.rules` — each user can only read/write `users/{uid}/**`
- `vercel.json` — crons: daily notify 06:00 UTC, weekly close Monday 04:00 UTC (Hobby fires within the hour)

## Setup checklist
1. **Firebase console**
   - Authentication → Sign-in method: enable **Google** and **Email/Password**.
   - Authentication → Settings → Authorized domains: add your Vercel domain.
   - Firestore: create the database, then paste `firestore.rules` in the Rules tab and publish.
   - Project settings → Your apps → Web app: copy the config into `FIREBASE_CONFIG` in `index.html`.
   - Project settings → Service accounts → Generate new private key. Minify the JSON to one line.
2. **VAPID keys** (for push): `npx web-push generate-vapid-keys`. Put the public key in `VAPID_PUBLIC_KEY` in `index.html` and both keys in Vercel env.
3. **Vercel** → Settings → Environment Variables: everything in `.env.example`. `CRON_SECRET` is sent automatically by Vercel cron as a Bearer token when set.
4. Deploy. Open the site, sign in, complete onboarding, press "Build my first week".

## Firestore layout
```
users/{uid}                profile, email, createdAt
users/{uid}/plans/{weekId} generated weekly plan
users/{uid}/logs/{id}      session logs            (step 3)
users/{uid}/reviews/{wk}   weekly feedback         (step 4)
users/{uid}/nutrition/{d}  targets + meals         (step 5)
users/{uid}/weights/{id}   weight history
users/{uid}/push/main      Web Push subscription + timezone
usage/{uid}                server-only daily API counters (not readable by clients)
```

## Roadmap
1. ✅ Auth, onboarding, profile
2. ✅ Plan generation prompt + full session view
3. ✅ Session logging + weight tracking
4. ✅ Weekly review + next week
5. ✅ Nutrition targets + meal logging + estimate
6. ✅ Rate limiting, iCal feed, install prompt, export/delete, auto-close cron

## Automated smoke test
`.github/workflows/smoke.yml` runs a headless Chromium against the live site after every push. Add these repository secrets (GitHub → Settings → Secrets and variables → Actions):
- `CADENCE_URL` — e.g. https://cadence-xi-one.vercel.app
- `CADENCE_TEST_EMAIL` / `CADENCE_TEST_PASSWORD` — an email/password account created in Firebase → Authentication → Users → Add user
Without the two account secrets the sign-in test is skipped and only the route checks run.
