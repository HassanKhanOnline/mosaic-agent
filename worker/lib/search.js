import { db } from './db';
// The search row is the union of everything known about the asset — manual
// tags, AI analysis if it exists, and the email's own words. Rebuilt whole on
// every change rather than patched, because "recompute from source" cannot
// drift the way incremental edits do. Batched to a fixed number of queries
// regardless of asset count.
export async function rebuildSearchRows(env, assetIds) {
    if (!assetIds.length)
        return;
    const sb = db(env);
    const [{ data: tags }, { data: analyses }, { data: occurrences }] = await Promise.all([
        sb.from('asset_tags').select('asset_id, tags(value)').in('asset_id', assetIds),
        sb
            .from('asset_analysis')
            .select('asset_id, description, product_name, product_code, size_mm')
            .in('asset_id', assetIds),
        sb
            .from('asset_occurrences')
            .select('asset_id, filename, messages(threads(subject, body_text))')
            .in('asset_id', assetIds),
    ]);
    const tagsById = new Map();
    for (const t of (tags ?? [])) {
        if (t.tags?.value)
            (tagsById.get(t.asset_id) ?? tagsById.set(t.asset_id, []).get(t.asset_id)).push(t.tags.value);
    }
    const analysisById = new Map((analyses ?? []).map((a) => [a.asset_id, a]));
    const occById = new Map();
    for (const o of (occurrences ?? [])) {
        if (!occById.has(o.asset_id))
            occById.set(o.asset_id, o);
    }
    const rows = assetIds.map((id) => {
        const analysis = analysisById.get(id);
        const occ = occById.get(id);
        const thread = occ?.messages?.threads;
        return {
            asset_id: id,
            content: [
                analysis?.description,
                analysis?.product_name,
                analysis?.product_code,
                analysis?.size_mm,
                (tagsById.get(id) ?? []).join(' '),
                occ?.filename,
                thread?.subject,
                (thread?.body_text ?? '').slice(0, 4000),
            ]
                .filter(Boolean)
                .join('\n'),
        };
    });
    await sb.from('asset_search').upsert(rows, { onConflict: 'asset_id' });
}
