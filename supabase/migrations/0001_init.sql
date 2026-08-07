-- Mosaic Agent — initial schema.
--
-- One mailbox, one shared library. Everyone who can log in sees everything,
-- so there is no tenancy layer here; RLS exists only to keep the browser out
-- of the credentials and to require a login for the rest. The ingestion
-- pipeline runs as service role and bypasses these policies.
--
-- Embeddings are 1024-wide: Workers AI @cf/baai/bge-m3. Changing model means
-- changing the column, so it is spelled out rather than hidden behind a guess.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ------------------------------------------------------------ gmail link

-- Expected to hold exactly one row. Not enforced as a constraint, because a
-- second row is how a mailbox migration would happen without downtime.
create table gmail_accounts (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  google_sub     text not null unique,      -- stable Google user id
  -- Encrypted in the Worker before insert. Never leaves the server: the RLS
  -- policy below denies this table to the browser outright.
  refresh_token  bytea not null,
  scopes         text[] not null,
  -- Watermark for incremental sync via users.history.list.
  history_id     text,
  connected_at   timestamptz not null default now(),
  -- Set when Google rejects the token. On a consumer @gmail.com account with
  -- the OAuth app in Testing status this fires every 7 days by design, and is
  -- what the "reconnect" prompt keys off.
  invalid_since  timestamptz,
  revoked_at     timestamptz
);

-- One row per backfill or incremental pass, so a crash resumes instead of
-- restarting. page_token is the Gmail list cursor.
create table sync_runs (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references gmail_accounts(id) on delete cascade,
  kind          text not null check (kind in ('backfill','incremental')),
  status        text not null default 'running'
                  check (status in ('running','done','failed','cancelled')),
  page_token    text,
  threads_seen  integer not null default 0,
  images_stored integer not null default 0,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  error         text
);

create index on sync_runs (account_id, started_at desc);

-- ----------------------------------------------------------------- email

create table threads (
  id              uuid primary key default gen_random_uuid(),
  gmail_thread_id text not null unique,
  subject         text,
  participants    text[] not null default '{}',
  first_date      timestamptz,
  last_date       timestamptz,
  -- All message bodies concatenated. This is the context the tagger reads and
  -- what text search hits; denormalised to avoid a join per search result.
  body_text       text,
  fetched_at      timestamptz not null default now()
);

create index on threads (last_date desc);

create table messages (
  id               uuid primary key default gen_random_uuid(),
  thread_id        uuid not null references threads(id) on delete cascade,
  gmail_message_id text not null unique,
  from_addr        text,
  to_addrs         text[] not null default '{}',
  sent_at          timestamptz,
  body_text        text
);

create index on messages (sent_at desc);
create index on messages (thread_id);

-- ---------------------------------------------------------------- images

-- One row per DISTINCT image, keyed by content hash. The same photo mailed to
-- forty customers is one asset with forty occurrences — that is what keeps the
-- tagging bill proportional to the library rather than to the mailbox.
create table assets (
  id            uuid primary key default gen_random_uuid(),
  sha256        text not null unique,
  r2_key        text not null,
  thumb_key     text,
  mime          text not null,
  bytes         integer not null,
  width         integer,
  height        integer,

  status        text not null default 'pending'
                  check (status in ('pending','ready','rejected','suppressed')),
  -- Why it was rejected or suppressed: 'too_small', 'boilerplate',
  -- 'not_a_tile', 'bad_ratio', 'manual'. Kept so a wrong call is auditable and
  -- reversible rather than a silent disappearance.
  reject_reason text,

  occurrence_count integer not null default 0,
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,

  -- Reserved for the Shopify link. Unused in v1.
  product_ref   text,

  created_at    timestamptz not null default now()
);

create index on assets (status, last_seen_at desc);

create table asset_occurrences (
  asset_id   uuid not null references assets(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  filename   text,
  is_inline  boolean not null default false,
  primary key (asset_id, message_id)
);

create index on asset_occurrences (message_id);

-- --------------------------------------------------------------- tagging

-- Controlled vocabulary. facet is the axis (colour_family, finish, ...),
-- value is the allowed term. Seeded in 0002; extend by inserting, not by
-- letting the model invent terms.
create table tags (
  id     uuid primary key default gen_random_uuid(),
  facet  text not null,
  value  text not null,
  unique (facet, value)
);

create table asset_tags (
  asset_id   uuid not null references assets(id) on delete cascade,
  tag_id     uuid not null references tags(id) on delete cascade,
  source     text not null check (source in ('ai','manual')),
  confidence real,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- source is in the key on purpose: an AI tag and a human confirming the same
  -- tag are two facts, and knowing they agreed is how the tagger gets audited.
  primary key (asset_id, tag_id, source)
);

create index on asset_tags (tag_id);

-- The model's own read of the picture, kept separate from assets so a
-- re-tagging run with a newer model is an insert, not a destructive update.
create table asset_analysis (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references assets(id) on delete cascade,
  model        text not null,
  description  text,
  product_name text,
  product_code text,
  size_mm      text,
  -- Everything the model returned, including facets not yet promoted to tags.
  attrs        jsonb not null default '{}',
  embedding    vector(1024),
  created_at   timestamptz not null default now(),
  unique (asset_id, model)
);

create index on asset_analysis using hnsw (embedding vector_cosine_ops);

-- --------------------------------------------------------------- search

-- Denormalised search row, one per asset, rebuilt by the tagging job. A view
-- would be cleaner but would re-tokenise the thread text on every query.
create table asset_search (
  asset_id uuid primary key references assets(id) on delete cascade,
  -- description + product name/code + every tag value + subject + thread text
  content  text not null,
  tsv      tsvector generated always as (to_tsvector('english', content)) stored
);

create index on asset_search using gin (tsv);
create index on asset_search using gin (content gin_trgm_ops);

-- ------------------------------------------------------------------- rls

alter table gmail_accounts    enable row level security;
alter table sync_runs         enable row level security;
alter table threads           enable row level security;
alter table messages          enable row level security;
alter table assets            enable row level security;
alter table asset_occurrences enable row level security;
alter table tags              enable row level security;
alter table asset_tags        enable row level security;
alter table asset_analysis    enable row level security;
alter table asset_search      enable row level security;

-- Holds the encrypted refresh token. No client-side read, ever. The Worker
-- reaches it with the service role key, which bypasses RLS.
create policy no_client_access on gmail_accounts for select using (false);

-- Everything else: logged in means you can read it.
create policy read_authed on sync_runs         for select to authenticated using (true);
create policy read_authed on threads           for select to authenticated using (true);
create policy read_authed on messages          for select to authenticated using (true);
create policy read_authed on assets            for select to authenticated using (true);
create policy read_authed on asset_occurrences for select to authenticated using (true);
create policy read_authed on tags              for select to authenticated using (true);
create policy read_authed on asset_tags        for select to authenticated using (true);
create policy read_authed on asset_analysis    for select to authenticated using (true);
create policy read_authed on asset_search      for select to authenticated using (true);

-- Manual tagging is the only write the browser gets. AI tags are the
-- pipeline's to write, as service role.
create policy tag_manual on asset_tags
  for insert to authenticated with check (source = 'manual');

create policy untag_manual on asset_tags
  for delete to authenticated using (source = 'manual');
