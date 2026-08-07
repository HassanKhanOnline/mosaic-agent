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
