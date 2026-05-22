import type {
  AgentEvent,
  AgentProviderInfo,
  AgentRunArgs,
  ApprovalResponse,
  ClientAgentMessage,
  PlanApprovalResponse,
  ServerAgentMessage
} from '@quill/shared-types'

export type AgentEventHandler = (event: AgentEvent) => void

/**
 * Browser-side WebSocket client for /api/agent. Single connection shared
 * across all concurrent runs; messages multiplexed by runId so the panel
 * can dispatch each event to the right handler.
 *
 * The handshake reuses the same session cookie as the REST endpoints —
 * browsers attach cookies to ws:// upgrade requests automatically, and the
 * server-side requireSession middleware verifies them before upgrade.
 */
export class AgentClient {
  private ws: WebSocket | null = null
  private connecting: Promise<WebSocket> | null = null
  private handlers = new Map<string, AgentEventHandler>()

  static wsUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/api/agent`
  }

  async fetchProviders(): Promise<AgentProviderInfo[]> {
    const res = await fetch('/api/agent/providers', { credentials: 'include' })
    if (!res.ok) {
      throw new Error(`failed to load providers: ${res.status}`)
    }
    return (await res.json()) as AgentProviderInfo[]
  }

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    if (this.connecting) return this.connecting

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(AgentClient.wsUrl())
      const cleanup = (): void => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }
      const onOpen = (): void => {
        cleanup()
        this.ws = ws
        this.connecting = null
        ws.addEventListener('message', (e) => this.onMessage(e.data as string))
        ws.addEventListener('close', () => {
          // Surface a synthetic error event to any in-flight runs so the
          // UI can stop the spinner. The runtime on the server side aborts
          // them server-side on the same close event.
          for (const handler of this.handlers.values()) {
            handler({ type: 'error', message: 'connection closed' })
          }
          this.handlers.clear()
          this.ws = null
        })
        resolve(ws)
      }
      const onError = (): void => {
        cleanup()
        this.connecting = null
        reject(new Error('agent websocket error'))
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })

    return this.connecting
  }

  private onMessage(data: string): void {
    let msg: ServerAgentMessage
    try {
      msg = JSON.parse(data) as ServerAgentMessage
    } catch {
      return
    }
    if (msg.type !== 'event') return
    const handler = this.handlers.get(msg.runId)
    if (!handler) return
    handler(msg.event)
  }

  private async send(msg: ClientAgentMessage): Promise<void> {
    const ws = await this.connect()
    ws.send(JSON.stringify(msg))
  }

  async run(
    runId: string,
    args: AgentRunArgs,
    onEvent: AgentEventHandler
  ): Promise<void> {
    this.handlers.set(runId, (event) => {
      onEvent(event)
      // The agent emits exactly one terminal event per run (finish or
      // error); detach the handler so future cross-talk doesn't replay.
      if (event.type === 'finish' || event.type === 'error') {
        this.handlers.delete(runId)
      }
    })
    await this.send({ type: 'run', runId, args })
  }

  async cancel(runId: string): Promise<void> {
    await this.send({ type: 'cancel', runId })
  }

  async approve(
    runId: string,
    toolCallId: string,
    response: ApprovalResponse
  ): Promise<void> {
    await this.send({ type: 'approval', runId, toolCallId, response })
  }

  async approvePlan(runId: string, response: PlanApprovalResponse): Promise<void> {
    await this.send({ type: 'plan-approval', runId, response })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
    this.handlers.clear()
  }
}
