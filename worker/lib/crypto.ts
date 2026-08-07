// AES-GCM over the Gmail refresh token. The key is a base64 32-byte secret in
// TOKEN_KEY; the IV is random per encryption and prepended to the ciphertext,
// which is how the two travel together in one text column.

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  // Chunked because String.fromCharCode(...bytes) blows the argument limit on
  // anything more than a few tens of KB.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

async function importKey(rawKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytesFromB64(rawKey) as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

export async function seal(plaintext: string, rawKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await importKey(rawKey),
    new TextEncoder().encode(plaintext),
  )
  const out = new Uint8Array(iv.length + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), iv.length)
  return b64FromBytes(out)
}

export async function open(sealed: string, rawKey: string): Promise<string> {
  const bytes = bytesFromB64(sealed)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) as BufferSource },
    await importKey(rawKey),
    bytes.subarray(12) as BufferSource,
  )
  return new TextDecoder().decode(plain)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
