import { Command } from '@langchain/langgraph'
import type { LanguageModel, ModelMessage } from 'ai'
import type {
  AgentEvent,
  AgentRunArgs,
  ApprovalResponse,
  CompressionRunArgs,
  Plan,
  PlanApprovalResponse
} from '@quill/shared-types'
import { makeModel } from './providers'
import { makeTools } from './tools'
import { buildSystemPrompt } from './prompt'
import { createApprovalsManager } from './approvals'
import { classifyIntent } from './router'
import { streamPlan } from './plan'
import { createPlanApprovalsManager } from './plan-approvals'
import { compressConversation } from './compress'
import { runBuildStep } from './step'
import {
  createAgentGraph,
  createApprovalGate,
  AGENT_RECURSION_LIMIT,
  type ApprovalRequest,
  type GraphDeps
} from './graph'
import { createTerminalEventGuard } from './terminal-event-guard'
import type { CredentialProvider } from './credentials'

export type { CredentialProvider } from './credentials'
export { migrateModelId, listSupportedProviders } from './providers'
export type { ProviderKind, ProviderProfile } from './providers'
export {
  CODEX_PROVIDER_ID,
  createCodexTokenSource,
  defaultOpencodeAuthPath,
  parseOpencodeAuth,
  pollCodexDeviceAuth,
  readOpencodeAuth,
  startCodexDeviceAuth
} from './codex-auth'
export type {
  CodexAuthStore,
  CodexTokens,
  DeviceAuthPending,
  DeviceAuthPollResult
} from './codex-auth'
export { buildSystemPrompt } from './prompt'
export { createContextStore } from './context'
export type { SessionIndex, SessionMeta } from './context'

export interface AgentRuntimeDeps {
  credentials: CredentialProvider
}

function abortMarker(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('Aborted', 'AbortError')
  }
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/**
 * Top-level orchestrator. Holds per-run cancellation + approval queues so
 * each app (desktop, server) gets its own runtime instance with its own
 * state — module-level globals would conflict between concurrent server
 * sessions.
 */
export class AgentRuntime {
  private readonly runs = new Map<string, AbortController>()
  private readonly approvals = createApprovalsManager()
  private readonly planApprovals = createPlanApprovalsManager()
  private readonly credentials: CredentialProvider

  constructor(deps: AgentRuntimeDeps) {
    this.credentials = deps.credentials
  }

  cancelRun(runId: string): boolean {
    const c = this.runs.get(runId)
    // Free any awaiting approval prompts so their tool calls return immediately.
    // Done before abort() so the tool's `execute` has a chance to settle before
    // streamText reports an aborted state. Plan approvals get cancelled too —
    // a paused-before-Build run would otherwise hang.
    this.approvals.cancelRun(runId)
    this.planApprovals.cancelRun(runId)
    if (!c) return false
    c.abort()
    return true
  }

  respondApproval(
    runId: string,
    toolCallId: string,
    response: ApprovalResponse
  ): boolean {
    return this.approvals.respond(runId, toolCallId, response)
  }

  respondPlanApproval(
    runId: string,
    response: PlanApprovalResponse
  ): boolean {
    return this.planApprovals.respond(runId, response)
  }

  /**
   * Top-level entry. The Router → Plan → Build flow is a LangGraph
   * StateGraph (see graph.ts); this method builds the per-run graph with
   * its LLM seams, then drives the invoke/interrupt loop:
   *
   *   invoke → __interrupt__? → translate to legacy approval events →
   *   await host response → invoke(Command{resume}) → … → terminal state
   *
   * The legacy-event translation (tool-approval-request / plan-approval-
   * request + respondApproval / respondPlanApproval) is the #123 compat
   * shim — #124 replaces it with a first-class interrupt/resume protocol.
   *
   * Cancellation: one AbortController feeds every node via config.signal;
   * cancelRun() also flushes pending approval bridges so the loop unwinds.
   */
  async runAgent(
    runId: string,
    args: AgentRunArgs,
    rawOnEvent: (event: AgentEvent) => void
  ): Promise<void> {
    // Belt-and-braces guard: any path out of the try block must still hit
    // the renderer with a terminal event so the spinner clears. See #89.
    const guard = createTerminalEventGuard(rawOnEvent)
    const onEvent = guard.onEvent

    const controller = new AbortController()
    this.runs.set(runId, controller)

    // Resolve per-phase model specs. Router uses the Build model (cheap,
    // single classifier call — and matches what the user picked for the
    // phase that will actually run). Plan falls back to the Build instance
    // when the specs match so we don't build a second model for nothing.
    const buildProviderId = args.buildProviderId ?? args.providerId
    const buildModelId = args.buildModelId ?? args.modelId
    const planProviderId = args.planProviderId ?? args.providerId
    const planModelId = args.planModelId ?? args.modelId

    try {
      const buildModel = await makeModel(buildProviderId, buildModelId, this.credentials)
      const planModel = async (): Promise<LanguageModel> =>
        planProviderId === buildProviderId && planModelId === buildModelId
          ? buildModel
          : makeModel(planProviderId, planModelId, this.credentials)

      const approvalGate = createApprovalGate()
      const tools =
        args.scope.kind === 'untitled'
          ? undefined
          : makeTools(args.scope, approvalGate.requestApproval)

      const deps: GraphDeps = {
        emit: onEvent,
        signal: controller.signal,
        mode: args.mode ?? 'auto',
        approvalGate,
        tools,
        classify: async () =>
          classifyIntent({
            model: buildModel,
            prompt: args.prompt,
            scope: args.scope,
            abortSignal: controller.signal
          }),
        plan: async () => {
          const { partial, final, usage } = streamPlan({
            model: await planModel(),
            prompt: args.prompt,
            scope: args.scope,
            history: args.history,
            currentBuffer: args.currentBuffer,
            abortSignal: controller.signal
          })
          try {
            for await (const chunk of partial) {
              if (controller.signal.aborted) throw abortMarker()
              onEvent({ type: 'plan-delta', partial: chunk })
            }
            const full = await final
            onEvent({ type: 'plan-complete', plan: full })
            // Usage after plan-complete so the UI's token counter folds it
            // in once the plan visibly settled; failures are non-fatal.
            try {
              const u = await usage
              if (u) onEvent({ type: 'plan-usage', usage: u })
            } catch {
              /* no usage data for this turn, that's fine */
            }
            return full
          } catch (err) {
            if (controller.signal.aborted) throw err
            throw new Error('plan: ' + (err instanceof Error ? err.message : String(err)))
          }
        },
        step: (messages, plan) =>
          runBuildStep({
            model: buildModel,
            system: buildSystemPrompt(
              args.scope,
              args.currentBuffer,
              args.currentSelection,
              plan
            ),
            messages,
            tools,
            signal: controller.signal,
            emit: onEvent
          })
      }

      const graph = createAgentGraph(deps)
      const cfg = {
        configurable: { thread_id: runId },
        recursionLimit: AGENT_RECURSION_LIMIT,
        signal: controller.signal
      }

      // Cast bridges our narrower IPC-friendly HistoryMessage (`unknown`
      // for JSON values) to the SDK's stricter ModelMessage. At runtime
      // the payloads serialize identically.
      const initialMessages: ModelMessage[] = [
        ...((args.history ?? []) as unknown as ModelMessage[]),
        { role: 'user', content: args.prompt }
      ]

      // `as never` bridges the input union (initial state vs Command resume)
      // past invoke's node-name generic — both shapes are valid at runtime.
      let input: object = { messages: initialMessages }
      let finalState: { finishReason?: string; usage?: unknown } | null = null
      for (;;) {
        const result = (await graph.invoke(input as never, cfg)) as Record<string, unknown>
        const interrupts = result.__interrupt__ as
          | Array<{ id: string; value: unknown }>
          | undefined
        if (!interrupts?.length) {
          finalState = result as { finishReason?: string; usage?: unknown }
          break
        }
        const intr = interrupts[0]
        const resumeValue = await this.bridgeInterrupt(runId, intr.value, onEvent)
        if (controller.signal.aborted) throw abortMarker()
        input = new Command({ resume: { [intr.id]: resumeValue } })
      }

      onEvent({
        type: 'finish',
        usage: finalState?.usage,
        finishReason: finalState?.finishReason
      })
    } catch (err) {
      if (controller.signal.aborted) {
        onEvent({ type: 'error', message: 'cancelled' })
      } else {
        onEvent({
          type: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      this.approvals.cancelRun(runId)
      this.planApprovals.cancelRun(runId)
      this.runs.delete(runId)
      // Final safety net — catches every silent exit path and any future
      // refactor that forgets to emit. No-op when finish/error went out.
      guard.ensureEmitted('run ended without a terminal event')
    }
  }

  /**
   * #123 compat shim: translate a graph interrupt into the legacy approval
   * events and await the host's respond* call. Removed by #124 when hosts
   * speak interrupt/resume natively.
   */
  private async bridgeInterrupt(
    runId: string,
    value: unknown,
    onEvent: (event: AgentEvent) => void
  ): Promise<unknown> {
    const v = value as
      | { kind: 'plan-approval'; plan: Plan }
      | { kind: 'tool-approval'; requests: ApprovalRequest[] }
    if (v.kind === 'plan-approval') {
      onEvent({ type: 'plan-approval-request', plan: v.plan })
      return this.planApprovals.request(runId, v.plan)
    }
    const decisions: Record<string, ApprovalResponse> = {}
    await Promise.all(
      v.requests.map(async (r) => {
        onEvent({ type: 'tool-approval-request', toolCallId: r.toolCallId, payload: r.payload })
        decisions[r.toolCallId] = await this.approvals.request(runId, r.toolCallId, r.payload)
      })
    )
    return decisions
  }

  /**
   * Run the compression agent. Takes the prior conversation messages the
   * caller wants summarized + the model spec, returns the summary text.
   * Side-channel emits `compression-start` / `compression-complete` /
   * `compression-error` events so the UI can show a "压缩中…" indicator.
   *
   * Logged as structured JSON to stdout so a future log file or remote
   * collector can pick it up later without code changes.
   */
  async runCompression(
    runId: string,
    args: CompressionRunArgs,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    const controller = new AbortController()
    this.runs.set(runId, controller)
    const startedAt = Date.now()
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'compression-start',
        runId,
        providerId: args.providerId,
        modelId: args.modelId,
        originalCount: args.originalCount,
        lastInputTokens: args.lastInputTokens,
        contextTokens: args.contextTokens
      })
    )
    onEvent({ type: 'compression-start' })
    try {
      const model = await makeModel(args.providerId, args.modelId, this.credentials)
      const { summary } = await compressConversation(
        model,
        args.messages as unknown as ModelMessage[],
        controller.signal
      )
      onEvent({
        type: 'compression-complete',
        summary,
        originalCount: args.originalCount
      })
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: 'compression-complete',
          runId,
          durationMs: Date.now() - startedAt,
          summaryChars: summary.length
        })
      )
    } catch (err) {
      const message =
        controller.signal.aborted
          ? 'cancelled'
          : err instanceof Error
            ? err.message
            : String(err)
      onEvent({ type: 'compression-error', message })
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: 'compression-error',
          runId,
          durationMs: Date.now() - startedAt,
          error: message
        })
      )
    } finally {
      this.runs.delete(runId)
    }
  }
}
