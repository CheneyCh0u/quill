import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { loadConfig } from './config'
import { createAuthRoutes } from './auth-routes'
import { createVaultRoutes } from './vault'
import { createAgentRoutes } from './agent'
import { requireSession } from './auth'

const CONFIG_PATH = process.env.QUILL_CONFIG ?? './config.yaml'
// Where the prebuilt web client lives. In dev (when this dir is missing)
// the server only serves /api/* and the user runs `vite dev` separately
// on :5173, which proxies /api/* back here.
const WEB_DIST = process.env.QUILL_WEB_DIST ?? './apps/web/dist'

const config = await loadConfig(CONFIG_PATH)

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

app.route(
  '/api/auth',
  createAuthRoutes({
    passwordHash: config.auth.password_hash,
    sessionSecret: config.auth.session_secret,
    sessionTtlDays: config.auth.session_ttl_days
  })
)

// All /api/vault/* endpoints require an authenticated session.
const vaultApp = new Hono()
vaultApp.use('*', requireSession(config.auth.session_secret))
vaultApp.route('/', createVaultRoutes(config.vault.path))
app.route('/api/vault', vaultApp)

// Agent — REST provider catalog + WebSocket run/cancel/approval stream.
// The agent routes module owns its own session-check middleware because
// the WS upgrade has to verify before the protocol switch.
const agentRoutes = createAgentRoutes({
  providers: config.ai?.providers ?? [],
  sessionSecret: config.auth.session_secret,
  vaultRoot: config.vault.path
})
app.route('/api/agent', agentRoutes.app)

// Serve the built web client if present. Anything that doesn't match an
// /api/* route falls through to here; we hand back the asset if it exists
// on disk, otherwise index.html (SPA history-mode fallback).
let webDistAvailable = false
try {
  await fs.access(join(WEB_DIST, 'index.html'))
  webDistAvailable = true
} catch {
  /* no built web client — running in API-only mode */
}

if (webDistAvailable) {
  app.get('/*', async (c) => {
    const url = new URL(c.req.url)
    // Strip leading slash; default to index.html for the root.
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const candidate = join(WEB_DIST, requested)
    try {
      const data = await fs.readFile(candidate)
      const type = mimeFor(candidate)
      return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
        headers: { 'Content-Type': type }
      })
    } catch {
      // SPA fallback: serve index.html for client-side routes.
      const html = await fs.readFile(join(WEB_DIST, 'index.html'), 'utf8')
      return c.html(html)
    }
  })
}

function mimeFor(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8'
    case 'js':
    case 'mjs':
      return 'application/javascript'
    case 'css':
      return 'text/css'
    case 'json':
      return 'application/json'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    case 'map':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    event: 'server-start',
    port: config.server.port,
    vault: config.vault.path,
    aiProviders: config.ai?.providers.length ?? 0,
    webDist: webDistAvailable ? WEB_DIST : null
  })
)

export default {
  port: config.server.port,
  fetch: app.fetch,
  // Bun needs the websocket handler at the top level — Hono's
  // upgradeWebSocket only registers the per-route logic.
  websocket: agentRoutes.websocket
}
