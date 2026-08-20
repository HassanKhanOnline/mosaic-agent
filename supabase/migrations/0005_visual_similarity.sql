-- Visual similarity: find images that look alike, no AI involved.
--
-- Each asset gets a 108-dim fingerprint (a 6x6 grid of average RGB over a
-- normalised 24x24 render, L2-normalised) computed at ingest. For tiles this
-- is most of what "looks similar" means — palette, tone, texture energy —
-- and cosine distance over it is cheap and index-friendly. It complements the
-- text embedding on asset_analysis (which knows names and products but only
-- exists once AI tagging has run); this one exists for every stored image.

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
