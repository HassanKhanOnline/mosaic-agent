import { db } from '../lib/db';
import { sha256Hex } from '../lib/crypto';
import * as gmail from '../lib/gmail';
import { classify, dimensions, isBoilerplate, store } from '../lib/images';
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
const THREADS_PER_TICK = 40;
const MAX_ATTACHMENTS_PER_TICK = 60;
// The tick is split into two independent jobs, and the split is the whole
// design. LISTING is cheap and must never repeat a page: claim the current
// page by writing stub thread rows and advancing the cursor immediately.
// INGESTING is expensive and resumable: the heal loop drains stub and
// interrupted threads under the download budget, in random order, surviving
// any mid-thread death. The old shape — ingest inline, advance cursor at the
// end — meant a slow tick and the next cron overlapped on the SAME page and
// spent the minute duplicating each other's work.
export async function ingestTick(env) {
    const sb = db(env);
    const { data: account } = await sb
        .from('gmail_accounts')
        .select('*')
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle();
    if (!account)
        return { status: 'idle' };
    const { data: run } = await sb
        .from('sync_runs')
        .select('*')
        .eq('status', 'running')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    // Anything left to do at all?
    const { count: stubCount } = await sb
        .from('threads')
        .select('id', { count: 'exact', head: true })
        .is('body_text', null);
    if (!run && !stubCount)
        return { status: 'idle' };
    let token;
    try {
        token = await gmail.accessToken(env, account.refresh_token);
    }
    catch (err) {
        if (err instanceof gmail.GmailAuthError) {
            await sb
                .from('gmail_accounts')
                .update({ invalid_since: new Date().toISOString() })
                .eq('id', account.id);
            return { status: 'reconnect', message: String(err) };
        }
        throw err;
    }
    if (account.invalid_since) {
        await sb.from('gmail_accounts').update({ invalid_since: null }).eq('id', account.id);
    }
    try {
        // Claim first: 3-4 subrequests, never blocked by ingestion.
        if (run)
            await claimPage(sb, run, token, stubCount ?? 0);
        // Then ingest under the budget for the rest of the tick.
        const healed = await healIncomplete(env, sb, token);
        return { status: 'working', threads: healed, message: `queue ${stubCount ?? 0}` };
    }
    catch (err) {
        if (run)
            await fail(sb, run.id, String(err));
        return { status: 'error', message: String(err) };
    }
}
// Lists ONE page, writes stub rows for unseen threads (body_text null, which
// marks them for the heal loop), advances the cursor. The run is only marked
// done when the listing is exhausted AND the queue has drained.
async function claimPage(sb, run, token, queueDepth) {
    // Don't let the unprocessed backlog grow without bound if listing outpaces
    // ingestion for hours — pause claiming until the queue comes back down.
    if (queueDepth > 2000)
        return;
    const page = await gmail.listThreads(token, run.page_token);
    const ids = (page.threads ?? []).map((t) => t.id);
    if (ids.length) {
        // ignoreDuplicates so completed threads keep their body_text; only truly
        // new ids get stub rows.
        await sb.from('threads').upsert(ids.map((id) => ({ gmail_thread_id: id, body_text: null })), { onConflict: 'gmail_thread_id', ignoreDuplicates: true });
    }
    if (page.nextPageToken) {
        await sb
            .from('sync_runs')
            .update({ page_token: page.nextPageToken, threads_seen: run.threads_seen + ids.length })
            .eq('id', run.id);
        return;
    }
    // Listing exhausted (the final page has threads but no next token). The run
    // is marked done once the pre-claim queue was empty; any stubs this very
    // tick created still drain afterwards — ingestTick heals run-less too.
    if (queueDepth === 0) {
        await sb
            .from('sync_runs')
            .update({ status: 'done', finished_at: new Date().toISOString(), page_token: null })
            .eq('id', run.id);
    }
}
async function healIncomplete(env, sb, token) {
    // Over-fetch and shuffle: with a stable ordering, one thread that fails
    // every time pins the same batch forever and the queue stops moving — which
    // is exactly what happened (5 healed in an hour). Randomising the pick
    // means a poison thread costs one slot per tick, not the whole queue.
    const { data: incomplete } = await sb
        .from('threads')
        .select('gmail_thread_id')
        .is('body_text', null)
        .limit(THREADS_PER_TICK * 3);
    if (!incomplete?.length)
        return 0;
    const batch = [...incomplete].sort(() => Math.random() - 0.5).slice(0, THREADS_PER_TICK);
    const budget = { downloads: MAX_ATTACHMENTS_PER_TICK };
    let healed = 0;
    for (const row of batch) {
        if (budget.downloads <= 0)
            break;
        try {
            await ingestThread(env, sb, token, row.gmail_thread_id, budget);
            healed++;
        }
        catch (err) {
            // A thread deleted on Gmail since we first saw it 404s forever. Mark it
            // complete-and-empty so it stops blocking the heal queue.
            if (String(err).includes('-> 404')) {
                await sb
                    .from('threads')
                    .update({ body_text: '' })
                    .eq('gmail_thread_id', row.gmail_thread_id);
                healed++;
            }
            // Anything else (usually the subrequest ceiling): swallow and move on.
            // The thread stays incomplete and gets another chance next tick; work
            // already done inside it is kept and skipped cheaply on the retry.
        }
    }
    return healed;
}
// budget.downloads is the shared per-invocation allowance of attachment
// downloads. A thread that exhausts it mid-way returns WITHOUT its completion
// marker, so the next tick resumes it — and the message-level skip below makes
// that resume cost one query per already-finished message instead of
// re-downloading everything.
export async function ingestThread(env, sb, token, threadId, budget = { downloads: Infinity }) {
    const thread = await gmail.getThread(token, threadId);
    const messages = thread.messages ?? [];
    if (messages.length === 0)
        return 0;
    const metas = messages.map((m) => gmail.messageMeta(m));
    const bodies = messages.map((m) => gmail.bodyText(m.payload));
    const dates = metas.map((m) => m.sentAt).filter(Boolean);
    const participants = [...new Set(metas.flatMap((m) => [m.from, ...m.to].filter(Boolean)))];
    // Two-phase write: the row goes in with body_text NULL (messages need the
    // foreign key), and body_text is set only after every message and image has
    // landed. body_text doubles as the completion marker — the skip-check in
    // processPage only trusts threads where it is non-null, so a tick that dies
    // mid-thread (the free plan's subrequest ceiling guarantees some will) gets
    // that thread re-ingested next tick instead of silently losing its images.
    const { data: threadRow, error: threadErr } = await sb
        .from('threads')
        .upsert({
        gmail_thread_id: threadId,
        subject: metas[0].subject,
        participants,
        first_date: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        last_date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        body_text: null,
        fetched_at: new Date().toISOString(),
    }, { onConflict: 'gmail_thread_id' })
        .select('id')
        .single();
    if (threadErr || !threadRow)
        throw new Error(`thread upsert: ${threadErr?.message}`);
    // Which messages already have every qualifying image recorded? Two queries
    // for the whole thread, so a resumed thread skips its finished messages at
    // almost no cost instead of re-downloading them.
    const { data: existingMsgs } = await sb
        .from('messages')
        .select('id, gmail_message_id')
        .eq('thread_id', threadRow.id);
    const msgIdByGmail = new Map((existingMsgs ?? []).map((m) => [
        m.gmail_message_id,
        m.id,
    ]));
    const { data: occRows } = await sb
        .from('asset_occurrences')
        .select('message_id')
        .in('message_id', [...msgIdByGmail.values(), '00000000-0000-0000-0000-000000000000']);
    const occCount = new Map();
    for (const o of (occRows ?? [])) {
        occCount.set(o.message_id, (occCount.get(o.message_id) ?? 0) + 1);
    }
    let stored = 0;
    let ranOutOfBudget = false;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const parts = gmail.imageParts(msg.payload).filter((p) => !p.size || p.size >= 25_000);
        // Already fully recorded on a previous pass — skip without any writes.
        const knownId = msgIdByGmail.get(msg.id);
        if (knownId && parts.length > 0 && (occCount.get(knownId) ?? 0) >= parts.length)
            continue;
        if (knownId && parts.length === 0)
            continue;
        if (budget.downloads < parts.length) {
            // Not enough allowance to finish this message this tick. Stop here with
            // no completion marker; the next tick picks the thread up again.
            ranOutOfBudget = true;
            break;
        }
        const { data: messageRow, error: msgErr } = await sb
            .from('messages')
            .upsert({
            thread_id: threadRow.id,
            gmail_message_id: msg.id,
            from_addr: metas[i].from,
            to_addrs: metas[i].to,
            sent_at: metas[i].sentAt,
            body_text: bodies[i]?.slice(0, 100_000) || null,
        }, { onConflict: 'gmail_message_id' })
            .select('id')
            .single();
        if (msgErr || !messageRow)
            throw new Error(`message upsert: ${msgErr?.message}`);
        for (const part of parts) {
            const bytes = await gmail.getAttachment(token, msg.id, part.attachmentId);
            budget.downloads--;
            if (await recordAttachment(env, sb, messageRow.id, part, bytes, metas[i].sentAt))
                stored++;
        }
    }
    if (ranOutOfBudget)
        return stored;
    // Completion marker — only now does the skip-check treat this thread as done.
    const { error: doneErr } = await sb
        .from('threads')
        .update({ body_text: bodies.filter(Boolean).join('\n\n---\n\n').slice(0, 200_000) || '' })
        .eq('id', threadRow.id);
    if (doneErr)
        throw new Error(`thread completion: ${doneErr.message}`);
    return stored;
}
async function recordAttachment(env, sb, messageId, part, bytes, sentAt) {
    const sha = await sha256Hex(bytes);
    const when = sentAt ?? new Date().toISOString();
    const { data: existing } = await sb
        .from('assets')
        .select('id, occurrence_count, first_seen_at, last_seen_at, status')
        .eq('sha256', sha)
        .maybeSingle();
    let assetId;
    if (existing) {
        return recordExisting(sb, existing, messageId, part, when);
    }
    else {
        const dims = dimensions(bytes);
        const verdict = classify(bytes.length, dims);
        // Visual fingerprint, computed BEFORE anything is stored: it doubles as
        // the near-duplicate check. Failure-tolerant — a format the pipeline
        // can't fingerprint leaves the column null and the visual tick retries.
        let visual = null;
        try {
            const { visualFingerprint, toVectorLiteral } = await import('../lib/visual');
            visual = toVectorLiteral(await visualFingerprint(env, new Response(bytes).body));
        }
        catch {
            visual = null;
        }
        // The same picture re-encoded or rotated by a forward hashes differently
        // but fingerprints identically. If a near-exact copy already exists,
        // attach this occurrence to it and store nothing — the space saving
        // happens here, before any bytes land in R2.
        if (visual && !verdict.reject) {
            const { MERGE_DISTANCE } = await import('./dedupe');
            const { data: nn } = await sb.rpc('nearest_asset', { query_visual: visual, exclude_id: null });
            const nearest = nn?.[0];
            if (nearest && nearest.distance <= MERGE_DISTANCE) {
                const { data: match } = await sb
                    .from('assets')
                    .select('id, occurrence_count, first_seen_at, last_seen_at, status')
                    .eq('id', nearest.asset_id)
                    .single();
                if (match)
                    return recordExisting(sb, match, messageId, part, when);
            }
        }
        // Rejected images are still stored. A wrong threshold should be a setting
        // to change and re-run, not a photo we threw away.
        const { key, thumb } = await store(env, sha, bytes, part.mimeType);
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
            visual,
        })
            .select('id')
            .single();
        if (error?.code === '23505') {
            // Unique violation on sha256: a concurrent tick inserted this image
            // between our existence check and this insert. That tick owns the row;
            // re-read it and take the update path like any other duplicate. The R2
            // put above simply overwrote the same key with the same bytes.
            const { data: winner } = await sb
                .from('assets')
                .select('id, occurrence_count, first_seen_at, last_seen_at, status')
                .eq('sha256', sha)
                .single();
            if (!winner)
                throw new Error('asset vanished after duplicate-key race');
            return recordExisting(sb, winner, messageId, part, when);
        }
        if (error || !created)
            throw new Error(`asset insert: ${error?.message}`);
        assetId = created.id;
        // A basic search row from what the email itself provides — filename,
        // subject, thread text. This is what makes an image findable before any
        // tagging has happened, manual or AI; both later rewrite this row with
        // richer content.
        if (!verdict.reject) {
            const { data: ctx } = await sb
                .from('messages')
                .select('threads(subject, body_text)')
                .eq('id', messageId)
                .maybeSingle();
            const thread = (ctx?.threads ?? null);
            await sb.from('asset_search').upsert({
                asset_id: assetId,
                content: [part.filename, thread?.subject, (thread?.body_text ?? '').slice(0, 4000)]
                    .filter(Boolean)
                    .join('\n'),
            }, { onConflict: 'asset_id' });
        }
    }
    await sb.from('asset_occurrences').upsert({
        asset_id: assetId,
        message_id: messageId,
        filename: part.filename,
        is_inline: part.isInline,
    }, { onConflict: 'asset_id,message_id' });
    return true;
}
// The duplicate path: bump counters, apply the boilerplate check, record the
// occurrence. Reached both by an ordinary re-send of a known image and by
// losing an insert race to a concurrent tick.
async function recordExisting(sb, existing, messageId, part, when) {
    const first = existing.first_seen_at && existing.first_seen_at < when ? existing.first_seen_at : when;
    const last = existing.last_seen_at && existing.last_seen_at > when ? existing.last_seen_at : when;
    const count = existing.occurrence_count + 1;
    const boilerplate = isBoilerplate(count, first, last);
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
        .eq('id', existing.id);
    await sb.from('asset_occurrences').upsert({
        asset_id: existing.id,
        message_id: messageId,
        filename: part.filename,
        is_inline: part.isInline,
    }, { onConflict: 'asset_id,message_id' });
    return false;
}
async function fail(sb, runId, message) {
    await sb
        .from('sync_runs')
        .update({ status: 'failed', error: message.slice(0, 2000), finished_at: new Date().toISOString() })
        .eq('id', runId);
}
// Incremental sync. Runs off the historyId watermark; if Gmail has aged that
// watermark out, starts a fresh backfill instead of silently skipping mail.
export async function incrementalTick(env) {
    const sb = db(env);
    const { data: running } = await sb
        .from('sync_runs')
        .select('id')
        .eq('status', 'running')
        .limit(1)
        .maybeSingle();
    if (running)
        return { status: 'working', message: 'backfill in progress' };
    const { data: account } = await sb
        .from('gmail_accounts')
        .select('*')
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle();
    if (!account?.history_id)
        return { status: 'idle' };
    let token;
    try {
        token = await gmail.accessToken(env, account.refresh_token);
    }
    catch (err) {
        if (err instanceof gmail.GmailAuthError) {
            await sb
                .from('gmail_accounts')
                .update({ invalid_since: new Date().toISOString() })
                .eq('id', account.id);
            return { status: 'reconnect', message: String(err) };
        }
        throw err;
    }
    const result = await gmail.threadsSince(token, account.history_id);
    if (result === 'expired') {
        const profile = await gmail.getProfile(token);
        await sb.from('gmail_accounts').update({ history_id: profile.historyId }).eq('id', account.id);
        await sb.from('sync_runs').insert({ account_id: account.id, kind: 'backfill' });
        return { status: 'working', message: 'history expired, restarted backfill' };
    }
    let images = 0;
    const budget = { downloads: MAX_ATTACHMENTS_PER_TICK };
    for (const id of result.threadIds.slice(0, THREADS_PER_TICK)) {
        if (budget.downloads <= 0)
            break;
        images += await ingestThread(env, sb, token, id, budget);
    }
    // Only advance the watermark once every thread it covered is ingested —
    // otherwise a mid-batch failure would skip the remainder permanently.
    if (result.threadIds.length <= THREADS_PER_TICK) {
        await sb.from('gmail_accounts').update({ history_id: result.historyId }).eq('id', account.id);
    }
    return { status: 'working', threads: result.threadIds.length, images };
}
