import { Hono } from 'hono';
import { bearer, db, userFromToken } from '../lib/db';
import { checkImageUrl, imageUrl, signState } from '../lib/sign';
import { connectUrl } from './auth';
import { embed } from '../lib/tagging';
import { ingestTick } from '../jobs/ingest';
import { tagTick } from '../jobs/tag';
import { FACETS } from '../../shared/vocab';
export const api = new Hono();
// Signed image URLs are the one unauthenticated route: the signature is the
// credential, it expires in an hour, and it grants exactly one object.
api.get('/img/:sha', async (c) => {
    const sha = c.req.param('sha');
    const variant = c.req.query('v') ?? 'orig';
    const ok = await checkImageUrl(sha, variant, c.req.query('e') ?? '', c.req.query('s') ?? '', c.env.TOKEN_KEY);
    if (!ok)
        return c.text('bad or expired signature', 403);
    const sb = db(c.env);
    const { data: asset } = await sb
        .from('assets')
        .select('r2_key, thumb_key, mime')
        .eq('sha256', sha)
        .maybeSingle();
    if (!asset)
        return c.notFound();
    const key = variant === 'thumb' && asset.thumb_key ? asset.thumb_key : asset.r2_key;
    const object = await c.env.BUCKET.get(key);
    if (!object)
        return c.notFound();
    return new Response(object.body, {
        headers: {
            'content-type': variant === 'thumb' && asset.thumb_key ? 'image/webp' : asset.mime,
            // Safe to cache hard: the key is a content hash, so the bytes behind it
            // can never change.
            'cache-control': 'private, max-age=3600, immutable',
        },
    });
});
api.use('*', async (c, next) => {
    const userId = await userFromToken(c.env, bearer(c.req.raw));
    if (!userId)
        return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', userId);
    await next();
});
api.get('/vocab', async (c) => {
    const { data } = await db(c.env).from('tags').select('id, facet, value').order('value');
    const byFacet = FACETS.map(({ key, label }) => ({
        key,
        label,
        values: (data ?? []).filter((t) => t.facet === key),
    }));
    return c.json({ facets: byFacet });
});
api.get('/search', async (c) => {
    const sb = db(c.env);
    const q = (c.req.query('q') ?? '').trim();
    const facets = (c.req.query('facets') ?? '').split(',').filter(Boolean);
    const page = Math.max(0, Number(c.req.query('page') ?? 0));
    const limit = 48;
    let ids;
    if (q) {
        const { data, error } = await sb.rpc('search_assets', {
            q,
            q_embedding: await embed(c.env, q),
            facets: facets.length ? facets : null,
            limit_n: limit,
            offset_n: page * limit,
        });
        if (error)
            return c.json({ error: error.message }, 500);
        ids = (data ?? []).map((r) => r.asset_id);
    }
    else {
        const { data, error } = await sb.rpc('browse_assets', {
            facets: facets.length ? facets : null,
            limit_n: limit,
            offset_n: page * limit,
        });
        if (error)
            return c.json({ error: error.message }, 500);
        ids = (data ?? []).map((r) => r.id);
    }
    return c.json({ results: await hydrate(c.env, ids) });
});
api.get('/assets/:id', async (c) => {
    const sb = db(c.env);
    const id = c.req.param('id');
    const { data: asset } = await sb.from('assets').select('*').eq('id', id).maybeSingle();
    if (!asset)
        return c.notFound();
    const [{ data: analysis }, { data: tags }, { data: occurrences }] = await Promise.all([
        sb.from('asset_analysis').select('*').eq('asset_id', id).maybeSingle(),
        sb.from('asset_tags').select('source, tag_id, tags(id, facet, value)').eq('asset_id', id),
        sb
            .from('asset_occurrences')
            .select('filename, is_inline, messages(from_addr, to_addrs, sent_at, threads(subject, body_text))')
            .eq('asset_id', id)
            .limit(20),
    ]);
    return c.json({
        asset: {
            ...asset,
            url: await imageUrl(asset.sha256, 'orig', c.env.TOKEN_KEY),
            // The embedding is a kilobyte of float noise to a browser. Everything
            // else on the analysis row is useful; this is not.
            embedding: undefined,
        },
        analysis: analysis ? { ...analysis, embedding: undefined } : null,
        tags: tags ?? [],
        occurrences: occurrences ?? [],
    });
});
api.post('/assets/:id/tags', async (c) => {
    const { tag_id } = await c.req.json();
    const { error } = await db(c.env)
        .from('asset_tags')
        .upsert({ asset_id: c.req.param('id'), tag_id, source: 'manual', created_by: c.get('userId') }, { onConflict: 'asset_id,tag_id,source' });
    if (error)
        return c.json({ error: error.message }, 400);
    return c.json({ ok: true });
});
api.delete('/assets/:id/tags/:tagId', async (c) => {
    await db(c.env)
        .from('asset_tags')
        .delete()
        .eq('asset_id', c.req.param('id'))
        .eq('tag_id', c.req.param('tagId'))
        .eq('source', 'manual');
    return c.json({ ok: true });
});
// Reversing a filter call — the reason every rejected asset keeps its bytes.
api.post('/assets/:id/status', async (c) => {
    const { status } = await c.req.json();
    const { error } = await db(c.env)
        .from('assets')
        .update({ status, reject_reason: status === 'ready' ? null : 'manual' })
        .eq('id', c.req.param('id'));
    if (error)
        return c.json({ error: error.message }, 400);
    return c.json({ ok: true });
});
api.get('/admin/status', async (c) => {
    const sb = db(c.env);
    const [account, run, counts] = await Promise.all([
        sb.from('gmail_accounts').select('email, connected_at, invalid_since, history_id').maybeSingle(),
        sb.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(1).maybeSingle(),
        countByStatus(sb),
    ]);
    return c.json({
        mailbox: c.env.MAILBOX,
        account: account.data,
        run: run.data,
        counts,
        configured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.ANTHROPIC_API_KEY),
    });
});
api.post('/admin/connect-url', async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID)
        return c.json({ error: 'GOOGLE_CLIENT_ID is not set' }, 400);
    const state = await signState(c.get('userId'), c.env.TOKEN_KEY);
    return c.json({ url: connectUrl(c.env, state) });
});
api.post('/admin/backfill', async (c) => {
    const sb = db(c.env);
    const { data: account } = await sb.from('gmail_accounts').select('id').maybeSingle();
    if (!account)
        return c.json({ error: 'no mailbox connected' }, 400);
    const { data: running } = await sb
        .from('sync_runs')
        .select('id')
        .eq('status', 'running')
        .maybeSingle();
    if (running)
        return c.json({ error: 'a run is already in progress' }, 409);
    const { data, error } = await sb
        .from('sync_runs')
        .insert({ account_id: account.id, kind: 'backfill' })
        .select()
        .single();
    if (error)
        return c.json({ error: error.message }, 500);
    return c.json({ run: data });
});
api.post('/admin/cancel', async (c) => {
    await db(c.env)
        .from('sync_runs')
        .update({ status: 'cancelled', finished_at: new Date().toISOString() })
        .eq('status', 'running');
    return c.json({ ok: true });
});
// Runs one batch immediately instead of waiting for the next cron tick. Useful
// when watching a fresh backfill start, and the only way to make progress in
// `wrangler dev`, where crons do not fire on their own.
api.post('/admin/tick', async (c) => {
    const ingest = await ingestTick(c.env);
    const tag = await tagTick(c.env);
    return c.json({ ingest, tag });
});
async function countByStatus(sb) {
    const statuses = ['pending', 'ready', 'rejected', 'suppressed'];
    const entries = await Promise.all(statuses.map(async (status) => {
        const { count } = await sb
            .from('assets')
            .select('id', { count: 'exact', head: true })
            .eq('status', status);
        return [status, count ?? 0];
    }));
    return Object.fromEntries(entries);
}
// Search returns ids in rank order; this refills them with what the grid needs
// without losing that order.
async function hydrate(env, ids) {
    if (!ids.length)
        return [];
    const sb = db(env);
    const [{ data: assets }, { data: analyses }] = await Promise.all([
        sb.from('assets').select('id, sha256, thumb_key, width, height, occurrence_count, last_seen_at').in('id', ids),
        sb.from('asset_analysis').select('asset_id, description, product_name, product_code, size_mm').in('asset_id', ids),
    ]);
    const byId = new Map((assets ?? []).map((a) => [a.id, a]));
    const analysisById = new Map((analyses ?? []).map((a) => [a.asset_id, a]));
    return Promise.all(ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(async (asset) => ({
        ...asset,
        analysis: analysisById.get(asset.id) ?? null,
        thumbUrl: await imageUrl(asset.sha256, asset.thumb_key ? 'thumb' : 'orig', env.TOKEN_KEY),
    })));
}
