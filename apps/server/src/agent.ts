import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import {
  AgentRuntime,
  listSupportedProviders,
  type CredentialProvider
} from '@quill/agent'
import type {
  AgentEvent,
  AgentProviderInfo,
  ClientAgentMessage,
  ServerAgentMessage
} from '@quill/shared-types'
import { requireSession } from './auth'
import type { ProvidersStore } from './providers-store'

export type AgentDeps = {
  store: ProvidersStore
  sessionSecret: string
  /** The server's vault root. Always overrides client-supplied scope.root —
   *  the client must not get to point the agent at arbitrary fs paths. */
  vaultRoot: string
  /** Map a run's workspaceId to its directory under the vault root
   *  (undefined id → the default workspace). null = unknown id, the run
   *  is rejected. Falls back to the vault root when not provided (tests
   *  that don't care about workspaces). */
  resolveWorkspaceRoot?: (workspaceId: string | undefined) => Promise<string | null>
}

/**
 * Mount routes:
 *  - GET    /api/agent/catalog              → supported providers (id / kind / baseURL / models)
 *  - GET    /api/agent/providers            → currently-configured (sanitized)
 *  - POST   /api/agent/providers            → upsert { id, api_key, model }
 *  - DELETE /api/agent/providers/:id        → remove
 *  - WS     /api/agent                      → bidirectional run stream
 *
 * Returns the Hono sub-app + the `websocket` handler that the Bun.serve
 * caller needs to register at the top level.
 */
export function createAgentRoutes(
  deps: AgentDeps
): { app: Hono; websocket: ReturnType<typeof createBunWebSocket>['websocket'] } {
  // CredentialProvider reads through the store on each call so newly-added
  // keys take effect immediately — no need to restart the runtime when the
  // user saves a new provider in the settings UI.
  const credentials: CredentialProvider = {
    async getKey(providerId) {
      return deps.store.getKey(providerId)
    }
  }
  const runtime = new AgentRuntime({ credentials })
  const resolveRoot =
    deps.resolveWorkspaceRoot ?? (async () => deps.vaultRoot)
  const { upgradeWebSocket, websocket } = createBunWebSocket()

  const app = new Hono()

  // Catalog: everything @quill/agent knows about. Filtered to providers
  // with at least one model — the rest are stubs waiting for their model
  // tables to be populated.
  app.get('/catalog', requireSession(deps.sessionSecret), (c) => {
    return c.json(
      listSupportedProviders()
        .filter((p) => p.models.length > 0)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          baseURL: p.baseURL,
          models: p.models,
          defaultModelId: p.defaultModelId
        }))
    )
  })

  // What the user has configured. AgentPanel uses this list to decide
  // which model to pick. Stripped of api_key.
  app.get('/providers', requireSession(deps.sessionSecret), (c) => {
    const supported = new Map(listSupportedProviders().map((p) => [p.id, p]))
    const out: AgentProviderInfo[] = deps.store.listPublic().map((s) => {
      const catalog = supported.get(s.id)
      // Hand back the user's *chosen* model first; if for some reason
      // the catalog has more, web can decide whether to expose them.
      const catalogIds = catalog ? catalog.models.map((m) => m.id) : []
      const models = Array.from(new Set([s.model, ...catalogIds])).filter(Boolean)
      return { id: s.id, models }
    })
    return c.json(out)
  })

  const UpsertSchema = z.object({
    id: z.string().min(1),
    api_key: z.string().optional(),
    model: z.string().min(1)
  })

  app.post('/providers', requireSession(deps.sessionSecret), async (c) => {
    const parsed = UpsertSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const supported = listSupportedProviders().find((p) => p.id === parsed.data.id)
    if (!supported) return c.json({ error: `unknown provider: ${parsed.data.id}` }, 400)
    if (
      supported.models.length > 0 &&
      !supported.models.some((m) => m.id === parsed.data.model)
    ) {
      return c.json({ error: `unknown model for ${parsed.data.id}: ${parsed.data.model}` }, 400)
    }
    try {
      await deps.store.upsert(parsed.data)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      )
    }
    return c.json({ ok: true })
  })

  app.delete('/providers/:id', requireSession(deps.sessionSecret), async (c) => {
    await deps.store.remove(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get(
    '/',
    requireSession(deps.sessionSecret),
    upgradeWebSocket(() => {
      // Track which runs originated from THIS socket so a disconnect
      // cleans them up. Otherwise a refresh leaves orphan runs draining
      // model tokens with no listener.
      const ownedRuns = new Set<string>()

      const sendEvent = (
        ws: { send: (data: string) => void },
        runId: string,
        event: AgentEvent
      ): void => {
        const msg: ServerAgentMessage = { type: 'event', runId, event }
        ws.send(JSON.stringify(msg))
      }

      return {
        onMessage(evt, ws) {
          let msg: ClientAgentMessage
          try {
            msg = JSON.parse(String(evt.data)) as ClientAgentMessage
          } catch {
            return
          }
          switch (msg.type) {
            case 'run': {
              ownedRuns.add(msg.runId)
              // Scope is server-decided, never client-supplied: resolve
              // the run's workspaceId against the registry and pin
              // scope.root to that workspace directory. That's both the
              // path-traversal boundary and the per-workspace permission
              // model — the agent cannot see outside its workspace.
              void resolveRoot(msg.workspaceId)
                .then((root) => {
                  if (root === null) {
                    sendEvent(ws, msg.runId, {
                      type: 'error',
                      message: `unknown workspace: ${msg.workspaceId}`
                    })
                    ownedRuns.delete(msg.runId)
                    return
                  }
                  const args = {
                    ...msg.args,
                    scope: { kind: 'workspace' as const, root }
                  }
                  return runtime
                    .runAgent(msg.runId, args, (event) =>
                      sendEvent(ws, msg.runId, event)
                    )
                    .finally(() => ownedRuns.delete(msg.runId))
                })
                .catch(() => ownedRuns.delete(msg.runId))
              return
            }
            case 'cancel': {
              runtime.cancelRun(msg.runId)
              return
            }
            case 'approval': {
              runtime.respondApproval(msg.runId, msg.toolCallId, msg.response)
              return
            }
            case 'plan-approval': {
              runtime.respondPlanApproval(msg.runId, msg.response)
              return
            }
            case 'compress': {
              ownedRuns.add(msg.runId)
              void runtime
                .runCompression(msg.runId, msg.args, (event) =>
                  sendEvent(ws, msg.runId, event)
                )
                .finally(() => ownedRuns.delete(msg.runId))
              return
            }
            default: {
              // Unknown message type — swallow silently; the client may be
              // newer than the server during a rolling deploy.
              return
            }
          }
        },
        onClose() {
          // Abort anything still running for this socket so we don't leak
          // model usage.
          for (const id of ownedRuns) runtime.cancelRun(id)
          ownedRuns.clear()
        }
      }
    })
  )

  return { app, websocket }
}
