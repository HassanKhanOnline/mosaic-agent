// In-Worker image processing via Photon (Rust → wasm). This replaced the
// Cloudflare Images binding after the free transformation quota ran dry
// mid-backfill: decoding and resizing in-process costs CPU we already pay
// for, has no per-image billing, and needs no external service at all.

import {
  PhotonImage,
  SamplingFilter,
  resize,
} from '@cf-wasm/photon/workerd'
import { gridFingerprint } from './visual'

const THUMB_MAX = 400
const FP_SIZE = 24

export interface Processed {
  fingerprint: number[]
  // JPEG bytes, only when a thumbnail was requested and the image was larger
  // than the target. Small originals serve as their own thumbnail.
  thumb: Uint8Array | null
}

// One decode, everything derived from it. Frees the wasm-side buffers
// explicitly — the wasm heap never shrinks, so leaks accumulate for the
// lifetime of the isolate.
export function processImage(bytes: Uint8Array, wantThumb: boolean): Processed {
  const image = PhotonImage.new_from_byteslice(bytes)
  try {
    const w = image.get_width()
    const h = image.get_height()

    // Fingerprint: squeeze the full frame to 24x24 regardless of aspect, so
    // crops and rotations of the same photo land on comparable grids.
    const tiny = resize(image, FP_SIZE, FP_SIZE, SamplingFilter.Triangle)
    let fingerprint: number[]
    try {
      fingerprint = gridFingerprint(tiny.get_raw_pixels(), FP_SIZE, FP_SIZE, 4)
    } finally {
      tiny.free()
    }

    let thumb: Uint8Array | null = null
    if (wantThumb && Math.max(w, h) > THUMB_MAX) {
      const scale = THUMB_MAX / Math.max(w, h)
      const tw = Math.max(1, Math.round(w * scale))
      const th = Math.max(1, Math.round(h * scale))
      const small = resize(image, tw, th, SamplingFilter.Triangle)
      try {
        thumb = small.get_bytes_jpeg(80)
      } finally {
        small.free()
      }
    }

    return { fingerprint, thumb }
  } finally {
    image.free()
  }
}
