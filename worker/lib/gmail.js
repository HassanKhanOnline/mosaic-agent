import { open } from './crypto';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Only threads that carry an IMAGE attachment, and nothing from spam or trash.
// filename: matching is what keeps this tractable — measured on the real
// mailbox, has:attachment alone matches 206k threads (every PDF invoice ever)
// while the image filter matches 41k, and the 3-year window 20k. Widening the
// window later is a one-line change here followed by a fresh backfill run;
// already-ingested threads are skipped, so a re-run only pays for listing.
export const QUERY = '(filename:jpg OR filename:jpeg OR filename:png OR filename:webp OR filename:heic)' +
    ' newer_than:3y -in:spam -in:trash';
export class GmailAuthError extends Error {
}
export async function accessToken(env, sealedRefresh) {
    const refresh = await open(sealedRefresh, env.TOKEN_KEY);
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: refresh,
            grant_type: 'refresh_token',
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        // invalid_grant is the one worth naming: on a consumer @gmail.com account
        // with the OAuth app in Testing status this fires every 7 days by design,
        // and the UI turns it into a reconnect prompt rather than a stack trace.
        throw new GmailAuthError(`token refresh failed (${res.status}): ${body}`);
    }
    const json = (await res.json());
    return json.access_token;
}
async function call(token, path) {
    for (let attempt = 0;; attempt++) {
        const res = await fetch(`${API}${path}`, {
            headers: { authorization: `Bearer ${token}` },
        });
        if (res.ok)
            return (await res.json());
        if (res.status === 401)
            throw new GmailAuthError('access token rejected');
        // 429 and 5xx are the normal weather of a long backfill. Back off and
        // retry rather than failing the batch and losing the whole page.
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
            await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
            continue;
        }
        throw new Error(`gmail ${path} -> ${res.status}: ${await res.text()}`);
    }
}
export function listThreads(token, pageToken) {
    const params = new URLSearchParams({ q: QUERY, maxResults: '100' });
    if (pageToken)
        params.set('pageToken', pageToken);
    return call(token, `/threads?${params}`);
}
export function getThread(token, id) {
    return call(token, `/threads/${id}?format=full`);
}
export function getProfile(token) {
    return call(token, '/profile');
}
// Incremental sync. Returns the thread ids touched since `startHistoryId`.
// A 404 means the watermark has aged out of Gmail's history window, which is
// the signal to fall back to a fresh query rather than silently miss mail.
export async function threadsSince(token, startHistoryId) {
    const ids = new Set();
    let pageToken;
    let latest = startHistoryId;
    do {
        const params = new URLSearchParams({
            startHistoryId,
            historyTypes: 'messageAdded',
            maxResults: '500',
        });
        if (pageToken)
            params.set('pageToken', pageToken);
        let page;
        try {
            page = await call(token, `/history?${params}`);
        }
        catch (err) {
            if (String(err).includes('-> 404'))
                return 'expired';
            throw err;
        }
        for (const entry of page.history ?? []) {
            for (const added of entry.messagesAdded ?? [])
                ids.add(added.message.threadId);
        }
        if (page.historyId)
            latest = page.historyId;
        pageToken = page.nextPageToken;
    } while (pageToken);
    return { threadIds: [...ids], historyId: latest };
}
export async function getAttachment(token, messageId, attachmentId) {
    const res = await call(token, `/messages/${messageId}/attachments/${attachmentId}`);
    return decodeB64Url(res.data);
}
export function decodeB64Url(input) {
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    // atob is strict about padding; Gmail omits it.
    if (b64.length % 4)
        b64 += '='.repeat(4 - (b64.length % 4));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function header(part, name) {
    return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
// Walks the MIME tree for image attachments. `inline` means the part is
// referenced from the HTML body by Content-ID — almost always signature
// furniture, but not always, so it is recorded rather than dropped here and
// weighed with the other signals in images.ts.
export function imageParts(payload) {
    const found = [];
    const walk = (part) => {
        if (!part)
            return;
        const id = part.body?.attachmentId;
        if (id && part.mimeType?.startsWith('image/')) {
            const disposition = header(part, 'content-disposition') ?? '';
            found.push({
                attachmentId: id,
                filename: part.filename || 'untitled',
                mimeType: part.mimeType,
                size: part.body?.size ?? 0,
                isInline: /inline/i.test(disposition) || Boolean(header(part, 'content-id')),
            });
        }
        for (const child of part.parts ?? [])
            walk(child);
    };
    walk(payload);
    return found;
}
// Prefers text/plain; falls back to stripping tags out of the HTML part. Quoted
// reply chains are left in — the thread's own history is exactly the context
// the tagger wants.
export function bodyText(payload) {
    let plain = '';
    let html = '';
    const walk = (part) => {
        if (!part)
            return;
        const data = part.body?.data;
        if (data) {
            if (part.mimeType === 'text/plain')
                plain += new TextDecoder().decode(decodeB64Url(data));
            else if (part.mimeType === 'text/html')
                html += new TextDecoder().decode(decodeB64Url(data));
        }
        for (const child of part.parts ?? [])
            walk(child);
    };
    walk(payload);
    if (plain.trim())
        return plain;
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}
export function messageMeta(msg) {
    const p = msg.payload;
    const addrs = (value) => (value ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
    return {
        subject: header(p, 'subject') ?? null,
        from: header(p, 'from') ?? null,
        to: [...addrs(header(p, 'to')), ...addrs(header(p, 'cc'))],
        sentAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    };
}
