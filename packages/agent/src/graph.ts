import { Annotation, MemorySaver, StateGraph, interrupt, START, END } from '@langchain/langgraph'
import type { ModelMessage } from 'ai'
import type {
  AgentEvent,
  AgentMode,
  ApprovalPayload,
  ApprovalResponse,
  Plan,
  PlanApprovalResponse,
  RouteDecision
} from '@quill/shared-types'
import type { AgentTools } from './tools'

/**
 * Agent 编排图（#123）。控制流全部在这里声明；LLM 触点（classify /
 * plan / step）作为依赖注入，生产实现由 index.ts 提供（AI SDK），测试
 * 注入脚本化桩。审批统一走 LangGraph interrupt：
 *
 *   START → router ──plan──▶ planNode → planApproval(interrupt)
 *              │                              │approved
 *              └──build──────────┐            ▼
 *                                ├──▶ buildStep ──tool-calls──▶ tools
 *                    finish ◀────┘        ▲                      │
 *                                         │      需审批(两遍执行) ▼
 *                                         └── tools ◀── toolApproval(interrupt)
 *
 * 工具执行是「两遍」协议：第一遍 execute 里 requestApproval 命中未决
 * 审批时抛 ApprovalRequired（此前只有只读验证，幂等），图收集整批去
 * interrupt；resume 后第二遍带决策重跑，才真正落盘。这保持了旧运行时
 * 的语义：注定失败的调用（路径越界、old_text 不唯一）永远不会弹审批。
 */

export const MAX_BUILD_STEPS = 15

/** LangGraph counts node super-steps, not build steps. Worst case is
 *  router + plan + approval + 15 × (buildStep → tools → toolApproval);
 *  every invoke must raise the default limit (25) to this. */
export const AGENT_RECURSION_LIMIT = 64

export type StepToolCall = { toolCallId: string; name: string; args: unknown }

/** One LLM step: streamed text already emitted by the impl; the graph only
 *  needs the structured outcome. */
export type StepResult = {
  finishReason: string | undefined
  toolCalls: StepToolCall[]
  /** SDK-shaped messages to append to the transcript (assistant turn,
   *  including tool-call parts). */
  responseMessages: ModelMessage[]
  usage?: unknown
}

export type ApprovalRequest = { toolCallId: string; payload: ApprovalPayload }

/** Thrown by the approval gate on first pass when a write tool asks for a
 *  decision that hasn't been granted yet. */
export class ApprovalRequired extends Error {
  constructor(
    public readonly toolCallId: string,
    public readonly payload: ApprovalPayload
  ) {
    super(`approval required for ${toolCallId}`)
  }
}

export type ApprovalGate = {
  /** Injected into makeTools as its ApprovalRequester. */
  requestApproval: (toolCallId: string, payload: ApprovalPayload) => Promise<ApprovalResponse>
  /** The tools node loads the current step's decisions before executing. */
  setDecisions: (decisions: Record<string, ApprovalResponse>) => void
}

export function createApprovalGate(): ApprovalGate {
  let decisions: Record<string, ApprovalResponse> = {}
  return {
    requestApproval: async (toolCallId, payload) => {
      const d = decisions[toolCallId]
      if (d) return d
      throw new ApprovalRequired(toolCallId, payload)
    },
    setDecisions: (next) => {
      decisions = next
    }
  }
}

export type GraphDeps = {
  emit: (event: AgentEvent) => void
  signal: AbortSignal
  mode: AgentMode
  /** LLM seams — production impls wrap AI SDK calls and emit their own
   *  streaming events (route-decision text/plan deltas live inside). */
  classify: () => Promise<RouteDecision>
  plan: () => Promise<Plan>
  step: (messages: ModelMessage[], plan: Plan | undefined) => Promise<StepResult>
  /** makeTools output, built with approvalGate.requestApproval. undefined
   *  for untitled scope (no fs access → no tools offered). */
  tools: AgentTools | undefined
  approvalGate: ApprovalGate
}

/** Numeric-field sum so per-step usages roll up into the terminal finish
 *  event the way single-call totalUsage used to. Unknown shapes pass through. */
function addUsage(a: unknown, b: unknown): unknown {
  if (a == null) return b
  if (b == null) return a
  if (typeof a !== 'object' || typeof b !== 'object') return b
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    const prev = out[k]
    out[k] = typeof prev === 'number' && typeof v === 'number' ? prev + v : v
  }
  return out
}

const AgentState = Annotation.Root({
  messages: Annotation<ModelMessage[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => []
  }),
  route: Annotation<'plan' | 'build'>({ reducer: (_p, n) => n, default: () => 'build' }),
  plan: Annotation<Plan | undefined>({ reducer: (_p, n) => n, default: () => undefined }),
  planRejected: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  pendingToolCalls: Annotation<StepToolCall[]>({ reducer: (_p, n) => n, default: () => [] }),
  approvalRequests: Annotation<ApprovalRequest[]>({ reducer: (_p, n) => n, default: () => [] }),
  approvalDecisions: Annotation<Record<string, ApprovalResponse> | null>({
    reducer: (_p, n) => n,
    default: () => null
  }),
  stepCount: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  finishReason: Annotation<string | undefined>({ reducer: (_p, n) => n, default: () => undefined }),
  usage: Annotation<unknown>({ reducer: addUsage, default: () => undefined })
})

export type AgentGraphState = typeof AgentState.State

export function createAgentGraph(deps: GraphDeps) {
  const { emit } = deps

  const graph = new StateGraph(AgentState)
    .addNode('router', async () => {
      if (deps.mode !== 'auto') return { route: deps.mode }
      const decision = await deps.classify()
      emit({ type: 'route-decision', decision })
      return { route: decision.agent }
    })
    .addNode('planNode', async () => {
      emit({ type: 'phase-start', phase: 'plan' })
      const plan = await deps.plan()
      return { plan }
    })
    .addNode('planApproval', (state) => {
      // interrupt 之前不允许任何副作用（resume 会从节点头重跑）。
      const response = interrupt({ kind: 'plan-approval', plan: state.plan }) as
        | PlanApprovalResponse
        | undefined
      if (!response?.approved) return { planRejected: true }
      emit({ type: 'phase-start', phase: 'build' })
      return { plan: response.plan }
    })
    .addNode('buildStep', async (state) => {
      const result = await deps.step(state.messages, state.plan)
      return {
        messages: result.responseMessages,
        pendingToolCalls: result.toolCalls,
        stepCount: state.stepCount + 1,
        finishReason: result.finishReason,
        approvalDecisions: null,
        usage: result.usage
      }
    })
    .addNode('tools', async (state) => {
      deps.approvalGate.setDecisions(state.approvalDecisions ?? {})
      const required: ApprovalRequest[] = []
      const results: Array<{ toolCallId: string; name: string; output: unknown }> = []

      for (const call of state.pendingToolCalls) {
        const impl = deps.tools?.[call.name as keyof AgentTools]
        if (!impl?.execute) {
          results.push({
            toolCallId: call.toolCallId,
            name: call.name,
            output: { ok: false, error: `unknown tool: ${call.name}` }
          })
          continue
        }
        try {
          const output = await impl.execute(call.args as never, {
            toolCallId: call.toolCallId,
            messages: []
          })
          results.push({ toolCallId: call.toolCallId, name: call.name, output })
        } catch (err) {
          if (err instanceof ApprovalRequired) {
            required.push({ toolCallId: err.toolCallId, payload: err.payload })
            continue
          }
          results.push({
            toolCallId: call.toolCallId,
            name: call.name,
            output: { ok: false, error: err instanceof Error ? err.message : String(err) }
          })
        }
      }

      // 有未决审批 → 本遍不落任何结果（第一遍只有幂等的验证读），转去
      // interrupt；resume 后带决策整体重跑。
      if (required.length > 0) return { approvalRequests: required }

      for (const r of results) {
        emit({ type: 'tool-result', toolCallId: r.toolCallId, name: r.name, result: r.output })
      }
      const toolMessage: ModelMessage = {
        role: 'tool',
        content: results.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.name,
          output: { type: 'json' as const, value: r.output as never }
        }))
      }
      return {
        messages: [toolMessage],
        pendingToolCalls: [],
        approvalRequests: [],
        approvalDecisions: null
      }
    })
    .addNode('toolApproval', (state) => {
      const decisions = interrupt({
        kind: 'tool-approval',
        requests: state.approvalRequests
      }) as Record<string, ApprovalResponse>
      return { approvalDecisions: decisions ?? {}, approvalRequests: [] }
    })
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state) => (state.route === 'plan' ? 'planNode' : 'buildStep'), {
      planNode: 'planNode',
      buildStep: 'buildStep'
    })
    .addEdge('planNode', 'planApproval')
    .addConditionalEdges('planApproval', (state) => (state.planRejected ? END : 'buildStep'), {
      [END]: END,
      buildStep: 'buildStep'
    })
    .addConditionalEdges(
      'buildStep',
      (state) => (state.pendingToolCalls.length > 0 ? 'tools' : END),
      { tools: 'tools', [END]: END }
    )
    .addConditionalEdges(
      'tools',
      (state) => {
        if (state.approvalRequests.length > 0) return 'toolApproval'
        if (state.stepCount >= MAX_BUILD_STEPS) return END
        return 'buildStep'
      },
      { toolApproval: 'toolApproval', buildStep: 'buildStep', [END]: END }
    )
    .addEdge('toolApproval', 'tools')

  // Per-run checkpointer: the instance lives exactly as long as the run's
  // graph, so cancelled/finished runs need no cleanup API — GC does it.
  return graph.compile({ checkpointer: new MemorySaver() })
}
