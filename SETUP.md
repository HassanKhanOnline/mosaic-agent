# Setup

Five steps. Three of them need a browser and a password, so they are yours; the
rest is `npm`.

## 1. Database

Open the [Supabase SQL editor](https://supabase.com/dashboard/project/izeineiwbhfsbgsspisz/sql/new),
paste the whole of [`supabase/apply.sql`](supabase/apply.sql), run it.

That is the three migrations concatenated — schema, tag vocabulary, search
functions. It is idempotent enough to re-run, but it is a fresh project, so it
should only need running once.

Then create yourself a login: **Authentication → Users → Add user**, with an
email and password, and "Auto Confirm User" ticked. There is no sign-up form in
the app on purpose.

## 2. Cloudflare R2

R2 is not enabled on the account yet, and it cannot be enabled from the CLI:

    Dashboard → R2 → Enable R2

Then:

```bash
npx wrangler r2 bucket create mosaic-agent-images
```

Cloudflare Images is worth enabling on the same account — it is what makes the
400px thumbnails. Without it the library still works, the search grid just
loads full-size images.

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

Either way, create an **OAuth client ID** of type *Web application* with these
authorised redirect URIs:

    http://localhost:5173/auth/google/callback
    https://<your-production-host>/auth/google/callback

Scope requested: `gmail.readonly`, and nothing else.

Put the client id and secret in `.dev.vars`.

## 4. Anthropic key

[console.anthropic.com](https://console.anthropic.com) → API keys. Into
`.dev.vars` as `ANTHROPIC_API_KEY`.

## 5. Run it

```bash
npm run dev
```

```bash
npm run dev:worker
```

Sign in, go to **Admin**, click **Connect Gmail**.

Then — before starting the backfill — run the probe:

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

```bash
npm run deploy
```

Secrets do not come from `.dev.vars` in production:

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
```

...and the same for `TOKEN_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ANTHROPIC_API_KEY`. Then set `APP_URL` in `wrangler.jsonc` to the production
hostname and add its callback URL to the Google OAuth client.

**Keep `TOKEN_KEY`.** It encrypts the Gmail refresh token. Rotating it means
reconnecting the mailbox.
