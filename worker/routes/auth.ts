import { Hono } from 'hono'
import type { Env } from '../lib/env'
import { db } from '../lib/db'
import { seal } from '../lib/crypto'
import { checkState } from '../lib/sign'
import * as gmail from '../lib/gmail'

// Read-only, and nothing else. This is the entire scope list on purpose: it is
// the first thing a Google reviewer looks at, and it is the honest description
// of what the pipeline does.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export const auth = new Hono<{ Bindings: Env }>()

auth.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) return c.redirect(`${c.env.APP_URL}/admin?error=${encodeURIComponent(error)}`)
  if (!code || !state) return c.text('missing code or state', 400)

  const userId = await checkState(state, c.env.TOKEN_KEY)
  if (!userId) return c.text('state expired or invalid', 400)

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
  })
  if (!res.ok) return c.text(`token exchange failed: ${await res.text()}`, 502)

  const token = (await res.json()) as { access_token: string; refresh_token?: string }
  if (!token.refresh_token) {
    // Google only returns a refresh token on the first consent unless you ask
    // for it explicitly. connectUrl() sets prompt=consent so this should not
    // happen, but without one the connection is useless the moment the access
    // token expires — better to say so than to store a dead row.
    return c.redirect(`${c.env.APP_URL}/admin?error=no_refresh_token`)
  }

  const profile = await gmail.getProfile(token.access_token)
  const sb = db(c.env)

  const { error: storeError } = await sb.from('gmail_accounts').upsert(
    {
      email: profile.emailAddress,
      google_sub: profile.emailAddress,
      refresh_token: await seal(token.refresh_token, c.env.TOKEN_KEY),
      scopes: [SCOPE],
      history_id: profile.historyId,
      connected_at: new Date().toISOString(),
      invalid_since: null,
      revoked_at: null,
    },
    { onConflict: 'email' },
  )

  // Without this check the consent screen succeeds, Google is authorised, and
  // the admin page says "connected" — while nothing was stored, because the
  // table does not exist or a policy refused the write. The mailbox then looks
  // connected and never syncs. Fail loudly instead.
  if (storeError) {
    return c.redirect(
      `${c.env.APP_URL}/admin?error=${encodeURIComponent(
        `could not store the connection: ${storeError.message}`,
      )}`,
    )
  }

  return c.redirect(`${c.env.APP_URL}/admin?connected=${encodeURIComponent(profile.emailAddress)}`)
})

export function redirectUri(env: Env): string {
  return `${env.APP_URL}/auth/google/callback`
}

export function connectUrl(env: Env, state: string): string {
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
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}
