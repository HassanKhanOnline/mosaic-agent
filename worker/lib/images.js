// Dimensions are read straight out of the file header. A decoding library is
// not available in a Worker, and for the four formats email actually carries
// the header parse is a dozen lines and never allocates the pixel buffer.
export function dimensions(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // PNG: 8-byte signature, then the IHDR chunk with width/height at 16..24.
    if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    // GIF: little-endian width/height at offset 6.
    if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) {
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    // WebP: RIFF container. Three sub-formats, each storing the size differently.
    if (bytes.length > 30 && bytes[0] === 0x52 && bytes[8] === 0x57) {
        const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
        if (fourcc === 'VP8 ') {
            return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        }
        if (fourcc === 'VP8L') {
            const bits = view.getUint32(21, true);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (fourcc === 'VP8X') {
            const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
            const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
            return { width: w + 1, height: h + 1 };
        }
    }
    // JPEG: walk the marker segments to the start-of-frame, which carries the
    // size. Skipping by segment length rather than scanning for 0xFFC0 avoids
    // matching those bytes inside an EXIF thumbnail.
    if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let i = 2;
        while (i < bytes.length - 9) {
            if (bytes[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = bytes[i + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
                continue;
            }
            const length = view.getUint16(i + 2);
            // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
            const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrame)
                return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
            i += 2 + length;
        }
    }
    return null;
}
// The cheap filters, run before anything is stored or sent to a model. The
// thresholds are a starting point, not a law — scripts/probe.ts exists to
// check them against what this mailbox actually holds.
export const MIN_BYTES = 25_000;
export const MIN_EDGE = 200;
export const MAX_RATIO = 4;
export function classify(bytes, dims) {
    if (bytes < MIN_BYTES)
        return { reject: 'too_small' };
    if (dims) {
        if (dims.width < MIN_EDGE || dims.height < MIN_EDGE)
            return { reject: 'too_small' };
        const ratio = Math.max(dims.width, dims.height) / Math.min(dims.width, dims.height);
        // Banners and dividers. A tile photo is never 8:1.
        if (ratio > MAX_RATIO)
            return { reject: 'bad_ratio' };
    }
    return { reject: null };
}
// The same image across many senders over many months is boilerplate — a
// signature logo or a footer graphic. Both halves matter: a genuinely popular
// tile photo mailed to forty customers in one week is not boilerplate.
export const BOILERPLATE_OCCURRENCES = 15;
export const BOILERPLATE_SPAN_DAYS = 30;
export function isBoilerplate(occurrences, firstSeen, lastSeen) {
    if (occurrences < BOILERPLATE_OCCURRENCES)
        return false;
    const spanDays = (Date.parse(lastSeen) - Date.parse(firstSeen)) / 86_400_000;
    return spanDays > BOILERPLATE_SPAN_DAYS;
}
export function objectKey(sha256, mime) {
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
    // Sharded two levels so a bucket listing stays navigable at 10k+ objects.
    return `orig/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`;
}
export function thumbKey(sha256) {
    return `thumb/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.webp`;
}
export async function store(env, sha256, bytes, mime) {
    const key = objectKey(sha256, mime);
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    // A 400px webp keeps the search grid to a few hundred KB instead of tens of
    // megabytes. Optional on purpose: accounts without Cloudflare Images enabled
    // still get a working library, just heavier thumbnails.
    let thumb = null;
    try {
        const result = await env.IMAGES.input(new Response(bytes).body)
            .transform({ width: 400, fit: 'scale-down' })
            .output({ format: 'image/webp', quality: 80 });
        thumb = thumbKey(sha256);
        await env.BUCKET.put(thumb, result.image(), {
            httpMetadata: { contentType: 'image/webp' },
        });
    }
    catch {
        thumb = null;
    }
    return { key, thumb };
}
