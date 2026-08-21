// The visual fingerprint: a 6x6 grid of average RGB over a 24x24 render of
// the full frame, L2-normalised, rotation-canonicalised. 108 floats that
// capture palette, tone and coarse texture — for tile photos, that IS
// similarity. Pixels come from Photon (see pixels.ts); this module is pure
// arithmetic.

export const VISUAL_DIMS = 108
const GRID = 6

// pixels: interleaved rows, `channels` bytes per pixel, RGB in the first
// three. Any resolution works; 24x24 is what pixels.ts feeds it.
export function gridFingerprint(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): number[] {
  const cellW = width / GRID
  const cellH = height / GRID
  const vec = new Array(VISUAL_DIMS).fill(0)
  const counts = new Array(GRID * GRID).fill(0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gi =
        Math.min(GRID - 1, Math.floor(y / cellH)) * GRID + Math.min(GRID - 1, Math.floor(x / cellW))
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
