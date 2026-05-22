/**
 * Convert persisted UI items into `ModelMessage[]` for resuming an agent
 * conversation. Handles full tool-call audit trail so the model knows what
 * it did last session and doesn't repeat work.
 *
 * Mapping rules:
 * - `user` → user message
 * - `assistant-text` + `tool-call` items in sequence → one assistant message
 *   whose content is either a plain string (text only) or an array of
 *   `{type:'text'|'tool-call', ...}` parts
 * - `tool-result` → standalone tool message; orphan results (no prior
 *   tool-call) are dropped defensively
 * - `approval` (status=approved|rejected) → assistant tool-call + tool
 *   message. Approved with resultError → `error-json` output; approved
 *   clean → `json` output with the runtime's success blob; rejected →
 *   `execution-denied` output. Pending approvals are dropped (sanitize
 *   should have flipped them on load).
 * - `plan` / `route` / `phase-divider` / `error` / `finish` / `truncated`
 *   → UI decoration, skipped
 *
 * Pure helper. No React or AI SDK runtime dependency.
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
  | {
      kind: 'plan'
      steps: unknown[]
      status: 'streaming' | 'awaiting' | 'complete' | 'dismissed'
    }
  | { kind: 'route'; decision: unknown }
  | { kind: 'phase-divider'; phase: 'plan' | 'build' }
  | { kind: 'error'; message: string }
  | { kind: 'finish'; usage?: unknown }
  | { kind: 'plan-usage'; usage: unknown }
  | { kind: 'truncated'; count: number }

/**
 * Subset of AI SDK v6's `ModelMessage` we emit. Mirrors the shape exactly
 * (role + content union) — the runtime will accept it as-is since SDK types
 * are structural.
 */
export type ToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

export type ToolResultOutput =
  | { type: 'json'; value: unknown }
  | { type: 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }

export type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
}

export type AssistantPart = { type: 'text'; text: string } | ToolCallPart

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | AssistantPart[] }
  | { role: 'tool'; content: ToolResultPart[] }

function approvedSuccessOutput(item: Extract<ConvItem, { kind: 'approval' }>): ToolResultOutput {
  if (item.resultError) return { type: 'error-json', value: { error: item.resultError } }
  return { type: 'json', value: { ok: true, path: item.resultPath } }
}

export function itemsToMessages(items: ConvItem[]): Message[] {
  const out: Message[] = []

  // Buffer for the currently-building assistant turn. We flush it whenever
  // a non-assistant item appears, or at the end.
  let asstText = ''
  let asstCalls: ToolCallPart[] = []
  // Track issued tool-call ids so an orphan tool-result can be detected and
  // dropped without breaking the conversation order rule.
  const issuedCallIds = new Set<string>()

  const flushAssistant = (): void => {
    const hasText = asstText.length > 0
    const hasCalls = asstCalls.length > 0
    if (!hasText && !hasCalls) return
    if (hasCalls) {
      // Mixed or call-only → parts array
      const parts: AssistantPart[] = []
      if (hasText) parts.push({ type: 'text', text: asstText })
      parts.push(...asstCalls)
      out.push({ role: 'assistant', content: parts })
    } else {
      // Pure text → plain string (compact, matches simple ModelMessage)
      out.push({ role: 'assistant', content: asstText })
    }
    asstText = ''
    asstCalls = []
  }

  for (const item of items) {
    switch (item.kind) {
      case 'user':
        flushAssistant()
        out.push({ role: 'user', content: item.text })
        break

      case 'assistant-text':
        asstText += item.text
        break

      case 'tool-call':
        asstCalls.push({
          type: 'tool-call',
          toolCallId: item.toolCallId,
          toolName: item.name,
          input: item.args
        })
        issuedCallIds.add(item.toolCallId)
        break

      case 'tool-result':
        if (!issuedCallIds.has(item.toolCallId)) break // orphan — drop
        flushAssistant()
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.toolCallId,
              toolName: item.name,
              output: { type: 'json', value: item.result }
            }
          ]
        })
        break

      case 'approval': {
        if (item.status === 'pending') break // sanitize should have flipped these
        asstCalls.push({
          type: 'tool-call',
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: item.payload
        })
        issuedCallIds.add(item.toolCallId)
        const output: ToolResultOutput =
          item.status === 'rejected'
            ? { type: 'execution-denied', reason: item.resultError ?? 'user rejected' }
            : approvedSuccessOutput(item)
        flushAssistant()
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              output
            }
          ]
        })
        break
      }

      // UI-only items — skipped intentionally.
      case 'plan':
      case 'route':
      case 'phase-divider':
      case 'error':
      case 'finish':
      case 'truncated':
        break
    }
  }
  flushAssistant()
  return out
}
