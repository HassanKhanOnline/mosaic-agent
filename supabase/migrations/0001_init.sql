-- Tile Image Library — initial schema.
--
-- Multi-tenant. Every table carries tenant_id and is fenced by RLS, because
-- the rows are extracts from someone else's mailbox and a leak between two
-- clients is not a bug you get to explain away.
--
-- Embeddings are 1024-wide: Workers AI @cf/baai/bge-m3. Changing model means
-- changing the column, so it is spelled out rather than hidden behind a guess.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- tenancy

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  -- null means keep everything until the mailbox is disconnected.
  retain_days integer
);

create table memberships (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index on memberships (user_id);

-- Used by every RLS policy below. security definer so it can read memberships
-- without recursing back through that table's own policy.
create or replace function is_member(t uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships
    where tenant_id = t and user_id = auth.uid()
  );
$$;

-- ------------------------------------------------------------ gmail links

create table gmail_accounts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  email          text not null,
  google_sub     text not null,             -- stable Google user id
  -- Encrypted before insert, in the Worker. Never selected to the browser:
  -- the RLS policies below deliberately do not expose this table to anon.
  refresh_token  bytea not null,
  scopes         text[] not null,
  -- Watermark for incremental sync via users.history.list.
  history_id     text,
  connected_at   timestamptz not null default now(),
  revoked_at     timestamptz,
  unique (tenant_id, google_sub)
);

-- One row per backfill or incremental pass, so a crash resumes instead of
-- restarting. page_token is the Gmail list cursor.
create table sync_runs (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references gmail_accounts(id) on delete cascade,
  kind              text not null check (kind in ('backfill','incremental')),
  status            text not null default 'running'
                      check (status in ('running','done','failed','cancelled')),
  page_token        text,
  threads_seen      integer not null default 0,
  images_stored     integer not null default 0,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  error             text
);

create index on sync_runs (account_id, started_at desc);

-- ----------------------------------------------------------------- email

create table threads (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  account_id     uuid not null references gmail_accounts(id) on delete cascade,
  gmail_thread_id text not null,
  subject        text,
  participants   text[] not null default '{}',
  first_date     timestamptz,
  last_date      timestamptz,
  -- All message bodies concatenated. This is the context the tagger reads and
  -- the text search hits; keeping it denormalised avoids a join per result.
  body_text      text,
  fetched_at     timestamptz not null default now(),
  unique (account_id, gmail_thread_id)
);

create index on threads (tenant_id, last_date desc);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  thread_id       uuid not null references threads(id) on delete cascade,
  gmail_message_id text not null,
  from_addr       text,
  to_addrs        text[] not null default '{}',
  sent_at         timestamptz,
  body_text       text,
  unique (thread_id, gmail_message_id)
);

create index on messages (tenant_id, sent_at desc);

-- ---------------------------------------------------------------- images

-- One row per DISTINCT image, keyed by content hash. The same photo mailed to
-- forty customers is one asset with forty occurrences — that is what keeps the
-- tagging bill proportional to the library, not to the mailbox.
create table assets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  sha256        text not null,
  r2_key        text not null,
  thumb_key     text,
  mime          text not null,
  bytes         integer not null,
  width         integer,
  height        integer,

  status        text not null default 'pending'
                  check (status in ('pending','ready','rejected','suppressed')),
  -- Why it was rejected or suppressed: 'too_small', 'boilerplate',
  -- 'not_a_tile', 'bad_ratio', 'manual'. Kept so a wrong call is auditable
  -- and reversible rather than a silent disappearance.
  reject_reason text,

  occurrence_count integer not null default 0,
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,

  -- Reserved for the Shopify link. Unused in v1.
  product_ref   text,

  created_at    timestamptz not null default now(),
  unique (tenant_id, sha256)
);

create index on assets (tenant_id, status, last_seen_at desc);

create table asset_occurrences (
  asset_id   uuid not null references assets(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  filename   text,
  is_inline  boolean not null default false,
  primary key (asset_id, message_id)
);

create index on asset_occurrences (message_id);
create index on asset_occurrences (tenant_id, asset_id);

-- --------------------------------------------------------------- tagging

-- Controlled vocabulary. facet is the axis (colour_family, finish, ...),
-- value is the allowed term. Seeded per tenant so a client can extend it
-- without touching anyone else's.
create table tags (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  facet      text not null,
  value      text not null,
  unique (tenant_id, facet, value)
);

create table asset_tags (
  asset_id   uuid not null references assets(id) on delete cascade,
  tag_id     uuid not null references tags(id) on delete cascade,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  source     text not null check (source in ('ai','manual')),
  confidence real,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (asset_id, tag_id, source)
);

create index on asset_tags (tenant_id, tag_id);

-- The model's own read of the picture, kept separate from assets so a
-- re-tagging run with a newer model is an insert, not a destructive update.
create table asset_analysis (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references assets(id) on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  model         text not null,
  description   text,
  product_name  text,
  product_code  text,
  size_mm       text,
  -- Everything the model returned, including facets not yet promoted to tags.
  attrs         jsonb not null default '{}',
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);

create unique index on asset_analysis (asset_id, model);
create index on asset_analysis
  using hnsw (embedding vector_cosine_ops);

-- --------------------------------------------------------------- search

-- Denormalised search row, one per asset. Rebuilt by the tagging job. A view
-- would be cleaner but would re-tokenise the thread text on every query.
create table asset_search (
  asset_id  uuid primary key references assets(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- description + product name/code + every tag value + subject + thread text
  content   text not null,
  tsv       tsvector generated always as (to_tsvector('english', content)) stored
);

create index on asset_search using gin (tsv);
create index on asset_search using gin (content gin_trgm_ops);

-- ------------------------------------------------------------------- rls

alter table tenants           enable row level security;
alter table memberships       enable row level security;
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

create policy read_own on tenants
  for select using (is_member(id));

create policy read_own on memberships
  for select using (user_id = auth.uid() or is_member(tenant_id));

-- gmail_accounts holds the encrypted refresh token, so no client-side read at
-- all. The Worker reaches it with the service role key.
create policy no_client_access on gmail_accounts
  for select using (false);

create policy read_own on sync_runs
  for select using (exists (
    select 1 from gmail_accounts a
    where a.id = sync_runs.account_id and is_member(a.tenant_id)
  ));

create policy read_own on threads           for select using (is_member(tenant_id));
create policy read_own on messages          for select using (is_member(tenant_id));
create policy read_own on assets            for select using (is_member(tenant_id));
create policy read_own on asset_occurrences for select using (is_member(tenant_id));
create policy read_own on tags              for select using (is_member(tenant_id));
create policy read_own on asset_tags        for select using (is_member(tenant_id));
create policy read_own on asset_analysis    for select using (is_member(tenant_id));
create policy read_own on asset_search      for select using (is_member(tenant_id));

-- Manual tagging is the only write the browser gets. Everything else is the
-- ingestion pipeline, running as service role.
create policy tag_own on asset_tags
  for insert with check (is_member(tenant_id) and source = 'manual');

create policy untag_own on asset_tags
  for delete using (is_member(tenant_id) and source = 'manual');
