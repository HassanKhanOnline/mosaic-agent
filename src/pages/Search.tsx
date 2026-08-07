import { useEffect, useMemo, useState } from 'react'
import { api, type SearchResult, type TagRef } from '../lib/api'
import AssetPanel from '../components/AssetPanel'

type Facet = { key: string; label: string; values: TagRef[] }

export default function Search() {
  const [facets, setFacets] = useState<Facet[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    api.vocab().then((v) => setFacets(v.facets)).catch(() => {})
  }, [])

  // Debounced so typing doesn't fire an embedding call per keystroke — the
  // semantic half of the query costs a model round trip.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 300)
    return () => clearTimeout(timer)
  }, [input])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .search(query, selected)
      .then((r) => !cancelled && setResults(r.results))
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [query, selected])

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const selectedCount = selected.length

  return (
    <div className="flex">
      <aside className="w-56 shrink-0 border-r border-clay-200 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-clay-600">Filters</span>
          {selectedCount > 0 && (
            <button onClick={() => setSelected([])} className="text-xs text-clay-600 underline">
              Clear {selectedCount}
            </button>
          )}
        </div>
        {facets.map((facet) => (
          <FacetGroup key={facet.key} facet={facet} selected={selected} onToggle={toggle} />
        ))}
      </aside>

      <section className="flex-1 p-5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Calacatta 600x1200 — or: something warm and sandy for a bathroom floor"
          className="w-full rounded border border-clay-200 bg-white px-4 py-2.5 text-sm"
        />

        <p className="mt-2 h-4 text-xs text-clay-600">
          {error ? (
            <span className="text-red-700">{error}</span>
          ) : loading ? (
            'Searching…'
          ) : (
            `${results.length} image${results.length === 1 ? '' : 's'}`
          )}
        </p>

        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => setOpen(r.id)}
              className="group overflow-hidden rounded border border-clay-200 bg-white text-left"
            >
              <img
                src={r.thumbUrl}
                alt={r.analysis?.description ?? ''}
                loading="lazy"
                className="aspect-square w-full bg-clay-100 object-cover"
              />
              <div className="p-2">
                <p className="truncate text-xs font-medium">
                  {r.analysis?.product_name ?? r.analysis?.description ?? 'Untitled'}
                </p>
                <p className="truncate text-[11px] text-clay-600">
                  {[r.analysis?.product_code, r.analysis?.size_mm].filter(Boolean).join(' · ') ||
                    (r.occurrence_count > 1 ? `sent ${r.occurrence_count}×` : ' ')}
                </p>
              </div>
            </button>
          ))}
        </div>

        {!loading && results.length === 0 && (
          <p className="mt-10 text-center text-sm text-clay-600">
            Nothing matches. Try fewer filters, or describe the look rather than the name.
          </p>
        )}
      </section>

      {open && <AssetPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function FacetGroup({
  facet,
  selected,
  onToggle,
}: {
  facet: Facet
  selected: string[]
  onToggle: (id: string) => void
}) {
  const active = useMemo(
    () => facet.values.filter((v) => selected.includes(v.id)).length,
    [facet.values, selected],
  )
  return (
    <details open={active > 0} className="mb-2 border-b border-clay-200 pb-2 last:border-0">
      <summary className="cursor-pointer list-none text-sm font-medium">
        {facet.label}
        {active > 0 && <span className="ml-1 text-xs text-clay-600">({active})</span>}
      </summary>
      <div className="mt-1.5 space-y-1">
        {facet.values.map((v) => (
          <label key={v.id} className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={selected.includes(v.id)}
              onChange={() => onToggle(v.id)}
              className="accent-clay-900"
            />
            {v.value}
          </label>
        ))}
      </div>
    </details>
  )
}
