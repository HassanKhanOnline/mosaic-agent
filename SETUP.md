# Setup

Live at **https://mosaic-agent.hassankhanonline.workers.dev**

Done already: R2 bucket created, Worker deployed, crons running,
`SUPABASE_SECRET_KEY` and `TOKEN_KEY` set as production secrets.

Still needed, in order — nothing works until step 1:

- [ ] 1. Apply the database schema
- [ ] 2. ~~Enable R2~~ done
- [ ] 3. Google OAuth client, and its two secrets
- [ ] 4. Anthropic key
- [ ] 5. Probe, then backfill

## 1. Database

Open the [Supabase SQL editor](https://supabase.com/dashboard/project/izeineiwbhfsbgsspisz/sql/new),
paste the whole of [`supabase/apply.sql`](supabase/apply.sql), run it.

That is the three migrations concatenated — schema, tag vocabulary, search
functions. It is idempotent enough to re-run, but it is a fresh project, so it
should only need running once.

Then create yourself a login: **Authentication → Users → Add user**, with an
email and password, and "Auto Confirm User" ticked. There is no sign-up form in
the app on purpose.

## 2. Cloudflare R2 — done

`mosaic-agent-images` exists on account `39d4ad99` and the Worker is bound to
it.

Cloudflare **Images** is still worth enabling on the same account — it is what
makes the 400px thumbnails. Without it the library works, the search grid just
loads full-size photos. Nothing breaks either way; `thumb_key` is left null and
the UI falls back.

## 3. Google Cloud

Because this is one mailbox rather than a product, there is no verification and
no security assessment. Which path you take depends on one fact:

**Is `info@tellustile.com` on Google Workspace?**

If yes — the good path. Create a project at
[console.cloud.google.com](https://console.cloud.google.com), enable the Gmail
API, then **APIs & Services → OAuth consent screen** and set the user type to
**Internal**. No review, and refresh tokens never expire.

If it is a plain `@gmail.com` — leave the consent screen in **Testing** and add
`info@tellustile.com` under "Test users". Works immediately, but refresh tokens
expire every 7 days, so the sync will stop weekly until someone clicks
Reconnect on the admin page. The app detects this and says so rather than
failing silently.

Either way, create an **OAuth client ID** of type *Web application* with this
authorised redirect URI:

    https://mosaic-agent.hassankhanonline.workers.dev/auth/google/callback

Scope requested: `gmail.readonly`, and nothing else.

Then set both halves as production secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Add them to `.dev.vars` too if you want to run locally — and in that case add
`http://localhost:5173/auth/google/callback` to the same client, and point
`APP_URL` in `wrangler.jsonc` at localhost while you do. `APP_URL` is what the
callback URL is built from, so it and Google have to agree.

## 4. Anthropic key

[console.anthropic.com](https://console.anthropic.com) → API keys.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

## 5. Run it

Sign in at
[the live app](https://mosaic-agent.hassankhanonline.workers.dev), go to
**Admin**, click **Connect Gmail**.

Then — before starting the backfill — run the probe from a checkout with
`.dev.vars` filled in:

```bash
npm run probe -- --pages 20
```

It downloads nothing. It counts the attachment-bearing threads and reports how
many images would survive each filter. The thresholds in
`worker/lib/images.ts` (25 KB, 200px, 15 repeats over 30 days) are educated
guesses; this is how they stop being guesses. If the probe says 90% of images
are under 25 KB, the mailbox is mostly signature logos and the threshold is
about right. If it says 5%, the threshold is throwing away real photos.

Adjust if needed, then **Start backfill** on the admin page. It advances one
batch a minute on its own. Under `wrangler dev` cron triggers do not fire, so
use **Run one batch now** to watch it work.

## Cost, once

Tagging is the only meaningful spend, and it is one-time — deduping means you
pay per distinct image, not per email. On Claude Opus 5 at $5 / $25 per million
tokens, roughly **$100–150 for a 4,000-image library**. The probe's survivor
count tells you the real number before you commit to it.

Two levers if that matters: tag from the 400px thumbnail rather than the
original (cuts image tokens roughly fourfold, at some risk to reading product
codes off spec sheets), or use a smaller model. Both are one-line changes in
`worker/lib/tagging.ts`.

## Deploy

Pushing to `main` deploys, via Cloudflare Workers Builds. By hand:

```bash
npm run deploy
```

`SUPABASE_SECRET_KEY` and `TOKEN_KEY` are already set in production. The two
Google secrets and the Anthropic key are not — see steps 3 and 4.

**Keep `TOKEN_KEY`.** It encrypts the Gmail refresh token. Rotating it means
reconnecting the mailbox.

## What the crons are doing right now

Both schedules are live and will fire every minute regardless of setup state.
Until the schema exists they log an error and do nothing — harmless, and they
start working the moment step 1 lands. No need to pause anything.
