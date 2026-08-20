import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../lib/env'
import { db } from '../lib/db'
import { visualFingerprint, toVectorLiteral } from '../lib/visual'

// Fingerprints assets stored before the visual column existed (or whose
// ingest-time attempt failed). Reads the original back from R2 — the binding
// re-renders it to 24x24, so the source format doesn't matter.
const ASSETS_PER_TICK = 25

export async function visualTick(env: Env): Promise<{ done: number; remaining: number }> {
  const sb: SupabaseClient = db(env)

  const { data: pending, count } = await sb
    .from('assets')
    .select('id, r2_key', { count: 'exact' })
    .is('visual', null)
    .in('status', ['pending', 'ready'])
    .limit(ASSETS_PER_TICK * 3)

  if (!pending?.length) return { done: 0, remaining: 0 }

  // Shuffled for the same reason the heal loop shuffles: an undecodable asset
  // must cost one slot per tick, not pin the whole batch forever.
  const batch = [...pending].sort(() => Math.random() - 0.5).slice(0, ASSETS_PER_TICK)

  let done = 0
  for (const asset of batch) {
    try {
      const object = await env.BUCKET.get(asset.r2_key)
      if (!object) continue
      const vec = await visualFingerprint(env, object.body as ReadableStream)
      await sb.from('assets').update({ visual: toVectorLiteral(vec) }).eq('id', asset.id)
      done++
    } catch {
      // Left null; retried on a later tick, deprioritised by the shuffle.
    }
  }

  return { done, remaining: Math.max(0, (count ?? 0) - done) }
}
