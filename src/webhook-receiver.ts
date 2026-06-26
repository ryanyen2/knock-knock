/**
 * WebhookReceiver — the relay's single, OPT-IN inbound HTTP server for event-driven
 * intake. It is the one place the "laptop with no public URL" thesis is relaxed, so it
 * is started ONLY when a bot is configured `intake: 'webhook'` (poll stays the default
 * and opens no server). One `Bun.serve` for the whole process routes
 *
 *     POST /<platform>/<botKey>
 *
 * to the matching `AgentHost.ingestWebhook`, which hands the raw body to the platform
 * adapter to parse + emit. The receiver itself is transport-dumb: it does no signature
 * verification or payload parsing — that lives in each adapter (where the secret and the
 * payload shape are known). See docs/messaging-event-driven-intake.md.
 *
 * No public URL is required to *use* this: for GitHub, `gh webhook forward` delivers a
 * repo's events to `http://localhost:<port>/github/<botKey>`; for Notion (which needs a
 * public SSL URL), front it with a tunnel (cloudflared/ngrok).
 */

import type { WebhookRequest, WebhookResponse } from './messaging-adapter.ts'

/** The slice of AgentHost the receiver needs — kept narrow so it's trivially testable. */
export type WebhookHost = {
  readonly botKey: string
  readonly platform: string
  ingestWebhook(req: WebhookRequest): Promise<WebhookResponse>
}

export type WebhookReceiverHandle = {
  readonly port: number
  stop(): void
}

/** Parse a webhook request path into its `{ platform, botKey }` parts, or undefined if
 *  it isn't a two-segment `/<platform>/<botKey>` path. Pure (unit-testable). */
export function parseWebhookPath(
  pathname: string,
): { platform: string; botKey: string } | undefined {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length !== 2) return undefined
  const [platform, botKey] = parts
  if (!platform || !botKey) return undefined
  return { platform, botKey }
}

/** Resolve the host a request should route to: the bot whose key AND platform both
 *  match the path. Returns undefined when nothing matches (→ 404). Pure. */
export function routeWebhook(
  hosts: readonly WebhookHost[],
  route: { platform: string; botKey: string },
): WebhookHost | undefined {
  return hosts.find(h => h.botKey === route.botKey && h.platform === route.platform)
}

/** Default port for the receiver when `KNOCK_KNOCK_WEBHOOK_PORT` is unset. */
export const DEFAULT_WEBHOOK_PORT = 8787

/**
 * Start the receiver. Binds `127.0.0.1` by default (a tunnel/forwarder is the public
 * front door — we don't expose the raw port). Returns a handle whose `stop()` closes it.
 */
export function startWebhookReceiver(opts: {
  hosts: readonly WebhookHost[]
  port?: number
  hostname?: string
  log?: (msg: string) => void
}): WebhookReceiverHandle {
  const port = opts.port ?? DEFAULT_WEBHOOK_PORT
  const hostname = opts.hostname ?? '127.0.0.1'
  const log = opts.log ?? (() => {})

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req): Promise<Response> {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const route = parseWebhookPath(new URL(req.url).pathname)
      if (!route) return new Response('not found', { status: 404 })
      const host = routeWebhook(opts.hosts, route)
      if (!host) return new Response('no bot for this webhook path', { status: 404 })

      const body = await req.text()
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
      try {
        const res = await host.ingestWebhook({ headers, body })
        if (res.log) log(res.log)
        return new Response(res.body ?? '', { status: res.status })
      } catch (e) {
        log(`webhook ${route.platform}/${route.botKey} error: ${e}`)
        return new Response('webhook handler error', { status: 500 })
      }
    },
  })

  const boundPort = server.port ?? port
  log(
    `event-driven intake listening on http://${hostname}:${boundPort} — ` +
      opts.hosts.map(h => `/${h.platform}/${h.botKey}`).join(', '),
  )
  return {
    port: boundPort,
    stop: () => server.stop(true),
  }
}
