import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../lib/env'
import { db } from '../lib/db'
import { toVectorLiteral } from '../lib/visual'
import { processImage } from '../lib/pixels'
import { thumbKey } from '../lib/images'

// Fingerprints assets stored before the visual column existed (or whose
// ingest-time attempt failed), and restores thumbnails lost to the Images
// quota outage while it's there. Decoding happens in-Worker via Photon; the
// batch is CPU-sized — a 12MP decode costs a few hundred ms, and the paid
// plan allows 30s CPU per invocation.
const ASSETS_PER_TICK = 30

export async function visualTick(env: Env): Promise<{ done: number; remaining: number }> {
  const sb: SupabaseClient = db(env)

  const { data: pending, count } = await sb
    .from('assets')
    .select('id, r2_key, thumb_key, sha256', { count: 'exact' })
    .is('visual', null)
    .in('status', ['pending', 'ready'])
    .limit(ASSETS_PER_TICK * 3)

  if (!pending?.length) return { done: 0, remaining: 0 }

  // Shuffled for the same reason the heal loop shuffles: an undecodable asset
  // must cost one slot per tick, not pin the whole batch forever.
  const batch = [...pending].sort(() => Math.random() - 0.5).slice(0, ASSETS_PER_TICK)

  let done = 0
  let firstError: string | null = null
  for (const asset of batch) {
    try {
      const object = await env.BUCKET.get(asset.r2_key)
      if (!object) continue
      // One R2 read, one decode: fingerprint always, replacement thumbnail
      // whenever the ingest-time one is missing.
      const bytes = new Uint8Array(await object.arrayBuffer())
      const { fingerprint, thumb: thumbBytes } = processImage(bytes, !asset.thumb_key)

      let thumb: string | null = asset.thumb_key
      if (!thumb && thumbBytes) {
        thumb = thumbKey(asset.sha256)
        await env.BUCKET.put(thumb, thumbBytes as unknown as ArrayBuffer, {
          httpMetadata: { contentType: 'image/jpeg' },
        })
      }

      const { error } = await sb
        .from('assets')
        .update({ visual: toVectorLiteral(fingerprint), thumb_key: thumb })
        .eq('id', asset.id)
      if (error) throw new Error(`update: ${error.message}`)
      done++
    } catch (err) {
      // Left null; retried on a later tick, deprioritised by the shuffle. The
      // first failure per tick is logged — a batch that fails wholesale would
      // otherwise be indistinguishable from one that never ran.
      if (!firstError) {
        firstError = String(err).slice(0, 300)
        console.log('visual error sample:', firstError)
      }
    }
  }

  return { done, remaining: Math.max(0, (count ?? 0) - done) }
}
