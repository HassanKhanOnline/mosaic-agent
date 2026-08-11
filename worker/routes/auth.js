import { Hono } from 'hono';
import { db } from '../lib/db';
import { seal } from '../lib/crypto';
import { checkState } from '../lib/sign';
import * as gmail from '../lib/gmail';
// Read-only, and nothing else. This is the entire scope list on purpose: it is
// the first thing a Google reviewer looks at, and it is the honest description
// of what the pipeline does.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const auth = new Hono();
auth.get('/google/callback', async (c) => {
    // Every failure below lands back on the admin page with the reason in the
    // banner. Returning a bare text page instead — as this used to — is
    // indistinguishable from "nothing happened" to whoever clicked Connect, and
    // leaves no trace of which step actually broke.
    const back = (reason) => c.redirect(`${c.env.APP_URL}/admin?error=${encodeURIComponent(reason)}`);
    const code = c.req.query('code');
    const state = c.req.query('state');
    const denied = c.req.query('error');
    if (denied)
        return back(`Google returned "${denied}"`);
    if (!code || !state)
        return back('Google did not send a code — try Connect again');
    const userId = await checkState(state, c.env.TOKEN_KEY);
    if (!userId) {
        return back('The connect link expired before you finished. Click Connect Gmail again and complete it in one go.');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: c.env.GOOGLE_CLIENT_ID,
            client_secret: c.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri(c.env),
            grant_type: 'authorization_code',
        }),
    });
    if (!res.ok)
        return back(`Token exchange failed: ${(await res.text()).slice(0, 300)}`);
    const token = (await res.json());
    if (!token.refresh_token) {
        // Google only returns a refresh token on the first consent unless you ask
        // for it explicitly. connectUrl() sets prompt=consent so this should not
        // happen, but without one the connection is useless the moment the access
        // token expires — better to say so than to store a dead row.
        return back('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions, then connect again.');
    }
    // The first real call against the Gmail API, and where "API not enabled"
    // surfaces. Catching it here turns a 500 into something actionable.
    let profile;
    try {
        profile = await gmail.getProfile(token.access_token);
    }
    catch (err) {
        return back(`Gmail API rejected the token — is the Gmail API enabled? ${String(err).slice(0, 300)}`);
    }
    const sb = db(c.env);
    const { error: storeError } = await sb.from('gmail_accounts').upsert({
        email: profile.emailAddress,
        google_sub: profile.emailAddress,
        refresh_token: await seal(token.refresh_token, c.env.TOKEN_KEY),
        scopes: [SCOPE],
        history_id: profile.historyId,
        connected_at: new Date().toISOString(),
        invalid_since: null,
        revoked_at: null,
    }, { onConflict: 'email' });
    // Without this check the consent screen succeeds, Google is authorised, and
    // the admin page says "connected" — while nothing was stored, because the
    // table does not exist or a policy refused the write. The mailbox then looks
    // connected and never syncs. Fail loudly instead.
    if (storeError)
        return back(`Could not store the connection: ${storeError.message}`);
    return c.redirect(`${c.env.APP_URL}/admin?connected=${encodeURIComponent(profile.emailAddress)}`);
});
export function redirectUri(env) {
    return `${env.APP_URL}/auth/google/callback`;
}
export function connectUrl(env, state) {
    const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri(env),
        response_type: 'code',
        scope: SCOPE,
        // offline + consent is what actually yields a refresh token. Without both,
        // Google hands back an access token that dies in an hour and the sync stops
        // working the next morning with no obvious cause.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
