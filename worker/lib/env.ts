export interface Env {
  ASSETS: Fetcher
  BUCKET: R2Bucket
  IMAGES: ImagesBinding
  AI: { run(model: string, input: unknown): Promise<{ data: number[][] }> }

  MAILBOX: string
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  APP_URL: string

  SUPABASE_SECRET_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  TOKEN_KEY: string
  ANTHROPIC_API_KEY: string
}

// Cloudflare's Images binding. Typed loosely here because the shipped types
// lag the runtime; every call site guards with try/catch anyway, since the
// binding is absent on accounts without Images enabled.
export interface ImagesBinding {
  input(stream: ReadableStream): {
    transform(opts: { width?: number; height?: number; fit?: string }): {
      output(opts: { format: string; quality?: number }): Promise<{
        image(): ReadableStream
      }>
    }
  }
}
