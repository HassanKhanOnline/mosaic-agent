import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../lib/env'
import { db } from '../lib/db'
import { sha256Hex } from '../lib/crypto'
import * as gmail from '../lib/gmail'
import { classify, dimensions, isBoilerplate, store } from '../lib/images'

// Sized so one cron tick finishes comfortably inside a Worker's budget. Threads
// vary wildly — a single thread can carry thirty photos — so the attachment cap
// is the real limit and the thread count is deliberately conservative.
const THREADS_PER_TICK = 8
const MAX_ATTACHMENTS_PER_TICK = 60

export interface TickResult {
  status: 'idle' | 'working' | 'done' | 'reconnect' | 'error'
  threads?: number
  images?: number
  message?: string
}

export async function ingestTick(env: Env): Promise<TickResult> {
  const sb = db(env)

  const { data: run } = await sb
    .from('sync_runs')
    .select('*')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!run) return { status: 'idle' }

  const { data: account } = await sb
    .from('gmail_accounts')
    .select('*')
    .eq('id', run.account_id)
    .single()

  if (!account) {
    await fail(sb, run.id, 'account row missing')
    return { status: 'error', message: 'account row missing' }
  }

  let token: string
  try {
    token = await gmail.accessToken(env, account.refresh_token)
  } catch (err) {
    if (err instanceof gmail.GmailAuthError) {
      // Not a failure of this run so much as of the connection. Leave the run
      // alive so it resumes from its checkpoint the moment someone reconnects.
      await sb
        .from('gmail_accounts')
        .update({ invalid_since: new Date().toISOString() })
        .eq('id', account.id)
      return { status: 'reconnect', message: String(err) }
    }
    throw err
  }

  if (account.invalid_since) {
    await sb.from('gmail_accounts').update({ invalid_since: null }).eq('id', account.id)
  }

  try {
    return await processPage(env, sb, run, token)
  } catch (err) {
    await fail(sb, run.id, String(err))
    return { status: 'error', message: String(err) }
  }
}

async function processPage(
  env: Env,
  sb: SupabaseClient,
  run: { id: string; account_id: string; page_token: string | null; threads_seen: number; images_stored: number },
  token: string,
): Promise<TickResult> {
  const page = await gmail.listThreads(token, run.page_token)
  const ids = (page.threads ?? []).map((t) => t.id)

  // Already-ingested threads are the resume mechanism: the page is re-listed
  // each tick and shrinks as its threads land, so a crash mid-page costs only
  // the threads that were in flight.
  const { data: known } = await sb
    .from('threads')
    .select('gmail_thread_id')
    .in('gmail_thread_id', ids.length ? ids : ['-'])
  const seen = new Set((known ?? []).map((r: { gmail_thread_id: string }) => r.gmail_thread_id))
  const todo = ids.filter((id) => !seen.has(id))

  if (todo.length === 0) {
    if (page.nextPageToken) {
      await sb.from('sync_runs').update({ page_token: page.nextPageToken }).eq('id', run.id)
      return { status: 'working', threads: run.threads_seen, images: run.images_stored }
    }
    await sb
      .from('sync_runs')
      .update({ status: 'done', finished_at: new Date().toISOString(), page_token: null })
      .eq('id', run.id)
    return { status: 'done', threads: run.threads_seen, images: run.images_stored }
  }

  let images = 0
  let threads = 0
  for (const id of todo.slice(0, THREADS_PER_TICK)) {
    if (images >= MAX_ATTACHMENTS_PER_TICK) break
    images += await ingestThread(env, sb, token, id)
    threads++
  }

  await sb
    .from('sync_runs')
    .update({
      threads_seen: run.threads_seen + threads,
      images_stored: run.images_stored + images,
    })
    .eq('id', run.id)

  return {
    status: 'working',
    threads: run.threads_seen + threads,
    images: run.images_stored + images,
  }
}

export async function ingestThread(
  env: Env,
  sb: SupabaseClient,
  token: string,
  threadId: string,
): Promise<number> {
  const thread = await gmail.getThread(token, threadId)
  const messages = thread.messages ?? []
  if (messages.length === 0) return 0

  const metas = messages.map((m) => gmail.messageMeta(m))
  const bodies = messages.map((m) => gmail.bodyText(m.payload))
  const dates = metas.map((m) => m.sentAt).filter(Boolean) as string[]
  const participants = [...new Set(metas.flatMap((m) => [m.from, ...m.to].filter(Boolean)))]

  const { data: threadRow, error: threadErr } = await sb
    .from('threads')
    .upsert(
      {
        gmail_thread_id: threadId,
        subject: metas[0].subject,
        participants,
        first_date: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        last_date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        body_text: bodies.filter(Boolean).join('\n\n---\n\n').slice(0, 200_000),
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'gmail_thread_id' },
    )
    .select('id')
    .single()
  if (threadErr || !threadRow) throw new Error(`thread upsert: ${threadErr?.message}`)

  let stored = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const { data: messageRow, error: msgErr } = await sb
      .from('messages')
      .upsert(
        {
          thread_id: threadRow.id,
          gmail_message_id: msg.id,
          from_addr: metas[i].from,
          to_addrs: metas[i].to,
          sent_at: metas[i].sentAt,
          body_text: bodies[i]?.slice(0, 100_000) || null,
        },
        { onConflict: 'gmail_message_id' },
      )
      .select('id')
      .single()
    if (msgErr || !messageRow) throw new Error(`message upsert: ${msgErr?.message}`)

    for (const part of gmail.imageParts(msg.payload)) {
      // The size filter runs before the download, not after — the cheapest way
      // to skip a signature logo is to never fetch it.
      if (part.size && part.size < 25_000) continue
      const bytes = await gmail.getAttachment(token, msg.id, part.attachmentId)
      if (await recordAttachment(env, sb, messageRow.id, part, bytes, metas[i].sentAt)) stored++
    }
  }
  return stored
}

async function recordAttachment(
  env: Env,
  sb: SupabaseClient,
  messageId: string,
  part: gmail.ImagePart,
  bytes: Uint8Array,
  sentAt: string | null,
): Promise<boolean> {
  const sha = await sha256Hex(bytes)
  const when = sentAt ?? new Date().toISOString()

  const { data: existing } = await sb
    .from('assets')
    .select('id, occurrence_count, first_seen_at, last_seen_at, status')
    .eq('sha256', sha)
    .maybeSingle()

  let assetId: string

  if (existing) {
    const first = existing.first_seen_at && existing.first_seen_at < when ? existing.first_seen_at : when
    const last = existing.last_seen_at && existing.last_seen_at > when ? existing.last_seen_at : when
    const count = existing.occurrence_count + 1
    const boilerplate = isBoilerplate(count, first, last)
    await sb
      .from('assets')
      .update({
        occurrence_count: count,
        first_seen_at: first,
        last_seen_at: last,
        // Suppression is reversible and only ever applied to an asset that has
        // not already been rejected for another reason.
        ...(boilerplate && existing.status !== 'rejected'
          ? { status: 'suppressed', reject_reason: 'boilerplate' }
          : {}),
      })
      .eq('id', existing.id)
    assetId = existing.id
  } else {
    const dims = dimensions(bytes)
    const verdict = classify(bytes.length, dims)
    // Rejected images are still stored. A wrong threshold should be a setting
    // to change and re-run, not a photo we threw away.
    const { key, thumb } = await store(env, sha, bytes, part.mimeType)
    const { data: created, error } = await sb
      .from('assets')
      .insert({
        sha256: sha,
        r2_key: key,
        thumb_key: thumb,
        mime: part.mimeType,
        bytes: bytes.length,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        status: verdict.reject ? 'rejected' : 'pending',
        reject_reason: verdict.reject,
        occurrence_count: 1,
        first_seen_at: when,
        last_seen_at: when,
      })
      .select('id')
      .single()
    if (error || !created) throw new Error(`asset insert: ${error?.message}`)
    assetId = created.id
  }

  await sb.from('asset_occurrences').upsert(
    {
      asset_id: assetId,
      message_id: messageId,
      filename: part.filename,
      is_inline: part.isInline,
    },
    { onConflict: 'asset_id,message_id' },
  )

  return !existing
}

async function fail(sb: SupabaseClient, runId: string, message: string) {
  await sb
    .from('sync_runs')
    .update({ status: 'failed', error: message.slice(0, 2000), finished_at: new Date().toISOString() })
    .eq('id', runId)
}

// Incremental sync. Runs off the historyId watermark; if Gmail has aged that
// watermark out, starts a fresh backfill instead of silently skipping mail.
export async function incrementalTick(env: Env): Promise<TickResult> {
  const sb = db(env)

  const { data: running } = await sb
    .from('sync_runs')
    .select('id')
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()
  if (running) return { status: 'working', message: 'backfill in progress' }

  const { data: account } = await sb
    .from('gmail_accounts')
    .select('*')
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()
  if (!account?.history_id) return { status: 'idle' }

  let token: string
  try {
    token = await gmail.accessToken(env, account.refresh_token)
  } catch (err) {
    if (err instanceof gmail.GmailAuthError) {
      await sb
        .from('gmail_accounts')
        .update({ invalid_since: new Date().toISOString() })
        .eq('id', account.id)
      return { status: 'reconnect', message: String(err) }
    }
    throw err
  }

  const result = await gmail.threadsSince(token, account.history_id)
  if (result === 'expired') {
    const profile = await gmail.getProfile(token)
    await sb.from('gmail_accounts').update({ history_id: profile.historyId }).eq('id', account.id)
    await sb.from('sync_runs').insert({ account_id: account.id, kind: 'backfill' })
    return { status: 'working', message: 'history expired, restarted backfill' }
  }

  let images = 0
  for (const id of result.threadIds.slice(0, THREADS_PER_TICK)) {
    images += await ingestThread(env, sb, token, id)
  }

  // Only advance the watermark once every thread it covered is ingested —
  // otherwise a mid-batch failure would skip the remainder permanently.
  if (result.threadIds.length <= THREADS_PER_TICK) {
    await sb.from('gmail_accounts').update({ history_id: result.historyId }).eq('id', account.id)
  }

  return { status: 'working', threads: result.threadIds.length, images }
}
