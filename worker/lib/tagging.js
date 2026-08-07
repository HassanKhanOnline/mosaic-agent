import Anthropic from '@anthropic-ai/sdk';
import { FACETS, NOT_A_TILE } from '../../shared/vocab';
export const MODEL = 'claude-opus-5';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
// Anthropic accepts these four. Anything else in the mailbox (tiff, bmp, heic)
// is stored but not tagged, and shows up in the admin as untagged rather than
// silently vanishing.
const VISION_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const canTag = (mime) => VISION_MIME.has(mime);
// Multi-value for the facets where a tile genuinely spans two answers (a grey
// veined marble look reads as both grey and white; a floor tile is often sold
// for walls too). shot_type is single because it is the reject gate, and an
// image that is both a room scene and not-a-tile is a contradiction.
function schema(vocab) {
    const list = (facet) => ({
        type: 'array',
        items: { type: 'string', enum: vocab[facet] ?? [] },
    });
    return {
        type: 'object',
        properties: {
            shot_type: { type: 'string', enum: vocab.shot_type ?? [] },
            colour_family: list('colour_family'),
            finish: list('finish'),
            material_look: list('material_look'),
            format: list('format'),
            application: list('application'),
            description: { type: 'string' },
            product_name: { type: ['string', 'null'] },
            product_code: { type: ['string', 'null'] },
            size_mm: { type: ['string', 'null'] },
        },
        required: [
            'shot_type',
            'colour_family',
            'finish',
            'material_look',
            'format',
            'application',
            'description',
            'product_name',
            'product_code',
            'size_mm',
        ],
        additionalProperties: false,
    };
}
const SYSTEM = `You are cataloguing photographs from a tile merchant's email archive so that
the sales team can find the right image in seconds.

You see two things: an image, and the text of the email thread the image was
attached to. Use both. The email is often the more reliable source for the
product's name, code and size — a thread will say "attached is the Calacatta
Gold 600x1200 polished" where the picture alone cannot tell you the range.
The image is the more reliable source for colour, finish and how it was shot.

Answer only with values from the supplied vocabulary. Choose more than one
value for a facet when the tile genuinely spans both; choose none rather than
guessing at a facet the image does not show.

First decide what kind of picture this is. If it is not a tile or a tiled
surface at all — an email signature logo, a company letterhead, a screenshot,
a photograph of people, a scanned invoice — answer "${NOT_A_TILE}" for
shot_type. That answer removes the image from the searchable library, so use
it whenever the picture would waste a salesperson's time, and do not use it
for a genuine but poor-quality tile photo.

description: one sentence a salesperson would recognise the tile by. Do not
restate the tags.
product_name / product_code / size_mm: only when you can actually read them in
the image or the email. Null otherwise — a guessed product code is worse than
no product code, because someone will order from it.`;
export async function tagImage(env, image, context, vocab) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    // The thread is trimmed rather than sent whole: the useful signal is near the
    // top, and a long forwarded chain is mostly quoted footers.
    const thread = (context.threadText ?? '').slice(0, 6000);
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        // A scoped classification against a fixed vocabulary. Higher effort buys
        // deliberation this task has no use for.
        output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: schema(vocab) },
        },
        system: SYSTEM,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: image.mime,
                            data: toBase64(image.bytes),
                        },
                    },
                    {
                        type: 'text',
                        text: [
                            `Attachment filename: ${context.filename ?? 'unknown'}`,
                            `Email subject: ${context.subject ?? '(none)'}`,
                            '',
                            'Email thread:',
                            thread || '(no text in this thread)',
                        ].join('\n'),
                    },
                ],
            },
        ],
    });
    if (response.stop_reason === 'refusal') {
        throw new Error('tagging refused by safety classifier');
    }
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text')
        throw new Error('no text block in tagging response');
    return JSON.parse(text.text);
}
// What gets embedded and what gets indexed for keyword search are the same
// string: the model's description plus every tag it chose plus the email's own
// words. One text, two indexes, no drift between them.
export function searchContent(result, context) {
    const tags = FACETS.flatMap(({ key }) => {
        const value = result[key];
        return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    });
    return [
        result.description,
        result.product_name,
        result.product_code,
        result.size_mm,
        tags.join(' '),
        context.subject,
        (context.threadText ?? '').slice(0, 4000),
    ]
        .filter(Boolean)
        .join('\n');
}
export async function embed(env, text) {
    const res = await env.AI.run(EMBEDDING_MODEL, { text: [text.slice(0, 8000)] });
    return res.data[0];
}
function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}
