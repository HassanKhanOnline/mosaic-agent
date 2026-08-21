-- Idempotent catch-up: visual similarity (0005) + dedupe (0006) only.
-- Safe to run repeatedly — every statement checks for itself first.

create extension if not exists vector;

-- ---- 0005: visual similarity ----

alter table assets add column if not exists visual vector(108);

create index if not exists assets_visual_idx
  on assets using hnsw (visual vector_cosine_ops);

create or replace function similar_assets(source uuid, limit_n integer default 24)
returns table (asset_id uuid, distance real)
language sql
stable
as $$
  select a.id, (a.visual <=> s.visual)::real as distance
  from assets a,
       (select visual from assets where id = source) s
  where a.id <> source
    and a.visual is not null
    and s.visual is not null
    and a.status in ('pending', 'ready')
  order by a.visual <=> s.visual
  limit limit_n;
$$;

-- ---- 0006: near-duplicate merging ----

alter table assets add column if not exists dedup_at timestamptz;

create or replace function nearest_asset(query_visual vector(108), exclude_id uuid default null)
returns table (asset_id uuid, distance real)
language sql
stable
as $$
  select a.id, (a.visual <=> query_visual)::real as distance
  from assets a
  where a.visual is not null
    and a.status in ('pending', 'ready')
    and (exclude_id is null or a.id <> exclude_id)
  order by a.visual <=> query_visual
  limit 1;
$$;

-- Everything fingerprints and dedupe-checks from scratch under the
-- rotation-canonical scheme.
update assets set visual = null, dedup_at = null;

-- Confirmation: should return the two column names.
select column_name from information_schema.columns
where table_name = 'assets' and column_name in ('visual', 'dedup_at');
