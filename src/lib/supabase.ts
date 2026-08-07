import { createClient } from '@supabase/supabase-js'

// Injected at build time by Vite. Both values are public by design — the
// publishable key only ever sees tables through RLS.
const url = import.meta.env.VITE_SUPABASE_URL ?? 'https://izeineiwbhfsbgsspisz.supabase.co'
const key =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_DMpvVj9VHcW7MDymRw-jRg_zjwHENj-'

export const supabase = createClient(url, key)
