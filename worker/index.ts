import { Hono } from 'hono'
import type { Env } from './lib/env'
import { api } from './routes/api'
import { auth } from './routes/auth'
import { incrementalTick, ingestTick } from './jobs/ingest'
import { tagTick } from './jobs/tag'

const app = new Hono<{ Bindings: Env }>()

app.route('/api', api)
app.route('/auth', auth)
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Two schedules, both cheap. The minute tick moves the backfill and the
    // tagging queue forward one batch at a time; the quarter-hour tick looks
    // for new mail. Splitting them keeps a long backfill from starving new
    // arrivals, and keeps either from being a single job that must not fail.
    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(logged('incremental', () => incrementalTick(env)))
      return
    }

    ctx.waitUntil(
      (async () => {
        const ingest = await logged('ingest', () => ingestTick(env))
        // Tagging only runs when ingest has nothing left to do this tick, so
        // the two never contend for the same Worker budget.
        if (ingest?.status !== 'working') await logged('tag', () => tagTick(env))
      })(),
    )
  },
} satisfies ExportedHandler<Env>

async function logged<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn()
    console.log(name, JSON.stringify(result))
    return result
  } catch (err) {
    // A thrown cron handler is invisible unless it is caught and printed —
    // Workers logs the failure but not what the job was doing.
    console.error(`${name} failed:`, err)
    return undefined
  }
}
