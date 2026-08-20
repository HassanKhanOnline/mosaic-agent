import { supabase } from './supabase'

export interface TagRef {
  id: string
  facet: string
  value: string
}

export interface SearchResult {
  id: string
  sha256: string
  width: number | null
  height: number | null
  occurrence_count: number
  last_seen_at: string | null
  status: string
  filename: string | null
  thumbUrl: string
  analysis: {
    description: string | null
    product_name: string | null
    product_code: string | null
    size_mm: string | null
  } | null
}

export interface AssetDetail {
  asset: SearchResult & { url: string; mime: string; bytes: number; status: string }
  analysis: {
    description: string | null
    product_name: string | null
    product_code: string | null
    size_mm: string | null
  } | null
  tags: { source: 'ai' | 'manual'; tag_id: string; tags: TagRef }[]
  occurrences: {
    filename: string | null
    is_inline: boolean
    messages: {
      from_addr: string | null
      to_addrs: string[]
      sent_at: string | null
      threads: { subject: string | null; body_text: string | null } | null
    } | null
  }[]
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...init.headers,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export const api = {
  vocab: () =>
    request<{ facets: { key: string; label: string; values: TagRef[] }[] }>('/vocab'),

  search: (q: string, facets: string[], page = 0, untagged = false) =>
    request<{ results: SearchResult[] }>(
      `/search?q=${encodeURIComponent(q)}&facets=${facets.join(',')}&page=${page}${
        untagged ? '&untagged=1' : ''
      }`,
    ),

  asset: (id: string) => request<AssetDetail>(`/assets/${id}`),

  addTag: (id: string, tagId: string) =>
    request(`/assets/${id}/tags`, { method: 'POST', body: JSON.stringify({ tag_id: tagId }) }),

  removeTag: (id: string, tagId: string) =>
    request(`/assets/${id}/tags/${tagId}`, { method: 'DELETE' }),

  similar: (id: string) =>
    request<{ results: (SearchResult & { distance: number | null })[] }>(
      `/assets/${id}/similar`,
    ),

  bulkTag: (assetIds: string[], tagIds: string[]) =>
    request<{ ok: true; tagged: number }>(`/assets/tags/bulk`, {
      method: 'POST',
      body: JSON.stringify({ asset_ids: assetIds, tag_ids: tagIds }),
    }),

  setStatus: (id: string, status: string) =>
    request(`/assets/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  status: () =>
    request<{
      mailbox: string
      missing: string[]
      schemaReady: boolean
      canConnect: boolean
      account: { email: string; connected_at: string; invalid_since: string | null } | null
      run: {
        kind: string
        status: string
        threads_seen: number
        images_stored: number
        started_at: string
        error: string | null
      } | null
      counts: Record<string, number>
    }>('/admin/status'),

  connectUrl: () => request<{ url: string }>('/admin/connect-url', { method: 'POST' }),
  backfill: () => request('/admin/backfill', { method: 'POST' }),
  cancel: () => request('/admin/cancel', { method: 'POST' }),
  tick: () => request<{ ingest: unknown; tag: unknown }>('/admin/tick', { method: 'POST' }),
}
