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
  -- AES-GCM ciphertext, base64, encrypted in the Worker before insert. Text
  -- rather than bytea so it round-trips through PostgREST without escaping
  -- games. Never leaves the server: the RLS policy below denies this table to
  -- the browser outright.
  refresh_token  text not null,
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
-- The controlled vocabulary the vision tagger must answer inside.
--
-- Deliberately small. A short list the model picks from beats a long list it
-- guesses at, and every term here is one a salesperson would actually type
-- into the search box. Add terms as real searches miss; do not pre-empt.

insert into tags (facet, value) values
  ('colour_family', 'white'),
  ('colour_family', 'cream / beige'),
  ('colour_family', 'grey'),
  ('colour_family', 'charcoal / black'),
  ('colour_family', 'brown'),
  ('colour_family', 'terracotta'),
  ('colour_family', 'blue'),
  ('colour_family', 'green'),
  ('colour_family', 'multi-colour'),

  ('finish', 'matt'),
  ('finish', 'polished'),
  ('finish', 'satin'),
  ('finish', 'lappato'),
  ('finish', 'textured'),
  ('finish', 'anti-slip'),
  ('finish', 'rustic'),

  ('material_look', 'marble'),
  ('material_look', 'stone'),
  ('material_look', 'concrete'),
  ('material_look', 'wood'),
  ('material_look', 'terrazzo'),
  ('material_look', 'metallic'),
  ('material_look', 'plain'),
  ('material_look', 'patterned'),

  ('format', 'large format'),
  ('format', 'plank'),
  ('format', 'square'),
  ('format', 'subway'),
  ('format', 'mosaic'),
  ('format', 'hexagon'),
  ('format', 'herringbone'),

  ('application', 'floor'),
  ('application', 'wall'),
  ('application', 'bathroom'),
  ('application', 'kitchen'),
  ('application', 'splashback'),
  ('application', 'outdoor'),
  ('application', 'pool'),

  -- shot_type is what makes "show me a room, not a swatch" work, and it is
  -- also the reject gate: anything the model calls 'not a tile' never reaches
  -- search.
  ('shot_type', 'product flat'),
  ('shot_type', 'room scene'),
  ('shot_type', 'installed job'),
  ('shot_type', 'sample board'),
  ('shot_type', 'spec sheet'),
  ('shot_type', 'not a tile')
on conflict (facet, value) do nothing;
-- Hybrid search: lexical and semantic, fused with Reciprocal Rank Fusion.
--
-- RRF rather than a weighted score blend because a tsvector rank and a cosine
-- distance are not on comparable scales, and hand-tuning weights between them
-- never converges. Rank each list independently, score 1/(k + rank), add.
-- k = 60 is the standard damping constant: it stops a single #1 hit from
-- dominating when the two lists disagree.

create or replace function search_assets(
  q             text,
  q_embedding   vector(1024),
  facets        text[] default null,   -- tag ids, ANDed across facets
  limit_n       integer default 48,
  offset_n      integer default 0
)
returns table (
  asset_id    uuid,
  score       real,
  lexical_rank integer,
  vector_rank  integer
)
language sql
stable
as $$
with
-- Facet filter first, so ranking only ever considers eligible rows.
eligible as (
  select a.id
  from assets a
  where a.status = 'ready'
    and (
      facets is null
      or not exists (
        -- Every requested facet must be satisfied. Grouping by facet means
        -- two values from the same facet are an OR, and values from different
        -- facets are an AND — which is how people expect filters to behave:
        -- "grey or beige, and matt".
        select 1
        from tags t
        where t.id = any (facets::uuid[])
        group by t.facet
        having not exists (
          select 1 from asset_tags at
          join tags t2 on t2.id = at.tag_id
          where at.asset_id = a.id
            and t2.facet = t.facet
            and at.tag_id = any (facets::uuid[])
        )
      )
    )
),
lexical as (
  select s.asset_id,
         row_number() over (
           order by ts_rank_cd(s.tsv, websearch_to_tsquery('english', q)) desc
         )::integer as rank
  from asset_search s
  join eligible e on e.id = s.asset_id
  where q <> '' and s.tsv @@ websearch_to_tsquery('english', q)
  limit 200
),
semantic as (
  select an.asset_id,
         row_number() over (order by an.embedding <=> q_embedding)::integer as rank
  from asset_analysis an
  join eligible e on e.id = an.asset_id
  where q_embedding is not null and an.embedding is not null
  limit 200
)
select
  coalesce(l.asset_id, s.asset_id) as asset_id,
  (coalesce(1.0 / (60 + l.rank), 0) + coalesce(1.0 / (60 + s.rank), 0))::real as score,
  l.rank as lexical_rank,
  s.rank as vector_rank
from lexical l
full outer join semantic s on s.asset_id = l.asset_id
order by score desc
limit limit_n
offset offset_n;
$$;

-- Browse with no query at all: newest first, same facet semantics.
create or replace function browse_assets(
  facets  text[] default null,
  limit_n integer default 48,
  offset_n integer default 0
)
returns setof assets
language sql
stable
as $$
  select a.*
  from assets a
  where a.status = 'ready'
    and (
      facets is null
      or not exists (
        select 1 from tags t
        where t.id = any (facets::uuid[])
        group by t.facet
        having not exists (
          select 1 from asset_tags at
          join tags t2 on t2.id = at.tag_id
          where at.asset_id = a.id
            and t2.facet = t.facet
            and at.tag_id = any (facets::uuid[])
        )
      )
    )
  order by a.last_seen_at desc nulls last
  limit limit_n offset offset_n;
$$;
-- Manual-first tagging.
--
-- Originally an image only entered search once the AI pass promoted it to
-- 'ready', which quietly made the AI step mandatory. It is not: pending assets
-- are now browsable and searchable too, so a team can hand-tag from day one
-- and add AI later (or never). 'rejected' and 'suppressed' stay hidden.
--
-- Also adds an untagged-only filter — the working queue for whoever is doing
-- the hand-tagging: "show me what nobody has touched yet".
--
-- Dropped and recreated (not replaced) because the signatures change.

drop function if exists search_assets(text, vector, text[], integer, integer);
drop function if exists browse_assets(text[], integer, integer);

create function search_assets(
  q             text,
  q_embedding   vector(1024),
  facets        text[] default null,
  limit_n       integer default 48,
  offset_n      integer default 0,
  untagged      boolean default false
)
returns table (
  asset_id     uuid,
  score        real,
  lexical_rank integer,
  vector_rank  integer
)
language sql
stable
as $$
with
eligible as (
  select a.id
  from assets a
  where a.status in ('pending', 'ready')
    and (
      not untagged
      or not exists (
        select 1 from asset_tags at
        where at.asset_id = a.id and at.source = 'manual'
      )
    )
    and (
      facets is null
      or not exists (
        select 1
        from tags t
        where t.id = any (facets::uuid[])
        group by t.facet
        having not exists (
          select 1 from asset_tags at
          join tags t2 on t2.id = at.tag_id
          where at.asset_id = a.id
            and t2.facet = t.facet
            and at.tag_id = any (facets::uuid[])
        )
      )
    )
),
lexical as (
  select s.asset_id,
         row_number() over (
           order by ts_rank_cd(s.tsv, websearch_to_tsquery('english', q)) desc
         )::integer as rank
  from asset_search s
  join eligible e on e.id = s.asset_id
  where q <> '' and s.tsv @@ websearch_to_tsquery('english', q)
  limit 200
),
semantic as (
  select an.asset_id,
         row_number() over (order by an.embedding <=> q_embedding)::integer as rank
  from asset_analysis an
  join eligible e on e.id = an.asset_id
  where q_embedding is not null and an.embedding is not null
  limit 200
)
select
  coalesce(l.asset_id, s.asset_id) as asset_id,
  (coalesce(1.0 / (60 + l.rank), 0) + coalesce(1.0 / (60 + s.rank), 0))::real as score,
  l.rank as lexical_rank,
  s.rank as vector_rank
from lexical l
full outer join semantic s on s.asset_id = l.asset_id
order by score desc
limit limit_n
offset offset_n;
$$;

create function browse_assets(
  facets   text[] default null,
  limit_n  integer default 48,
  offset_n integer default 0,
  untagged boolean default false
)
returns setof assets
language sql
stable
as $$
  select a.*
  from assets a
  where a.status in ('pending', 'ready')
    and (
      not untagged
      or not exists (
        select 1 from asset_tags at
        where at.asset_id = a.id and at.source = 'manual'
      )
    )
    and (
      facets is null
      or not exists (
        select 1 from tags t
        where t.id = any (facets::uuid[])
        group by t.facet
        having not exists (
          select 1 from asset_tags at
          join tags t2 on t2.id = at.tag_id
          where at.asset_id = a.id
            and t2.facet = t.facet
            and at.tag_id = any (facets::uuid[])
        )
      )
    )
  order by a.last_seen_at desc nulls last
  limit limit_n offset offset_n;
$$;
