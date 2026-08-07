// Counts what is actually in the mailbox before the pipeline is pointed at it.
//
// The filter thresholds in worker/lib/images.ts are educated guesses. This
// script is how they stop being guesses: it walks the attachment-bearing
// threads, downloads nothing, and reports how many images would survive each
// filter. Run it before the first backfill.
//
//   npm run probe -- --pages 20
//
// Reads the connected mailbox's refresh token from Supabase, so connect the
// mailbox in the app first.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}
const MAX_PAGES = Number(args.get('pages') ?? 10)

const env = { ...loadDevVars(), ...loadWranglerVars() }

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY)
const { data: account } = await sb.from('gmail_accounts').select('*').maybeSingle()
if (!account) {
  console.error('No mailbox connected. Connect one in the app first.')
  process.exit(1)
}

const token = await accessToken(await decrypt(account.refresh_token, env.TOKEN_KEY))
console.log(`Probing ${account.email} — up to ${MAX_PAGES} pages of 100 threads\n`)

const stats = {
  threads: 0,
  messages: 0,
  images: 0,
  inline: 0,
  bytes: 0,
  tooSmall: 0,
  survivors: 0,
}
const hashSeen = new Map<string, number>()

let pageToken: string | undefined
for (let page = 0; page < MAX_PAGES; page++) {
  const list = await api<{ threads?: { id: string }[]; nextPageToken?: string }>(
    token,
    `/threads?q=${encodeURIComponent('has:attachment -in:spam -in:trash')}&maxResults=100${
      pageToken ? `&pageToken=${pageToken}` : ''
    }`,
  )
  for (const { id } of list.threads ?? []) {
    const thread = await api<any>(token, `/threads/${id}?format=full`)
    stats.threads++
    for (const msg of thread.messages ?? []) {
      stats.messages++
      for (const part of imageParts(msg.payload)) {
        stats.images++
        stats.bytes += part.size
        if (part.inline) stats.inline++
        if (part.size < 25_000) stats.tooSmall++
        else stats.survivors++
        // Filename plus exact byte size is a good proxy for the content hash
        // without downloading anything — a signature logo repeats identically.
        const key = `${part.filename}:${part.size}`
        hashSeen.set(key, (hashSeen.get(key) ?? 0) + 1)
      }
    }
  }
  process.stdout.write(`  page ${page + 1}: ${stats.threads} threads, ${stats.images} images\r`)
  pageToken = list.nextPageToken
  if (!pageToken) break
}

const repeats = [...hashSeen.entries()].filter(([, n]) => n >= 15)
const repeated = repeats.reduce((sum, [, n]) => sum + n, 0)

console.log('\n')
console.log(`Threads with attachments   ${stats.threads}`)
console.log(`Messages                   ${stats.messages}`)
console.log(`Images found               ${stats.images}`)
console.log(`  inline (cid:)            ${stats.inline}  ${pct(stats.inline, stats.images)}`)
console.log(`  under 25 KB              ${stats.tooSmall}  ${pct(stats.tooSmall, stats.images)}`)
console.log(`  repeated 15+ times       ${repeated}  ${pct(repeated, stats.images)}`)
console.log(`Survive size filter        ${stats.survivors}  ${pct(stats.survivors, stats.images)}`)
console.log(`Total bytes                ${(stats.bytes / 1e9).toFixed(2)} GB`)
console.log(`Distinct filename+size     ${hashSeen.size}`)
if (pageToken) console.log(`\nStopped at the page limit — the mailbox has more.`)
console.log(`\nTop repeats (candidate boilerplate):`)
for (const [key, n] of repeats.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(4)}x  ${key}`)
}

function pct(n: number, total: number) {
  return total ? `(${((n / total) * 100).toFixed(1)}%)` : ''
}

function imageParts(payload: any): { filename: string; size: number; inline: boolean }[] {
  const out: { filename: string; size: number; inline: boolean }[] = []
  const walk = (part: any) => {
    if (!part) return
    if (part.body?.attachmentId && part.mimeType?.startsWith('image/')) {
      const headers: { name: string; value: string }[] = part.headers ?? []
      const disp = headers.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? ''
      out.push({
        filename: part.filename || 'untitled',
        size: part.body.size ?? 0,
        inline: /inline/i.test(disp) || headers.some((h) => h.name.toLowerCase() === 'content-id'),
      })
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)
  return out
}

async function api<T>(token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok) return res.json() as Promise<T>
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500))
      continue
    }
    throw new Error(`${path} -> ${res.status}: ${await res.text()}`)
  }
}

async function accessToken(refresh: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`token refresh failed: ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function decrypt(sealed: string, rawKey: string): Promise<string> {
  const bytes = Buffer.from(sealed, 'base64')
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(rawKey, 'base64'),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12),
  )
  return new TextDecoder().decode(plain)
}

function loadDevVars(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync('.dev.vars', 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

function loadWranglerVars(): Record<string, string> {
  const raw = readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(raw).vars ?? {}
}
