// HMAC helpers used for two things: the OAuth `state` parameter, and the
// short-lived image URLs the search grid loads.
//
// Images need a URL an <img> tag can fetch, and an <img> tag cannot send an
// Authorization header. Signing the URL is the alternative to putting an access
// token in the query string, which would leak a credential into browser history
// and any referrer header the page emits.
async function hmacKey(secret) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function b64url(bytes) {
    let bin = '';
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sign(payload, secret) {
    const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
    return b64url(new Uint8Array(mac));
}
export async function verify(payload, signature, secret) {
    const expected = await sign(payload, secret);
    // Length-independent compare. Both sides are fixed-length base64url here, but
    // the loop is written not to early-return regardless.
    if (expected.length !== signature.length)
        return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++)
        diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
}
const IMAGE_TTL_SECONDS = 3600;
export async function imageUrl(sha256, variant, secret) {
    const expires = Math.floor(Date.now() / 1000) + IMAGE_TTL_SECONDS;
    const sig = await sign(`${sha256}:${variant}:${expires}`, secret);
    return `/api/img/${sha256}?v=${variant}&e=${expires}&s=${sig}`;
}
export async function checkImageUrl(sha256, variant, expires, signature, secret) {
    if (!Number(expires) || Number(expires) < Date.now() / 1000)
        return false;
    return verify(`${sha256}:${variant}:${expires}`, signature, secret);
}
export async function signState(userId, secret) {
    // Half an hour, not the ten minutes this used to be. Consent is rarely one
    // click the first time — it can detour through enabling an API, adding a
    // test user, or picking between two signed-in Google accounts, and having
    // the state expire mid-detour looks like the app silently doing nothing.
    const expires = Math.floor(Date.now() / 1000) + 1800;
    const payload = `${userId}:${expires}`;
    return `${payload}:${await sign(payload, secret)}`;
}
export async function checkState(state, secret) {
    const [userId, expires, signature] = state.split(':');
    if (!userId || !expires || !signature)
        return null;
    if (Number(expires) < Date.now() / 1000)
        return null;
    return (await verify(`${userId}:${expires}`, signature, secret)) ? userId : null;
}
