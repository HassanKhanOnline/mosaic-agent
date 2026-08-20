-- Near-duplicate merging.
--
-- dedup_at marks assets the merge pass has checked; nearest_asset is the
-- lookup both the retroactive pass and ingest use to ask "does this image
-- already exist?". Existing fingerprints are reset because the fingerprint
-- became rotation-canonical — every vector must be recomputed under the new
-- scheme before merge decisions are trusted, and the visual tick does that
-- automatically at ~25/minute.

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

-- Recompute everything under the canonical scheme, and re-check everything
-- for duplicates once recomputed.
update assets set visual = null, dedup_at = null;
