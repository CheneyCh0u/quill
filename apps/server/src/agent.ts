import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { AgentRuntime, type CredentialProvider } from '@quill/agent'
import type {
  AgentEvent,
  AgentProviderInfo,
  ClientAgentMessage,
  ServerAgentMessage
} from '@quill/shared-types'
import type { ProviderConfig } from './config'
import { requireSession } from './auth'

/**
 * Build a CredentialProvider that looks up api_keys from config.yaml.
 * Returning null on miss lets makeModel throw the user-facing "not
 * configured" error rather than throwing here.
 */
function credentialsFromConfig(providers: ProviderConfig[]): CredentialProvider {
  return {
    async getKey(providerId: string): Promise<string | null> {
      return providers.find((p) => p.id === providerId)?.api_key ?? null
    }
  }
}

export type AgentDeps = {
  providers: ProviderConfig[]
  sessionSecret: string
  /** The server's vault root. Always overrides client-supplied scope.root —
   *  the client must not get to point the agent at arbitrary fs paths. */
  vaultRoot: string
}

/**
 * Mount routes:
 *  - GET  /api/agent/providers     → AgentProviderInfo[]
 *  - WS   /api/agent               → bidirectional stream
 *
 * Returns the Hono sub-app + the `websocket` handler that the Bun.serve
 * caller needs to register at the top level.
 */
export function createAgentRoutes(
  deps: AgentDeps
): { app: Hono; websocket: ReturnType<typeof createBunWebSocket>['websocket'] } {
  const credentials = credentialsFromConfig(deps.providers)
  const runtime = new AgentRuntime({ credentials })
  const serverScope = {
    kind: 'workspace' as const,
    root: deps.vaultRoot
  }
  const { upgradeWebSocket, websocket } = createBunWebSocket()

  const app = new Hono()

  // Provider catalog — sanitized. Web uses this to populate the model
  // picker (and to hide the agent panel entirely when nothing is set up).
  app.get('/providers', requireSession(deps.sessionSecret), (c) => {
    const out: AgentProviderInfo[] = deps.providers.map((p) => ({
      id: p.id,
      models: p.models
    }))
    return c.json(out)
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
              // Force scope to the server's vault root. Clients can't be
              // trusted to nominate where the agent operates — that's a
              // path-traversal security boundary.
              const args = { ...msg.args, scope: serverScope }
              void runtime
                .runAgent(msg.runId, args, (event) =>
                  sendEvent(ws, msg.runId, event)
                )
                .finally(() => ownedRuns.delete(msg.runId))
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
