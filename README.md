# Mosaic Agent

Pulls tile photos out of Gmail, tags them with AI and by hand, and lets the
sales team find the right image in seconds.

A client connects their Gmail. We walk every thread that has an attachment,
store the images, keep the surrounding email text as context, tag each image,
and index the lot for search.

## Stack

Same shape as the client portal, so nothing new to learn:

```
Cloudflare Worker + Hono     API, OAuth callback, search
Cloudflare Workflows         durable backfill (survives restarts, resumes)
Cloudflare Queues            per-image tagging jobs
R2                           original images + thumbnails
Supabase Postgres            metadata, tags, pgvector index
React + Vite + Tailwind      the search UI
```

Workflows matter here. A 50k-mailbox backfill takes hours and will hit Gmail
rate limits, token refreshes and the odd 500. A plain Worker request dies long
before that; a Workflow checkpoints each step and picks up where it stopped.

## The blocker to start on today

`gmail.readonly` is a **restricted** scope. Because outside clients will be
connecting their own mailboxes, Google requires:

1. OAuth app verification (brand review, privacy policy, demo video), and
2. a **CASA Tier 2 security assessment** by an authorised third-party
   assessor — paid, repeated annually, and typically several weeks end to end.

Until that clears, the app is capped at **100 test users** added by hand in the
Google Cloud console. That is genuinely enough to run your first clients, so
the build isn't blocked — but start the verification paperwork in parallel with
development, not after it, because the assessment is the long pole.

Two things that make the review go easier, both already in this design:

- Request only `gmail.readonly`. Nothing else. No send, no modify.
- Only fetch threads matching `has:attachment`. When the reviewer asks why you
  need a restricted scope, "we read attachment-bearing threads to index product
  photos, and store nothing else" is a far better answer than "we copy the
  mailbox".

## Pipeline

```
1  connect     OAuth consent → refresh token, encrypted, per account
2  discover    messages.list  q="has:attachment -in:spam -in:trash"
                 → page through ids, checkpointing pageToken
3  fetch       threads.get per thread → all messages, headers, bodies
4  extract     walk MIME parts → attachment ids for image/*
5  download    messages.attachments.get → bytes
6  dedupe      SHA-256; skip if seen; count occurrences instead
7  filter      drop signature logos and junk (see below)
8  store       original + 400px thumb → R2
9  analyse     vision model → description + structured tile attributes
10 embed       text embedding of (description + tags + thread context)
11 index       write tags, attrs, tsvector, vector → Postgres
12 sync        historyId watermark; poll for new mail, repeat 3–11
```

### Step 7 is the one people skip and regret

A tile business mailbox is maybe 70% noise by image count: email signature
logos, social icons, tracking pixels, PDF page renders, wallpaper from
newsletters. Left in, they drown the search results and you pay AI tagging
costs on every one.

Filters, cheapest first:

- **Inline vs attached** — `Content-Disposition: inline` with a `cid:` reference
  is usually signature furniture. Not always; flag rather than delete.
- **Size** — under ~25 KB, or under 200px on either edge, is not a tile photo.
- **Repeat hash** — the same SHA-256 across many senders and months is
  boilerplate. Auto-suppress above a threshold (say 15 occurrences spanning
  more than 30 days), and keep it reviewable.
- **Aspect ratio** — extreme ratios are banners and dividers.
- **Vision fallback** — the tagger's first question is "is this a tile, a room,
  a product sheet, or none of the above?" Anything answering "none" gets
  `status = 'rejected'` and drops out of search but stays on disk, so a bad
  call is reversible.

### Step 9: tag against a fixed vocabulary, not free text

Free-form AI tags are the classic failure here — you end up with "beige",
"cream", "sand", "biscuit" and "off-white" as five unrelated tags and search
matches none of them. The vision model gets a controlled vocabulary and must
answer inside it:

| Facet | Example values |
|---|---|
| `colour_family` | white, cream/beige, grey, black, brown, terracotta, blue, green, multi |
| `finish` | matt, polished, satin, lappato, textured, anti-slip, rustic |
| `material_look` | marble, stone, concrete, wood, terrazzo, metallic, plain, patterned |
| `format` | large format, plank, square, subway, mosaic, hexagon, herringbone |
| `application` | floor, wall, bathroom, kitchen, splashback, outdoor, pool |
| `shot_type` | product flat, room scene, installed job, sample board, spec sheet |

Plus free text: a one-line description, any visible product name or code, and
the nominal size if it can be read off the image or the email.

The email is often more reliable than the picture for the *name* — the thread
will say "attached is the Calacatta Gold 600x1200 polished" where the image
alone can't tell you the range. So the tagger sees both: the image, and the
thread text. That's the whole reason for keeping the email context.

Manual tags sit in the same table with `source = 'manual'` and always outrank
AI tags in ranking. Correcting a tag by hand is the feedback loop.

## Search

Hybrid, fused with Reciprocal Rank Fusion:

- **Lexical** — Postgres `tsvector` over tags, description, product codes,
  subject and thread body. Wins on "Calacatta 600x1200".
- **Semantic** — pgvector cosine over the embedding. Wins on "something warm
  and sandy for a bathroom floor".
- **Facets** — hard filters on colour, finish, format, application, and on
  customer or date, applied before ranking.

RRF because the two scores aren't comparable and tuning a weighted blend by
hand never converges. Rank each list, score `1/(60 + rank)`, add.

Image-similarity search ("find tiles that look like this photo") is a later
addition — a CLIP-style embedding in a second vector column. The schema leaves
room; don't build it in v1.

## Privacy, since this is someone else's mailbox

- Refresh tokens encrypted at rest, never in logs, never sent to the browser.
- Row-level security on every table, keyed by `tenant_id`. A client's team sees
  only their own library.
- Email bodies stored only for attachment-bearing threads, and only as text.
- A disconnect button that actually deletes: revoke at Google, drop rows, purge
  R2. Google's reviewers ask about this specifically.
- Retention setting per tenant, defaulting to "keep until disconnected".

## Cost sketch, 50k emails

Assume ~8k attachment threads, ~15k raw images, ~4k surviving the filters.

| | |
|---|---|
| Vision tagging, 4k images | the dominant cost — batch it, cache by hash |
| Embeddings, 4k | cents, on Workers AI |
| R2 storage, ~4 GB | negligible, and no egress fees |
| Supabase | free tier is fine at this size |

Deduping before tagging is what keeps this cheap: you pay per distinct image,
not per occurrence.

## Build order

1. Probe script — count messages, attachment threads and rough image volume in
   one real mailbox. Confirms the estimates above before anything is committed.
2. Schema + RLS.
3. OAuth connect flow, token storage, test-user mode.
4. Backfill Workflow through step 8 (store, no AI yet). Now you can eyeball
   what actually came out and tune the filters against real data.
5. Tagging queue + vocabulary.
6. Search API + UI.
7. Incremental sync.
8. Manual tagging and correction UI.

Steps 1 and 4 come before the AI work on purpose. The filter thresholds above
are educated guesses; the only way to set them properly is to look at a real
mailbox's output.

## Later

The `mosaicenter` Shopify store is the obvious next hook — linking a tagged
image to the product it belongs to would let this feed the storefront, not just
the sales team. Out of scope for v1, but worth not painting over: that's why
assets carry a nullable `product_ref`.
