# Cadence

Weekly training plans built from your profile, logged in the app, rebuilt every week. Single-file PWA on Vercel, Firebase Auth + Firestore, OpenRouter for plan generation.

## Files
- `index.html` — the whole app (auth, onboarding, views)
- `sw.js`, `manifest.json`, `icon.svg` — PWA
- `api/_lib.js` — Firebase Admin, token check, OpenRouter call
- `api/generate-plan.js` — POST, builds a weekly plan (step 2 refines the prompt)
- `api/daily-notify.js` — daily cron, sends today's session by Web Push
- `firestore.rules` — each user can only read/write `users/{uid}/**`
- `vercel.json` — cron schedule (06:00 UTC, fires within that hour on Hobby)

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
```

## Roadmap
1. ✅ Auth, onboarding, profile
2. ✅ Plan generation prompt + full session view
3. ✅ Session logging + weight tracking
4. Weekly review + next week
5. Nutrition targets + meal logging
6. Rate limiting, iCal feed, offline polish
