import { streamText, stepCountIs, type ModelMessage } from 'ai'
import { makeModel } from './providers'
import { makeTools } from './tools'
import { buildSystemPrompt } from './prompt'
import type { Scope } from './scope'
import { createApprovalsManager, type ApprovalPayload, type ApprovalResponse } from './approvals'
import { classifyIntent, type RouteDecision } from './router'
import { streamPlan, type Plan } from './plan'

export type { Scope } from './scope'
export type { ApprovalPayload, ApprovalResponse } from './approvals'
export type { RouteDecision } from './router'
export type { Plan, PlanStep } from './plan'
export { buildSystemPrompt } from './prompt'

export type AgentMode = 'auto' | 'plan' | 'build'

// Cross-session conversation context. Subset of ai-sdk v6 ModelMessage —
// the runtime accepts it structurally when spread into `messages`.
type ToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}
type ToolResultOutput =
  | { type: 'json'; value: unknown }
  | { type: 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }
type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
}
type AssistantPart = { type: 'text'; text: string } | ToolCallPart

export type HistoryMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | AssistantPart[] }
  | { role: 'tool'; content: ToolResultPart[] }

export type AgentRunArgs = {
  providerId: string
  modelId: string
  prompt: string
  scope: Scope
  /** Routing mode. 'auto' lets the Router classify; 'plan' forces the
   *  Plan→Build chain; 'build' skips Router and Plan entirely. */
  mode?: AgentMode
  /** Prior conversation turns (user + assistant + tool calls/results from
   *  persisted context). Prepended before the new user prompt so the model
   *  has continuity across sessions. */
  history?: HistoryMessage[]
  /** Snapshot of the user's currently open file at run start. Injected into
   *  the system prompt so the agent has the editing context without burning
   *  a read_file tool call. */
  currentBuffer?: string
  /** Currently selected text in the editor. */
  currentSelection?: string
}

export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; name: string; result: unknown }
  | { type: 'tool-approval-request'; toolCallId: string; payload: ApprovalPayload }
  | { type: 'route-decision'; decision: RouteDecision }
  | { type: 'phase-start'; phase: 'plan' | 'build' }
  | { type: 'plan-delta'; partial: Partial<Plan> }
  | { type: 'plan-complete'; plan: Plan }
  | { type: 'plan-usage'; usage: unknown }
  | { type: 'step-finish'; usage?: unknown }
  | { type: 'finish'; usage?: unknown; finishReason?: string }
  | { type: 'error'; message: string }

const runs = new Map<string, AbortController>()
const approvals = createApprovalsManager()

export function cancelRun(runId: string): boolean {
  const c = runs.get(runId)
  // Free any awaiting approval prompts so their tool calls return immediately.
  // Done before abort() so the tool's `execute` has a chance to settle before
  // streamText reports an aborted state.
  approvals.cancelRun(runId)
  if (!c) return false
  c.abort()
  return true
}

export function respondApproval(
  runId: string,
  toolCallId: string,
  response: ApprovalResponse
): boolean {
  return approvals.respond(runId, toolCallId, response)
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
export async function runAgent(
  runId: string,
  args: AgentRunArgs,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  const controller = new AbortController()
  runs.set(runId, controller)
  const mode: AgentMode = args.mode ?? 'auto'

  try {
    const model = await makeModel(args.providerId, args.modelId)

    let route: 'plan' | 'build'
    if (mode === 'build') {
      route = 'build'
    } else if (mode === 'plan') {
      route = 'plan'
    } else {
      // mode === 'auto' — Router decides. Untitled scope short-circuits to
      // 'build' inside classifyIntent without an LLM call.
      const decision = await classifyIntent({
        model,
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
      plan = await runPlanPhase(args, model, controller, onEvent)
      // If plan failed (returned undefined) or was cancelled, runPlanPhase
      // has already emitted error/finish — bail.
      if (!plan) return
      onEvent({ type: 'phase-start', phase: 'build' })
    }

    await runBuildPhase(runId, args, model, plan, controller, onEvent)
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
    approvals.cancelRun(runId)
    runs.delete(runId)
  }
}

/**
 * Plan phase. Streams partial objects so the renderer can render steps as
 * they materialize. Returns the validated final plan, or `undefined` if the
 * run was aborted or the plan failed to parse.
 */
async function runPlanPhase(
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
async function runBuildPhase(
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
    return approvals.request(runId, toolCallId, payload)
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

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case 'text-delta':
        onEvent({
          type: 'text-delta',
          delta:
            (chunk as unknown as { text?: string; delta?: string }).text ??
            (chunk as unknown as { delta?: string }).delta ??
            ''
        })
        break
      case 'tool-call':
        onEvent({
          type: 'tool-call',
          toolCallId: chunk.toolCallId,
          name: chunk.toolName,
          args:
            (chunk as unknown as { input?: unknown }).input ??
            (chunk as unknown as { args?: unknown }).args
        })
        break
      case 'tool-result':
        onEvent({
          type: 'tool-result',
          toolCallId: chunk.toolCallId,
          name: chunk.toolName,
          result:
            (chunk as unknown as { output?: unknown }).output ??
            (chunk as unknown as { result?: unknown }).result
        })
        break
      case 'finish-step':
        onEvent({
          type: 'step-finish',
          usage: (chunk as unknown as { usage?: unknown }).usage
        })
        break
      case 'finish':
        onEvent({
          type: 'finish',
          usage:
            (chunk as unknown as { totalUsage?: unknown }).totalUsage ??
            (chunk as unknown as { usage?: unknown }).usage,
          finishReason: (chunk as unknown as { finishReason?: string }).finishReason
        })
        break
      case 'error':
        onEvent({
          type: 'error',
          message: String((chunk as unknown as { error?: unknown }).error)
        })
        break
      default:
        // Unhandled chunk type (reasoning, redacted, etc.) — skip silently
        break
    }
  }
}
