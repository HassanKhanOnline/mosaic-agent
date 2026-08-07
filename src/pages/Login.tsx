import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Mosaic</h1>
          <p className="mt-1 text-sm text-clay-600">Tile image library</p>
        </div>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="username"
          className="w-full rounded border border-clay-200 bg-white px-3 py-2 text-sm"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          className="w-full rounded border border-clay-200 bg-white px-3 py-2 text-sm"
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-clay-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-xs text-clay-600">
          Accounts are created in the Supabase dashboard. There is no sign-up here on
          purpose — the library is the whole company's, and everyone who can log in sees
          all of it.
        </p>
      </form>
    </div>
  )
}
