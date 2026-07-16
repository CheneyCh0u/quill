import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { AgentEvent } from '@quill/shared-types'
import type { StepResult, StepToolCall } from './graph'
import type { AgentTools } from './tools'

/**
 * 单个 LLM 步的生产实现（graph.ts 的 deps.step）。与旧 consumeBuildStream
 * 的差异：图循环里每步的 SDK `finish` chunk 不再翻译成终局 finish 事件
 * （那会让 UI 每步都"结束"一次），改为捕获 finishReason/usage 返回给图做
 * 路由；tool-call 除发事件外还收集返回 — 工具执行移到了图的 tools 节点。
 * abort/wedge 保护（#89）原样保留。
 */

function abortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('Aborted', 'AbortError')
  }
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

export type StepStreamOutcome = {
  finishReason: string | undefined
  usage: unknown
  toolCalls: StepToolCall[]
}

export async function consumeStepStream(
  stream: AsyncIterable<Record<string, unknown> & { type: string }>,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void
): Promise<StepStreamOutcome> {
  if (signal.aborted) throw abortError()

  const toolCalls: StepToolCall[] = []
  let finishReason: string | undefined
  let usage: unknown

  for await (const chunk of stream) {
    if (signal.aborted) throw abortError()

    switch (chunk.type) {
      case 'text-delta': {
        const delta =
          (chunk as { text?: string }).text ?? (chunk as { delta?: string }).delta ?? ''
        onEvent({ type: 'text-delta', delta })
        break
      }
      case 'tool-call': {
        const c = chunk as unknown as {
          toolCallId: string
          toolName: string
          input?: unknown
          args?: unknown
        }
        const args = c.input ?? c.args
        onEvent({ type: 'tool-call', toolCallId: c.toolCallId, name: c.toolName, args })
        toolCalls.push({ toolCallId: c.toolCallId, name: c.toolName, args })
        break
      }
      case 'finish-step':
        onEvent({ type: 'step-finish', usage: (chunk as { usage?: unknown }).usage })
        break
      case 'finish':
        finishReason = (chunk as { finishReason?: string }).finishReason
        usage =
          (chunk as { totalUsage?: unknown }).totalUsage ?? (chunk as { usage?: unknown }).usage
        break
      case 'error':
        onEvent({ type: 'error', message: String((chunk as { error?: unknown }).error) })
        break
      default:
        // reasoning / redacted / ... — skip silently.
        break
    }
  }

  if (signal.aborted) throw abortError()
  return { finishReason, usage, toolCalls }
}

/**
 * Model-facing view of the toolset: schema + description only. Without
 * `execute` the SDK reports tool calls and stops — execution (and the
 * approval interrupt in front of it) belongs to the graph's tools node.
 */
export function stripExecute(tools: AgentTools): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      { description: t.description, inputSchema: t.inputSchema }
    ])
  ) as ToolSet
}

export type RunBuildStepArgs = {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  tools: AgentTools | undefined
  signal: AbortSignal
  emit: (event: AgentEvent) => void
}

export async function runBuildStep(args: RunBuildStepArgs): Promise<StepResult> {
  const result = streamText({
    model: args.model,
    system: args.system,
    messages: args.messages,
    tools: args.tools ? stripExecute(args.tools) : undefined,
    stopWhen: stepCountIs(1),
    abortSignal: args.signal
  })
  const outcome = await consumeStepStream(
    result.fullStream as AsyncIterable<Record<string, unknown> & { type: string }>,
    args.signal,
    args.emit
  )
  const response = await result.response
  return {
    finishReason: outcome.finishReason,
    usage: outcome.usage,
    toolCalls: outcome.toolCalls,
    responseMessages: response.messages
  }
}
