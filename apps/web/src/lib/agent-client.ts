import type {
  AgentEvent,
  AgentProviderInfo,
  AgentRunArgs,
  ApprovalResponse,
  ClientAgentMessage,
  CompressionRunArgs,
  PlanApprovalResponse,
  ServerAgentMessage
} from '@quill/shared-types'
import { notifyUnauthorized } from './auth-events'

export type AgentEventHandler = (event: AgentEvent) => void

/** Connection status — surfaced via onStatus so the UI can show a
 *  "reconnecting…" badge without faking it from heuristics. */
export type AgentConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type AgentClientOptions = {
  /** Called whenever the underlying WebSocket transitions state. */
  onStatus?: (status: AgentConnectionStatus) => void
}

/**
 * Browser-side WebSocket client for /api/agent. Single connection shared
 * across all concurrent runs; messages multiplexed by runId so the panel
 * can dispatch each event to the right handler.
 *
 * Reconnect strategy: on close (other than an explicit client close()),
 * retry with exponential backoff capped at 30s. Active runs are torn down
 * with a synthetic `error` event — the server's per-socket cleanup means
 * those runs are already aborted there, so resuming mid-stream isn't
 * possible. The next send() the user triggers will lazy-reconnect.
 *
 * The handshake reuses the same session cookie as the REST endpoints —
 * browsers attach cookies to ws:// upgrade requests automatically, and the
 * server-side requireSession middleware verifies them before upgrade.
 */
export class AgentClient {
  private ws: WebSocket | null = null
  private connecting: Promise<WebSocket> | null = null
  private handlers = new Map<string, AgentEventHandler>()
  private explicitlyClosed = false
  /** Successive failed reconnect attempts. Resets on a successful open. */
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: AgentClientOptions = {}) {}

  static wsUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/api/agent`
  }

  async fetchProviders(): Promise<AgentProviderInfo[]> {
    const res = await fetch('/api/agent/providers', { credentials: 'include' })
    if (res.status === 401) notifyUnauthorized()
    if (!res.ok) {
      throw new Error(`failed to load providers: ${res.status}`)
    }
    return (await res.json()) as AgentProviderInfo[]
  }

  private setStatus(status: AgentConnectionStatus): void {
    this.opts.onStatus?.(status)
  }

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws
    if (this.connecting) return this.connecting

    this.explicitlyClosed = false
    this.setStatus(this.retryCount > 0 ? 'reconnecting' : 'connecting')

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
        this.retryCount = 0
        this.setStatus('open')
        ws.addEventListener('message', (e) => this.onMessage(e.data as string))
        ws.addEventListener('close', () => this.handleClose())
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

  /**
   * Fired by the underlying WebSocket close event. Tears down any in-flight
   * run handlers and schedules a reconnect if the close wasn't explicit
   * (the server crashed, network blipped, mobile woke from sleep, etc.).
   */
  private handleClose(): void {
    this.ws = null
    // Notify active runs that they're done. The server side has already
    // aborted them via its own onClose handler; we just stop pretending
    // they're still running.
    for (const handler of this.handlers.values()) {
      handler({ type: 'error', message: 'connection closed' })
    }
    this.handlers.clear()

    if (this.explicitlyClosed) {
      this.setStatus('closed')
      return
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, … capped at 30s.
    const delay = Math.min(30_000, 1000 * 2 ** this.retryCount)
    this.retryCount += 1
    this.setStatus('reconnecting')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      // Fire-and-forget. If it fails the close handler fires again and we
      // re-schedule with a longer delay.
      this.connect().catch(() => undefined)
    }, delay)
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

  /**
   * Run the compression agent. Emits compression-start / compression-
   * complete / compression-error events through onEvent; the complete
   * event carries the summary text the caller folds back into history.
   */
  async compress(
    runId: string,
    args: CompressionRunArgs,
    onEvent: AgentEventHandler
  ): Promise<void> {
    this.handlers.set(runId, (event) => {
      onEvent(event)
      if (
        event.type === 'compression-complete' ||
        event.type === 'compression-error' ||
        event.type === 'error'
      ) {
        this.handlers.delete(runId)
      }
    })
    await this.send({ type: 'compress', runId, args })
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
    this.explicitlyClosed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.handlers.clear()
    this.setStatus('closed')
  }
}
