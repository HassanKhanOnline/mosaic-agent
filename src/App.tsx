import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Search from './pages/Search'
import Admin from './pages/Admin'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!ready) return null
  if (!session) return <Login />

  return (
    <div className="flex min-h-full flex-col">
      <Nav email={session.user.email ?? ''} />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Search />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function Nav({ email }: { email: string }) {
  const { pathname } = useLocation()
  const link = (to: string, label: string) => (
    <Link
      to={to}
      className={`rounded px-3 py-1.5 text-sm ${
        pathname === to ? 'bg-clay-200 font-medium' : 'hover:bg-clay-100'
      }`}
    >
      {label}
    </Link>
  )
  return (
    <header className="flex items-center gap-2 border-b border-clay-200 bg-white px-5 py-3">
      <span className="mr-3 font-semibold tracking-tight">Mosaic</span>
      {link('/', 'Search')}
      {link('/admin', 'Admin')}
      <span className="ml-auto text-xs text-clay-600">{email}</span>
      <button
        onClick={() => supabase.auth.signOut()}
        className="rounded px-2 py-1 text-xs text-clay-600 hover:bg-clay-100"
      >
        Sign out
      </button>
    </header>
  )
}
