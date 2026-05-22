/**
 * Convert persisted UI items into `ModelMessage[]` for resuming an agent
 * conversation. v1 keeps only text turns — tool calls, approvals, plans,
 * route decisions and dividers stay visible in the panel but don't feed
 * back into the LLM's context.
 *
 * Pure helper, no React or AI SDK runtime dependency, so it's directly
 * unit-testable.
 */

export type ConvItem =
  | { kind: 'user'; text: string; forcedMode?: 'plan' | 'build' }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { kind: 'tool-result'; toolCallId: string; name: string; result: unknown }
  | {
      kind: 'approval'
      toolCallId: string
      toolName: string
      payload: Record<string, unknown>
      status: 'pending' | 'approved' | 'rejected'
      resultError?: string
      resultPath?: string
    }
  | { kind: 'plan'; steps: unknown[]; status: 'streaming' | 'complete' }
  | { kind: 'route'; decision: unknown }
  | { kind: 'phase-divider'; phase: 'plan' | 'build' }
  | { kind: 'error'; message: string }
  | { kind: 'finish'; usage?: unknown }
  | { kind: 'truncated'; count: number }

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }

export function itemsToMessages(items: ConvItem[]): Message[] {
  const out: Message[] = []
  // Buffer adjacent assistant-text items so they merge into one message —
  // streamed deltas can land as multiple items if a session was paused mid-
  // run and reloaded. The model wants one assistant turn, not many fragments.
  let assistantBuffer = ''

  const flushAssistant = (): void => {
    if (assistantBuffer.length === 0) return
    out.push({ role: 'assistant', content: assistantBuffer })
    assistantBuffer = ''
  }

  for (const item of items) {
    if (item.kind === 'user') {
      flushAssistant()
      out.push({ role: 'user', content: item.text })
    } else if (item.kind === 'assistant-text') {
      assistantBuffer += item.text
    }
    // All other kinds are UI-only or v1.1+ scope — silently skip.
  }
  flushAssistant()
  return out
}
