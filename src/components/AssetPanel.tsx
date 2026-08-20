import { useEffect, useState } from 'react'
import { api, type AssetDetail, type SearchResult, type TagRef } from '../lib/api'
import { FACETS } from '../../shared/vocab'

export default function AssetPanel({ id, onClose }: { id: string; onClose: () => void }) {
  // The panel can navigate itself (clicking a similar tile), so the shown
  // asset is state seeded from the prop rather than the prop directly.
  const [currentId, setCurrentId] = useState(id)
  const [detail, setDetail] = useState<AssetDetail | null>(null)
  const [similar, setSimilar] = useState<(SearchResult & { distance: number | null })[]>([])
  const [vocab, setVocab] = useState<{ key: string; label: string; values: TagRef[] }[]>([])
  const [editing, setEditing] = useState(false)

  useEffect(() => setCurrentId(id), [id])

  const load = () => api.asset(currentId).then(setDetail)
  useEffect(() => {
    setDetail(null)
    setSimilar([])
    load()
    api
      .similar(currentId)
      .then((r) => setSimilar(r.results))
      .catch(() => setSimilar([]))
    api.vocab().then((v) => setVocab(v.facets))
  }, [currentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!detail) return null

  const { asset, analysis, tags, occurrences } = detail

  async function toggleTag(tag: TagRef, has: boolean) {
    if (has) await api.removeTag(currentId, tag.id)
    else await api.addTag(currentId, tag.id)
    await load()
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-2xl flex-col overflow-y-auto bg-white"
      >
        <div className="flex items-center gap-3 border-b border-clay-200 px-5 py-3">
          <h2 className="truncate text-sm font-semibold">
            {analysis?.product_name ?? occurrences[0]?.filename ?? 'Image'}
          </h2>
          <button onClick={onClose} className="ml-auto rounded px-2 py-1 text-sm hover:bg-clay-100">
            Close
          </button>
        </div>

        <img src={asset.url} alt="" className="max-h-[55vh] w-full bg-clay-100 object-contain" />

        <div className="space-y-5 p-5">
          {analysis?.description && <p className="text-sm">{analysis.description}</p>}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <Row label="Product" value={analysis?.product_name} />
            <Row label="Code" value={analysis?.product_code} />
            <Row label="Size" value={analysis?.size_mm} />
            <Row
              label="Dimensions"
              value={asset.width ? `${asset.width} × ${asset.height}` : null}
            />
            <Row label="Times sent" value={String(asset.occurrence_count)} />
            <Row
              label="Last sent"
              value={asset.last_seen_at ? new Date(asset.last_seen_at).toLocaleDateString() : null}
            />
          </dl>

          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-clay-600">Tags</h3>
              <button
                onClick={() => setEditing((e) => !e)}
                className="text-xs text-clay-600 underline"
              >
                {editing ? 'Done' : 'Edit'}
              </button>
            </div>

            {editing ? (
              <div className="space-y-3">
                {vocab.map((facet) => (
                  <div key={facet.key}>
                    <p className="mb-1 text-[11px] text-clay-600">{facet.label}</p>
                    <div className="flex flex-wrap gap-1">
                      {facet.values.map((v) => {
                        const has = tags.some((t) => t.tag_id === v.id)
                        return (
                          <button
                            key={v.id}
                            onClick={() => toggleTag(v, has)}
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              has ? 'bg-clay-900 text-white' : 'bg-clay-100 hover:bg-clay-200'
                            }`}
                          >
                            {v.value}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {FACETS.flatMap(({ key }) => tags.filter((t) => t.tags?.facet === key)).map((t) => (
                  <span
                    key={`${t.tag_id}-${t.source}`}
                    title={t.source === 'manual' ? 'Added by hand' : 'Suggested by the tagger'}
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      // A hand-added tag is a correction, and it should look
                      // different from a guess — that is the whole feedback loop.
                      t.source === 'manual'
                        ? 'bg-clay-900 text-white'
                        : 'bg-clay-100 text-clay-900'
                    }`}
                  >
                    {t.tags?.value}
                  </span>
                ))}
                {tags.length === 0 && <span className="text-xs text-clay-600">Not tagged yet.</span>}
              </div>
            )}
          </section>

          {occurrences.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-clay-600">
                {occurrences.length === 1
                  ? 'From the email'
                  : `Attached to ${occurrences.length} messages`}
              </h3>
              <div className="space-y-2">
                {occurrences.map((o, i) => {
                  const msg = o.messages
                  if (!msg) return null
                  return (
                    // The first email is open because it usually names the
                    // product; the rest are one click away, each with its own
                    // thread text — often a different customer conversation.
                    <details
                      key={i}
                      open={i === 0}
                      className="rounded border border-clay-200"
                    >
                      <summary className="cursor-pointer list-none px-3 py-2">
                        <span className="block truncate text-sm font-medium">
                          {msg.threads?.subject ?? '(no subject)'}
                        </span>
                        <span className="block truncate text-xs text-clay-600">
                          {msg.from_addr}
                          {msg.to_addrs?.length > 0 && <> → {msg.to_addrs.join(', ')}</>}
                          {msg.sent_at && <> · {new Date(msg.sent_at).toLocaleDateString()}</>}
                        </span>
                      </summary>
                      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-clay-200 bg-clay-50 p-3 text-xs">
                        {msg.threads?.body_text?.slice(0, 3000) || '(no text in this thread)'}
                      </p>
                    </details>
                  )
                })}
              </div>
            </section>
          )}

          {similar.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-clay-600">
                Similar tiles
              </h3>
              <div className="grid grid-cols-6 gap-2">
                {similar.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setCurrentId(s.id)}
                    title={s.analysis?.product_name ?? s.filename ?? ''}
                    className="overflow-hidden rounded border border-clay-200 hover:ring-2 hover:ring-clay-900"
                  >
                    <img
                      src={s.thumbUrl}
                      alt=""
                      loading="lazy"
                      className="aspect-square w-full bg-clay-100 object-cover"
                    />
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-clay-600">
                Matched by look — colour and texture — not by name, so re-sends of the
                same photo from different emails group here too.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <>
      <dt className="text-clay-600">{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
