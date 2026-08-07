import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from './env'

// Service-role client. Bypasses RLS — only ever constructed inside the Worker,
// never handed to the browser.
export function db(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Validates a browser's Supabase access token. Returns the user id, or null.
export async function userFromToken(env: Env, token: string | null): Promise<string | null> {
  if (!token) return null
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await anon.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

export function bearer(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}
