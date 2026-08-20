import { supabase } from './supabase';
async function request(path, init = {}) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(`/api${path}`, {
        ...init,
        headers: {
            ...init.headers,
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({})));
        throw new Error(body.error ?? res.statusText);
    }
    return res.json();
}
export const api = {
    vocab: () => request('/vocab'),
    search: (q, facets, page = 0, untagged = false) => request(`/search?q=${encodeURIComponent(q)}&facets=${facets.join(',')}&page=${page}${untagged ? '&untagged=1' : ''}`),
    asset: (id) => request(`/assets/${id}`),
    addTag: (id, tagId) => request(`/assets/${id}/tags`, { method: 'POST', body: JSON.stringify({ tag_id: tagId }) }),
    removeTag: (id, tagId) => request(`/assets/${id}/tags/${tagId}`, { method: 'DELETE' }),
    similar: (id) => request(`/assets/${id}/similar`),
    bulkTag: (assetIds, tagIds) => request(`/assets/tags/bulk`, {
        method: 'POST',
        body: JSON.stringify({ asset_ids: assetIds, tag_ids: tagIds }),
    }),
    setStatus: (id, status) => request(`/assets/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    status: () => request('/admin/status'),
    connectUrl: () => request('/admin/connect-url', { method: 'POST' }),
    backfill: () => request('/admin/backfill', { method: 'POST' }),
    cancel: () => request('/admin/cancel', { method: 'POST' }),
    tick: () => request('/admin/tick', { method: 'POST' }),
};
