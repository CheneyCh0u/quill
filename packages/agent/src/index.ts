import { streamText, stepCountIs, type ModelMessage } from 'ai'
import type {
  AgentEvent,
  AgentMode,
  AgentRunArgs,
  ApprovalPayload,
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
import { consumeBuildStream } from './build-stream'
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
   * Top-level entry. Orchestrates Router → Plan → Build based on `args.mode`:
   * - 'build': skip routing, run Build directly (Phase 2/3 behavior).
   * - 'plan':  force Plan-then-Build.
   * - 'auto' (default): call Router; if it picks 'plan', run Plan-then-Build,
   *   otherwise run Build directly.
   *
   * Cancellation: one AbortController feeds Router + Plan + Build, so a single
   * cancel() short-circuits any phase. Approvals queue is reset on top.
   */
  async runAgent(
    runId: string,
    args: AgentRunArgs,
    rawOnEvent: (event: AgentEvent) => void
  ): Promise<void> {
    // Belt-and-braces guard: any path out of the try block — including the
    // silent `return` after a wedge-recovered abort or a missing plan — must
    // still hit the renderer with a terminal event so the spinner clears.
    // See #89.
    const guard = createTerminalEventGuard(rawOnEvent)
    const onEvent = guard.onEvent

    const controller = new AbortController()
    this.runs.set(runId, controller)
    const mode: AgentMode = args.mode ?? 'auto'

    // Resolve per-phase model specs. Router uses the Build model (cheap,
    // single classifier call — and matches what the user picked for the
    // phase that will actually run). Plan and Build fall back to the
    // top-level providerId/modelId when no override is set.
    const buildProviderId = args.buildProviderId ?? args.providerId
    const buildModelId = args.buildModelId ?? args.modelId
    const planProviderId = args.planProviderId ?? args.providerId
    const planModelId = args.planModelId ?? args.modelId

    try {
      const buildModelInstance = await makeModel(
        buildProviderId,
        buildModelId,
        this.credentials
      )

      let route: 'plan' | 'build'
      if (mode === 'build') {
        route = 'build'
      } else if (mode === 'plan') {
        route = 'plan'
      } else {
        // mode === 'auto' — Router decides, using the Build model. Untitled
        // scope short-circuits to 'build' inside classifyIntent without an
        // LLM call.
        const decision = await classifyIntent({
          model: buildModelInstance,
          prompt: args.prompt,
          scope: args.scope,
          abortSignal: controller.signal
        })
        onEvent({ type: 'route-decision', decision })
        route = decision.agent
      }

      let plan: Plan | undefined
      if (route === 'plan') {
        onEvent({ type: 'phase-start', phase: 'plan' })
        // Plan may use a different provider/model than Build. Instantiate on
        // demand so we don't pay for a model build when route='build'.
        const planModelInstance =
          planProviderId === buildProviderId && planModelId === buildModelId
            ? buildModelInstance
            : await makeModel(planProviderId, planModelId, this.credentials)
        plan = await this.runPlanPhase(args, planModelInstance, controller, onEvent)
        if (!plan) return

        onEvent({ type: 'plan-approval-request', plan })
        const response = await this.planApprovals.request(runId, plan)
        if (controller.signal.aborted) return
        if (!response.approved) {
          onEvent({ type: 'finish' })
          return
        }
        plan = response.plan
        onEvent({ type: 'phase-start', phase: 'build' })
      }

      await this.runBuildPhase(runId, args, buildModelInstance, plan, controller, onEvent)
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
      // Final safety net — catches every silent `return` path above and
      // any future refactor that forgets to emit. ensureEmitted is a
      // no-op when a real finish/error already went out.
      guard.ensureEmitted('run ended without a terminal event')
    }
  }

  /**
   * Plan phase. Streams partial objects so the renderer can render steps as
   * they materialize. Returns the validated final plan, or `undefined` if the
   * run was aborted or the plan failed to parse.
   */
  private async runPlanPhase(
    args: AgentRunArgs,
    model: Awaited<ReturnType<typeof makeModel>>,
    controller: AbortController,
    onEvent: (event: AgentEvent) => void
  ): Promise<Plan | undefined> {
    const { partial, final, usage } = streamPlan({
      model,
      prompt: args.prompt,
      scope: args.scope,
      history: args.history,
      currentBuffer: args.currentBuffer,
      abortSignal: controller.signal
    })
    // Drive the partial stream so the UI sees plan steps appearing live, but
    // also wait for `final` to validate the full plan against the schema.
    try {
      for await (const chunk of partial) {
        if (controller.signal.aborted) return undefined
        onEvent({ type: 'plan-delta', partial: chunk })
      }
      const full = await final
      onEvent({ type: 'plan-complete', plan: full })
      // Emit usage *after* plan-complete so the UI's token counter folds it
      // in only once the plan visibly settled. Failures here are non-fatal —
      // an SDK that doesn't expose usage just leaves the counter unchanged.
      try {
        const u = await usage
        if (u) onEvent({ type: 'plan-usage', usage: u })
      } catch {
        /* SDK promise rejected → no usage data for this turn, that's fine */
      }
      return full
    } catch (err) {
      if (controller.signal.aborted) {
        onEvent({ type: 'error', message: 'cancelled' })
      } else {
        onEvent({
          type: 'error',
          message: 'plan: ' + (err instanceof Error ? err.message : String(err))
        })
      }
      return undefined
    }
  }

  /**
   * Build phase. Same streamText loop Phase 2/3 had; isolated here so the
   * orchestrator can call it with or without a preceding plan.
   */
  private async runBuildPhase(
    runId: string,
    args: AgentRunArgs,
    model: Awaited<ReturnType<typeof makeModel>>,
    plan: Plan | undefined,
    controller: AbortController,
    onEvent: (event: AgentEvent) => void
  ): Promise<void> {
    const requestApproval = (
      toolCallId: string,
      payload: ApprovalPayload
    ): Promise<ApprovalResponse> => {
      onEvent({ type: 'tool-approval-request', toolCallId, payload })
      return this.approvals.request(runId, toolCallId, payload)
    }
    const tools =
      args.scope.kind === 'untitled' ? undefined : makeTools(args.scope, requestApproval)

    const result = streamText({
      model,
      system: buildSystemPrompt(args.scope, args.currentBuffer, args.currentSelection, plan),
      // Cast bridges our narrower IPC-friendly HistoryMessage (which uses
      // `unknown` for JSON values) to AI SDK's stricter ModelMessage (uses
      // `JSONValue`). At runtime the payloads serialize identically.
      messages: [
        ...((args.history ?? []) as unknown as ModelMessage[]),
        { role: 'user', content: args.prompt }
      ],
      tools,
      stopWhen: stepCountIs(15),
      abortSignal: controller.signal
    })

    await consumeBuildStream(
      result.fullStream as AsyncIterable<Record<string, unknown> & { type: string }>,
      controller.signal,
      onEvent
    )
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
