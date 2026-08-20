import { db } from '../lib/db';
import { rebuildSearchRows } from '../lib/search';
// Merging is destructive — the duplicate's bytes are deleted from R2 — so the
// threshold is strict: 0.995 cosine (distance 0.005) over rotation-canonical
// fingerprints. A re-encoded or rotated re-send of the same photo scores
// ~0.999; two different photos of a similar tile score well below 0.99.
export const MERGE_DISTANCE = 0.005;
const ASSETS_PER_TICK = 12;
export async function dedupeTick(env) {
    const sb = db(env);
    const { data: batch, count } = await sb
        .from('assets')
        .select('id, visual, width, height, bytes, occurrence_count, first_seen_at, last_seen_at', {
        count: 'exact',
    })
        .is('dedup_at', null)
        .not('visual', 'is', null)
        .in('status', ['pending', 'ready'])
        .order('created_at', { ascending: true })
        .limit(ASSETS_PER_TICK);
    if (!batch?.length)
        return { checked: 0, merged: 0, remaining: 0 };
    let merged = 0;
    for (const asset of batch) {
        const { data: nn } = await sb.rpc('nearest_asset', {
            query_visual: asset.visual,
            exclude_id: asset.id,
        });
        const nearest = nn?.[0];
        if (nearest && nearest.distance <= MERGE_DISTANCE) {
            await mergePair(env, sb, asset.id, nearest.asset_id);
            merged++;
        }
        else {
            await sb.from('assets').update({ dedup_at: new Date().toISOString() }).eq('id', asset.id);
        }
    }
    return { checked: batch.length, merged, remaining: Math.max(0, (count ?? 0) - batch.length) };
}
// Merges two assets that hold the same picture. The higher-resolution copy
// survives (that is the one worth reusing in a quote or a listing); the other
// asset's threads, tags and counters move onto it, and its bytes are deleted.
export async function mergePair(env, sb, aId, bId) {
    const { data: pair } = await sb
        .from('assets')
        .select('id, r2_key, thumb_key, width, height, bytes, occurrence_count, first_seen_at, last_seen_at')
        .in('id', [aId, bId]);
    if (!pair || pair.length !== 2)
        return;
    const area = (x) => (x.width && x.height ? x.width * x.height : 0);
    const [keeper, dup] = area(pair[0]) !== area(pair[1])
        ? area(pair[0]) > area(pair[1])
            ? [pair[0], pair[1]]
            : [pair[1], pair[0]]
        : pair[0].bytes >= pair[1].bytes
            ? [pair[0], pair[1]]
            : [pair[1], pair[0]];
    // Move the email occurrences — this is what attaches the duplicate's
    // threads to the surviving image. ignoreDuplicates covers the case where
    // both copies were attached to the same message.
    const { data: occ } = await sb
        .from('asset_occurrences')
        .select('message_id, filename, is_inline')
        .eq('asset_id', dup.id);
    if (occ?.length) {
        await sb.from('asset_occurrences').upsert(occ.map((o) => ({ ...o, asset_id: keeper.id })), { onConflict: 'asset_id,message_id', ignoreDuplicates: true });
    }
    // Move tags the same way — a hand-tag on either copy belongs to the image.
    const { data: tags } = await sb
        .from('asset_tags')
        .select('tag_id, source, confidence, created_by')
        .eq('asset_id', dup.id);
    if (tags?.length) {
        await sb.from('asset_tags').upsert(tags.map((t) => ({ ...t, asset_id: keeper.id })), { onConflict: 'asset_id,tag_id,source', ignoreDuplicates: true });
    }
    const first = [keeper.first_seen_at, dup.first_seen_at].filter(Boolean).sort()[0] ?? keeper.first_seen_at;
    const last = [keeper.last_seen_at, dup.last_seen_at].filter(Boolean).sort().at(-1) ?? keeper.last_seen_at;
    await sb
        .from('assets')
        .update({
        occurrence_count: keeper.occurrence_count + dup.occurrence_count,
        first_seen_at: first,
        last_seen_at: last,
        // The keeper absorbed new threads; its dedup check stands.
        dedup_at: new Date().toISOString(),
    })
        .eq('id', keeper.id);
    // The space saving: the duplicate's bytes go, then its row (cascading its
    // occurrences, tags, analysis and search entries).
    await env.BUCKET.delete(dup.r2_key);
    if (dup.thumb_key)
        await env.BUCKET.delete(dup.thumb_key);
    await sb.from('assets').delete().eq('id', dup.id);
    await rebuildSearchRows(env, [keeper.id]);
}
