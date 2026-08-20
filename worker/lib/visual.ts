import type { Env } from './env'

// The visual fingerprint: run the image through Cloudflare Images to a 24x24
// PNG, decode that PNG in pure JS (tiny, so the decode is trivial), then take
// a 6x6 grid of average RGB and L2-normalise. 108 floats that capture
// palette, tone and coarse texture — for tile photos, that IS similarity.
//
// PNG rather than raw because the Images binding only emits encoded formats.
// At 24x24 the IDAT is a few hundred bytes; DecompressionStream handles the
// zlib, and the unfilter pass below handles the five PNG filter types.

export const VISUAL_DIMS = 108
const SIZE = 24
const GRID = 6

export async function visualFingerprint(env: Env, source: ReadableStream): Promise<number[]> {
  const result = await env.IMAGES.input(source)
    // squeeze, not scale-down: similarity wants the full frame mapped onto
    // the grid, aspect ratio be damned — two crops of the same tile should
    // land near each other, and letterboxing would poison the edge cells.
    .transform({ width: SIZE, height: SIZE, fit: 'squeeze' })
    .output({ format: 'image/png' })
  const png = new Uint8Array(await new Response(result.image()).arrayBuffer())
  const { pixels, channels, width, height } = await decodePng(png)

  // Average RGB per grid cell.
  const cell = SIZE / GRID
  const vec = new Array(VISUAL_DIMS).fill(0)
  const counts = new Array(GRID * GRID).fill(0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gi = Math.min(GRID - 1, Math.floor(y / cell)) * GRID + Math.min(GRID - 1, Math.floor(x / cell))
      const p = (y * width + x) * channels
      vec[gi * 3] += pixels[p] / 255
      vec[gi * 3 + 1] += pixels[p + 1] / 255
      vec[gi * 3 + 2] += pixels[p + 2] / 255
      counts[gi]++
    }
  }
  for (let g = 0; g < GRID * GRID; g++) {
    if (counts[g]) {
      vec[g * 3] /= counts[g]
      vec[g * 3 + 1] /= counts[g]
      vec[g * 3 + 2] /= counts[g]
    }
  }

  // L2-normalise so cosine distance ignores overall exposure differences.
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return canonicalize(vec.map((v) => v / norm))
}

// Rotation canonicalisation. The same photo often re-enters the mailbox
// rotated (EXIF orientation flags survive some forwards and not others — seen
// on a real pair from this mailbox), and a rotated grid is a very different
// vector. All four rotations of a 6x6 grid are index permutations, so we can
// compute every variant from the vector alone and store the lexicographically
// smallest: any rotation of the same image lands on the same canonical form,
// and plain cosine then treats rotations as identical — for both duplicate
// detection and the Similar strip.
function canonicalize(vec: number[]): number[] {
  const variants = [vec]
  let current = vec
  for (let r = 0; r < 3; r++) {
    current = rotateGrid(current)
    variants.push(current)
  }
  variants.sort((a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i]
    }
    return 0
  })
  return variants[0]
}

function rotateGrid(vec: number[]): number[] {
  const out = new Array(VISUAL_DIMS).fill(0)
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      // 90° clockwise: destination (r, c) reads from source (GRID-1-c, r).
      const src = ((GRID - 1 - c) * GRID + r) * 3
      const dst = (r * GRID + c) * 3
      out[dst] = vec[src]
      out[dst + 1] = vec[src + 1]
      out[dst + 2] = vec[src + 2]
    }
  }
  return out
}

export function parseVectorLiteral(s: string): number[] {
  return s.slice(1, -1).split(',').map(Number)
}

// pgvector accepts the '[a,b,c]' literal form through PostgREST.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => v.toFixed(6)).join(',')}]`
}

// Minimal PNG decoder for the constrained case the Images binding produces:
// 8-bit, truecolor (2) or truecolor-alpha (6), non-interlaced.
async function decodePng(bytes: Uint8Array): Promise<{
  pixels: Uint8Array
  channels: number
  width: number
  height: number
}> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== 0x89504e47) throw new Error('not a png')

  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = 0
  let interlace = 0
  const idat: Uint8Array[] = []

  let off = 8
  while (off < bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const data = bytes.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(off + 8)
      height = view.getUint32(off + 12)
      bitDepth = bytes[off + 16]
      colorType = bytes[off + 17]
      interlace = bytes[off + 20]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported png layout: depth=${bitDepth} color=${colorType} interlace=${interlace}`)
  }
  const channels = colorType === 6 ? 4 : 3

  const compressed = new Blob(idat as BlobPart[])
  const raw = new Uint8Array(
    await new Response(
      compressed.stream().pipeThrough(new DecompressionStream('deflate')),
    ).arrayBuffer(),
  )

  // Unfilter: each scanline is 1 filter byte + width*channels bytes.
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let value = line[i]
      switch (filter) {
        case 1:
          value += a
          break
        case 2:
          value += b
          break
        case 3:
          value += (a + b) >> 1
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
      }
      out[i] = value & 0xff
    }
  }

  return { pixels, channels, width, height }
}
