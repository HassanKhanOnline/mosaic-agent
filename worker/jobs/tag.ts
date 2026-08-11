import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../lib/env'
import { db } from '../lib/db'
import { MODEL, canTag, embed, searchContent, tagImage, type Vocabulary } from '../lib/tagging'
import { NOT_A_TILE } from '../../shared/vocab'

// Vision calls dominate the wall-clock here, so the batch is small and the cron
// is frequent rather than the other way round.
const ASSETS_PER_TICK = 4

export async function tagTick(env: Env): Promise<{ tagged: number; remaining: number }> {
  // No key, no AI tagging — and crucially, no failing. Without this guard the
  // loop below would burn through every pending asset marking it rejected
  // ("tagging_failed: missing api key"), which reads as the library silently
  // emptying. Manual-first is a supported mode: assets stay pending, visible
  // and hand-taggable, until a key appears and the backlog drains itself.
  if (!env.ANTHROPIC_API_KEY) return { tagged: 0, remaining: -1 }

  const sb = db(env)

  const { data: pending, count } = await sb
    .from('assets')
    .select('id, sha256, r2_key, mime', { count: 'exact' })
    .eq('status', 'pending')
    .order('last_seen_at', { ascending: false })
    .limit(ASSETS_PER_TICK)

  if (!pending?.length) return { tagged: 0, remaining: 0 }

  const vocab = await loadVocabulary(sb)
  let tagged = 0
  for (const asset of pending) {
    try {
      await tagAsset(env, sb, asset, vocab)
      tagged++
    } catch (err) {
      // One bad image must not wedge the queue. Park it as rejected with the
      // reason recorded, so it shows up in the admin rather than being retried
      // forever.
      await sb
        .from('assets')
        .update({ status: 'rejected', reject_reason: `tagging_failed: ${String(err).slice(0, 200)}` })
        .eq('id', asset.id)
    }
  }

  return { tagged, remaining: Math.max(0, (count ?? 0) - tagged) }
}

async function tagAsset(
  env: Env,
  sb: SupabaseClient,
  asset: { id: string; sha256: string; r2_key: string; mime: string },
  vocab: Vocabulary,
) {
  if (!canTag(asset.mime)) {
    await sb
      .from('assets')
      .update({ status: 'rejected', reject_reason: `unsupported_mime: ${asset.mime}` })
      .eq('id', asset.id)
    return
  }

  const object = await env.BUCKET.get(asset.r2_key)
  if (!object) throw new Error(`missing from R2: ${asset.r2_key}`)
  const bytes = new Uint8Array(await object.arrayBuffer())

  const context = await threadContext(sb, asset.id)
  const result = await tagImage(env, { bytes, mime: asset.mime }, context, vocab)

  // The reject gate. Everything else about this asset is still written, so a
  // wrong call can be reversed by flipping status back to 'ready'.
  if (result.shot_type === NOT_A_TILE) {
    await sb
      .from('assets')
      .update({ status: 'rejected', reject_reason: 'not_a_tile' })
      .eq('id', asset.id)
    return
  }

  const content = searchContent(result, context)
  const embedding = await embed(env, content)

  await sb.from('asset_analysis').upsert(
    {
      asset_id: asset.id,
      model: MODEL,
      description: result.description,
      product_name: result.product_name,
      product_code: result.product_code,
      size_mm: result.size_mm,
      attrs: result as unknown as Record<string, unknown>,
      embedding,
    },
    { onConflict: 'asset_id,model' },
  )

  await writeTags(sb, asset.id, result as unknown as Record<string, unknown>)
  await sb.from('asset_search').upsert({ asset_id: asset.id, content }, { onConflict: 'asset_id' })
  await sb.from('assets').update({ status: 'ready', reject_reason: null }).eq('id', asset.id)
}

async function writeTags(sb: SupabaseClient, assetId: string, result: Record<string, unknown>) {
  const { data: tags } = await sb.from('tags').select('id, facet, value')
  const lookup = new Map((tags ?? []).map((t: { id: string; facet: string; value: string }) => [`${t.facet}::${t.value}`, t.id]))

  const rows: { asset_id: string; tag_id: string; source: string }[] = []
  for (const [facet, value] of Object.entries(result)) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    for (const v of values) {
      const id = lookup.get(`${facet}::${v}`)
      // A value outside the vocabulary is dropped rather than inserted. The
      // schema would reject it anyway, and silently widening the vocabulary
      // from model output is exactly the drift the fixed list prevents.
      if (id) rows.push({ asset_id: assetId, tag_id: id, source: 'ai' })
    }
  }

  // Replace this model's tags wholesale so a re-tag doesn't leave stale ones
  // behind. Manual tags are untouched — they outrank the model by design.
  await sb.from('asset_tags').delete().eq('asset_id', assetId).eq('source', 'ai')
  if (rows.length) await sb.from('asset_tags').insert(rows)
}

// The email context the tagger reads. Takes the thread the image first appeared
// in — if the same photo was mailed forty times, the first thread is the one
// most likely to have named the product.
async function threadContext(
  sb: SupabaseClient,
  assetId: string,
): Promise<{ subject: string | null; threadText: string | null; filename: string | null }> {
  const { data } = await sb
    .from('asset_occurrences')
    .select('filename, messages(sent_at, threads(subject, body_text))')
    .eq('asset_id', assetId)
    .limit(1)
    .maybeSingle()

  const message = data?.messages as
    | { threads?: { subject: string | null; body_text: string | null } }
    | undefined
  return {
    filename: data?.filename ?? null,
    subject: message?.threads?.subject ?? null,
    threadText: message?.threads?.body_text ?? null,
  }
}

export async function loadVocabulary(sb: SupabaseClient): Promise<Vocabulary> {
  const { data } = await sb.from('tags').select('facet, value')
  const vocab: Vocabulary = {}
  for (const row of (data ?? []) as { facet: string; value: string }[]) {
    ;(vocab[row.facet] ??= []).push(row.value)
  }
  return vocab
}
