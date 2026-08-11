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
