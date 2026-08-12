import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'

type Status = Awaited<ReturnType<typeof api.status>>

export default function Admin() {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [params] = useSearchParams()

  const load = () => api.status().then(setStatus).catch((e) => setError(String(e.message ?? e)))

  useEffect(() => {
    load()
    // A running backfill moves one batch a minute; polling keeps the numbers
    // honest without a websocket.
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
    setBusy(null)
  }

  async function connect() {
    setBusy('connect')
    try {
      const { url } = await api.connectUrl()
      window.location.href = url
    } catch (e) {
      setError(String((e as Error).message ?? e))
      setBusy(null)
    }
  }

  if (!status) return <div className="p-6 text-sm text-clay-600">Loading…</div>

  const run = status.run
  const running = run?.status === 'running'
  const counts = status.counts ?? {}

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      {params.get('connected') && (
        <Banner tone="ok">Connected {params.get('connected')}. Start the backfill below.</Banner>
      )}
      {params.get('error') && <Banner tone="bad">Google returned: {params.get('error')}</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      {!status.schemaReady && (
        <Banner tone="bad">
          The database schema has not been applied. Run <code>supabase/apply.sql</code> in
          the Supabase SQL editor first — until then a mailbox can be authorised but
          nothing can be stored, and this page will look empty rather than broken.
        </Banner>
      )}

      <section>
        <h2 className="text-sm font-semibold">Mailbox</h2>
        {status.account ? (
          <div className="mt-2 rounded border border-clay-200 bg-white p-4 text-sm">
            <p className="font-medium">{status.account.email}</p>
            <p className="mt-1 text-xs text-clay-600">
              Connected {new Date(status.account.connected_at).toLocaleString()}
            </p>
            {status.account.invalid_since && (
              <div className="mt-3 rounded bg-amber-50 p-3 text-xs">
                <p className="font-medium text-amber-900">Google is rejecting the token.</p>
                <p className="mt-1 text-amber-900">
                  On a consumer @gmail.com account with the OAuth app still in Testing
                  status, refresh tokens expire every 7 days — this is expected, and
                  reconnecting fixes it. The sync resumes from where it stopped.
                </p>
                <button
                  onClick={connect}
                  className="mt-2 rounded bg-clay-900 px-3 py-1.5 text-xs font-medium text-white"
                >
                  Reconnect
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2 rounded border border-clay-200 bg-white p-4">
            <p className="text-sm">
              No mailbox connected. This will authorise read-only Gmail access for{' '}
              <span className="font-medium">{status.mailbox}</span>.
            </p>
            {status.missing.includes('GOOGLE_CLIENT_ID') && (
              <p className="mt-2 text-xs text-amber-800">
                Needs a Google OAuth client. Set it with{' '}
                <code>npx wrangler secret put GOOGLE_CLIENT_ID</code> (and{' '}
                <code>GOOGLE_CLIENT_SECRET</code>).
              </p>
            )}
            <button
              onClick={connect}
              disabled={busy === 'connect' || !status.canConnect}
              className="mt-3 rounded bg-clay-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Connect Gmail
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold">Library</h2>
        <div className="mt-2 grid grid-cols-4 gap-3">
          <Stat label="Searchable" value={counts.ready ?? 0} />
          <Stat label="Awaiting tagging" value={counts.pending ?? 0} />
          <Stat label="Filtered out" value={counts.rejected ?? 0} />
          <Stat label="Boilerplate" value={counts.suppressed ?? 0} />
        </div>
        <p className="mt-2 text-xs text-clay-600">
          Filtered and boilerplate images are still on disk. Open one from search and set
          it back to searchable if a threshold got it wrong.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Sync</h2>
        <div className="mt-2 rounded border border-clay-200 bg-white p-4 text-sm">
          {run ? (
            <>
              <p>
                <span className="font-medium capitalize">{run.kind}</span> — {run.status}
              </p>
              <p className="mt-1 text-xs text-clay-600">
                {/* Library totals, not the run's own counters — those drift
                    low when ticks overlap and read stale values. */}
                {(counts.threads ?? 0).toLocaleString()} threads ·{' '}
                {(
                  (counts.pending ?? 0) +
                  (counts.ready ?? 0) +
                  (counts.rejected ?? 0) +
                  (counts.suppressed ?? 0)
                ).toLocaleString()}{' '}
                images · started {new Date(run.started_at).toLocaleString()}
              </p>
              {run.error && <p className="mt-2 text-xs text-red-700">{run.error}</p>}
            </>
          ) : (
            <p className="text-clay-600">No run yet.</p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={() => act('backfill', api.backfill)}
              disabled={!status.account || running || busy !== null}
              className="rounded bg-clay-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              Start backfill
            </button>
            <button
              onClick={() => act('tick', api.tick)}
              disabled={busy !== null}
              className="rounded border border-clay-200 px-3 py-1.5 text-xs"
            >
              Run one batch now
            </button>
            {running && (
              <button
                onClick={() => act('cancel', api.cancel)}
                disabled={busy !== null}
                className="rounded border border-clay-200 px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-clay-600">
            The backfill advances one batch a minute on its own. "Run one batch now" is
            for watching it start, and is the only way to make progress under{' '}
            <code>wrangler dev</code>, where cron triggers do not fire.
          </p>
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-clay-200 bg-white p-3">
      <p className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[11px] text-clay-600">{label}</p>
    </div>
  )
}

function Banner({ tone, children }: { tone: 'ok' | 'bad'; children: React.ReactNode }) {
  return (
    <div
      className={`rounded p-3 text-sm ${
        tone === 'ok' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'
      }`}
    >
      {children}
    </div>
  )
}
