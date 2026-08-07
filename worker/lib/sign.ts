// HMAC helpers used for two things: the OAuth `state` parameter, and the
// short-lived image URLs the search grid loads.
//
// Images need a URL an <img> tag can fetch, and an <img> tag cannot send an
// Authorization header. Signing the URL is the alternative to putting an access
// token in the query string, which would leak a credential into browser history
// and any referrer header the page emits.

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sign(payload: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload))
  return b64url(new Uint8Array(mac))
}

export async function verify(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await sign(payload, secret)
  // Length-independent compare. Both sides are fixed-length base64url here, but
  // the loop is written not to early-return regardless.
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

const IMAGE_TTL_SECONDS = 3600

export async function imageUrl(
  sha256: string,
  variant: 'orig' | 'thumb',
  secret: string,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + IMAGE_TTL_SECONDS
  const sig = await sign(`${sha256}:${variant}:${expires}`, secret)
  return `/api/img/${sha256}?v=${variant}&e=${expires}&s=${sig}`
}

export async function checkImageUrl(
  sha256: string,
  variant: string,
  expires: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!Number(expires) || Number(expires) < Date.now() / 1000) return false
  return verify(`${sha256}:${variant}:${expires}`, signature, secret)
}

export async function signState(userId: string, secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + 600
  const payload = `${userId}:${expires}`
  return `${payload}:${await sign(payload, secret)}`
}

export async function checkState(state: string, secret: string): Promise<string | null> {
  const [userId, expires, signature] = state.split(':')
  if (!userId || !expires || !signature) return null
  if (Number(expires) < Date.now() / 1000) return null
  return (await verify(`${userId}:${expires}`, signature, secret)) ? userId : null
}
