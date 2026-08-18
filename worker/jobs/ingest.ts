import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../lib/env'
import { db } from '../lib/db'
import { sha256Hex } from '../lib/crypto'
import * as gmail from '../lib/gmail'
import { classify, dimensions, isBoilerplate, store } from '../lib/images'

// Sized for the Workers PAID plan: 1000 subrequests per invocation. A stored
// image costs ~6-7 (download, dedupe check, insert, R2 put, thumbnail,
// occurrence, search row) and a thread ~3 of overhead, so 40 threads + 60
// images ≈ 550 subrequests — comfortable headroom. The binding constraint is
// now wall-clock: keep a tick's sequential downloads under the minute so
// ticks don't pile up on each other. The budget in ingestThread still lets an
// over-budget monster thread pause and resume next tick.
//
// If the account ever drops back to the free plan, these must return to
// 5 / 6 — the free ceiling is 50 subrequests, and 16/tick was measured to
// die mid-batch every single minute there.
const THREADS_PER_TICK = 40
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
    // Interrupted threads first. They can live on listing pages the cursor
    // has already passed — the page walk will never see them again, but their
    // Gmail ids are in our own table, so no listing is needed to redo them.
    const healed = await healIncomplete(env, sb, token)
    if (healed > 0) return { status: 'working', threads: healed }

    return await processPage(env, sb, run, token)
  } catch (err) {
    await fail(sb, run.id, String(err))
    return { status: 'error', message: String(err) }
  }
}

async function healIncomplete(env: Env, sb: SupabaseClient, token: string): Promise<number> {
  // Over-fetch and shuffle: with a stable ordering, one thread that fails
  // every time pins the same batch forever and the queue stops moving — which
  // is exactly what happened (5 healed in an hour). Randomising the pick
  // means a poison thread costs one slot per tick, not the whole queue.
  const { data: incomplete } = await sb
    .from('threads')
    .select('gmail_thread_id')
    .is('body_text', null)
    .limit(25)
  if (!incomplete?.length) return 0
  const batch = [...incomplete].sort(() => Math.random() - 0.5).slice(0, THREADS_PER_TICK)

  const budget = { downloads: MAX_ATTACHMENTS_PER_TICK }
  let healed = 0
  for (const row of batch) {
    if (budget.downloads <= 0) break
    try {
      await ingestThread(env, sb, token, row.gmail_thread_id, budget)
      healed++
    } catch (err) {
      // A thread deleted on Gmail since we first saw it 404s forever. Mark it
      // complete-and-empty so it stops blocking the heal queue.
      if (String(err).includes('-> 404')) {
        await sb
          .from('threads')
          .update({ body_text: '' })
          .eq('gmail_thread_id', row.gmail_thread_id)
        healed++
      }
      // Anything else (usually the subrequest ceiling): swallow and move on.
      // The thread stays incomplete and gets another chance next tick; work
      // already done inside it is kept and skipped cheaply on the retry.
    }
  }
  // Zero healed means every candidate failed this tick — return 0 so the tick
  // falls through to the page walk instead of wedging the whole run on a bad
  // batch.
  return healed
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
  // the threads that were in flight. Only COMPLETED threads count — body_text
  // is set as the last step of ingestThread, so a null there means the thread
  // died mid-ingest and must be done again.
  const { data: known } = await sb
    .from('threads')
    .select('gmail_thread_id')
    .not('body_text', 'is', null)
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
  const budget = { downloads: MAX_ATTACHMENTS_PER_TICK }
  for (const id of todo.slice(0, THREADS_PER_TICK)) {
    if (budget.downloads <= 0) break
    images += await ingestThread(env, sb, token, id, budget)
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

// budget.downloads is the shared per-invocation allowance of attachment
// downloads. A thread that exhausts it mid-way returns WITHOUT its completion
// marker, so the next tick resumes it — and the message-level skip below makes
// that resume cost one query per already-finished message instead of
// re-downloading everything.
export async function ingestThread(
  env: Env,
  sb: SupabaseClient,
  token: string,
  threadId: string,
  budget: { downloads: number } = { downloads: Infinity },
): Promise<number> {
  const thread = await gmail.getThread(token, threadId)
  const messages = thread.messages ?? []
  if (messages.length === 0) return 0

  const metas = messages.map((m) => gmail.messageMeta(m))
  const bodies = messages.map((m) => gmail.bodyText(m.payload))
  const dates = metas.map((m) => m.sentAt).filter(Boolean) as string[]
  const participants = [...new Set(metas.flatMap((m) => [m.from, ...m.to].filter(Boolean)))]

  // Two-phase write: the row goes in with body_text NULL (messages need the
  // foreign key), and body_text is set only after every message and image has
  // landed. body_text doubles as the completion marker — the skip-check in
  // processPage only trusts threads where it is non-null, so a tick that dies
  // mid-thread (the free plan's subrequest ceiling guarantees some will) gets
  // that thread re-ingested next tick instead of silently losing its images.
  const { data: threadRow, error: threadErr } = await sb
    .from('threads')
    .upsert(
      {
        gmail_thread_id: threadId,
        subject: metas[0].subject,
        participants,
        first_date: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        last_date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        body_text: null,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'gmail_thread_id' },
    )
    .select('id')
    .single()
  if (threadErr || !threadRow) throw new Error(`thread upsert: ${threadErr?.message}`)

  // Which messages already have every qualifying image recorded? Two queries
  // for the whole thread, so a resumed thread skips its finished messages at
  // almost no cost instead of re-downloading them.
  const { data: existingMsgs } = await sb
    .from('messages')
    .select('id, gmail_message_id')
    .eq('thread_id', threadRow.id)
  const msgIdByGmail = new Map(
    ((existingMsgs ?? []) as { id: string; gmail_message_id: string }[]).map((m) => [
      m.gmail_message_id,
      m.id,
    ]),
  )
  const { data: occRows } = await sb
    .from('asset_occurrences')
    .select('message_id')
    .in('message_id', [...msgIdByGmail.values(), '00000000-0000-0000-0000-000000000000'])
  const occCount = new Map<string, number>()
  for (const o of (occRows ?? []) as { message_id: string }[]) {
    occCount.set(o.message_id, (occCount.get(o.message_id) ?? 0) + 1)
  }

  let stored = 0
  let ranOutOfBudget = false
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const parts = gmail.imageParts(msg.payload).filter((p) => !p.size || p.size >= 25_000)

    // Already fully recorded on a previous pass — skip without any writes.
    const knownId = msgIdByGmail.get(msg.id)
    if (knownId && parts.length > 0 && (occCount.get(knownId) ?? 0) >= parts.length) continue
    if (knownId && parts.length === 0) continue

    if (budget.downloads < parts.length) {
      // Not enough allowance to finish this message this tick. Stop here with
      // no completion marker; the next tick picks the thread up again.
      ranOutOfBudget = true
      break
    }

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

    for (const part of parts) {
      const bytes = await gmail.getAttachment(token, msg.id, part.attachmentId)
      budget.downloads--
      if (await recordAttachment(env, sb, messageRow.id, part, bytes, metas[i].sentAt)) stored++
    }
  }

  if (ranOutOfBudget) return stored

  // Completion marker — only now does the skip-check treat this thread as done.
  const { error: doneErr } = await sb
    .from('threads')
    .update({ body_text: bodies.filter(Boolean).join('\n\n---\n\n').slice(0, 200_000) || '' })
    .eq('id', threadRow.id)
  if (doneErr) throw new Error(`thread completion: ${doneErr.message}`)

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
    return recordExisting(sb, existing, messageId, part, when)
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
    if (error?.code === '23505') {
      // Unique violation on sha256: a concurrent tick inserted this image
      // between our existence check and this insert. That tick owns the row;
      // re-read it and take the update path like any other duplicate. The R2
      // put above simply overwrote the same key with the same bytes.
      const { data: winner } = await sb
        .from('assets')
        .select('id, occurrence_count, first_seen_at, last_seen_at, status')
        .eq('sha256', sha)
        .single()
      if (!winner) throw new Error('asset vanished after duplicate-key race')
      return recordExisting(sb, winner, messageId, part, when)
    }
    if (error || !created) throw new Error(`asset insert: ${error?.message}`)
    assetId = created.id

    // A basic search row from what the email itself provides — filename,
    // subject, thread text. This is what makes an image findable before any
    // tagging has happened, manual or AI; both later rewrite this row with
    // richer content.
    if (!verdict.reject) {
      const { data: ctx } = await sb
        .from('messages')
        .select('threads(subject, body_text)')
        .eq('id', messageId)
        .maybeSingle()
      const thread = (ctx?.threads ?? null) as { subject: string | null; body_text: string | null } | null
      await sb.from('asset_search').upsert(
        {
          asset_id: assetId,
          content: [part.filename, thread?.subject, (thread?.body_text ?? '').slice(0, 4000)]
            .filter(Boolean)
            .join('\n'),
        },
        { onConflict: 'asset_id' },
      )
    }
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

  return true
}

// The duplicate path: bump counters, apply the boilerplate check, record the
// occurrence. Reached both by an ordinary re-send of a known image and by
// losing an insert race to a concurrent tick.
async function recordExisting(
  sb: SupabaseClient,
  existing: {
    id: string
    occurrence_count: number
    first_seen_at: string | null
    last_seen_at: string | null
    status: string
  },
  messageId: string,
  part: gmail.ImagePart,
  when: string,
): Promise<boolean> {
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

  await sb.from('asset_occurrences').upsert(
    {
      asset_id: existing.id,
      message_id: messageId,
      filename: part.filename,
      is_inline: part.isInline,
    },
    { onConflict: 'asset_id,message_id' },
  )

  return false
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
  const budget = { downloads: MAX_ATTACHMENTS_PER_TICK }
  for (const id of result.threadIds.slice(0, THREADS_PER_TICK)) {
    if (budget.downloads <= 0) break
    images += await ingestThread(env, sb, token, id, budget)
  }

  // Only advance the watermark once every thread it covered is ingested —
  // otherwise a mid-batch failure would skip the remainder permanently.
  if (result.threadIds.length <= THREADS_PER_TICK) {
    await sb.from('gmail_accounts').update({ history_id: result.historyId }).eq('id', account.id)
  }

  return { status: 'working', threads: result.threadIds.length, images }
}
