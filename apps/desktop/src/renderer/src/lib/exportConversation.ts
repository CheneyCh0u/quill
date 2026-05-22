import type { ConvItem } from './itemsToMessages'

/**
 * Render a conversation's items[] as a self-contained markdown document
 * suitable for dropping into the user's vault as a session log.
 *
 * Style choices:
 * - `## You` / `## Agent` section headers (consistent visual rhythm in a
 *   markdown viewer, no emoji-dependent rendering)
 * - tool calls/results as fenced JSON blocks inside blockquotes
 * - apply_edit shown as a `diff` fenced block with -/+ lines so a markdown
 *   viewer highlights it cleanly
 * - plans as numbered lists (### Plan header)
 * - route / phase / truncated as italic single-line notes
 * - errors as blockquoted warning lines
 * - finish / plan-usage skipped (UI-only)
 *
 * Pure helper. Caller (AgentPanel) provides the scope label + a Date.
 */

export type ExportOptions = {
  /** Human-readable scope name, e.g. "workspace · my-vault". Optional. */
  scopeLabel?: string
  /** Defaults to `new Date()`. Accepts a Date for deterministic tests. */
  exportedAt?: Date
}

export function exportConversation(items: ConvItem[], opts: ExportOptions = {}): string {
  const out: string[] = []

  // ---------- Header ----------
  const header = opts.scopeLabel
    ? `# Agent conversation — ${opts.scopeLabel}`
    : '# Agent conversation'
  out.push(header)
  const date = (opts.exportedAt ?? new Date()).toISOString().slice(0, 10)
  out.push(`*Exported ${date}*`)
  out.push('')

  // ---------- Body ----------
  // Merge adjacent assistant-text items into one section so the user doesn't
  // see fragmented `## Agent` headers from streamed deltas.
  let assistantBuffer = ''
  const flushAssistant = (): void => {
    if (!assistantBuffer.trim()) return
    out.push('## Agent')
    out.push('')
    out.push(assistantBuffer.trimEnd())
    out.push('')
    assistantBuffer = ''
  }

  for (const item of items) {
    if (item.kind !== 'assistant-text' && assistantBuffer) {
      flushAssistant()
    }

    switch (item.kind) {
      case 'user': {
        out.push('## You')
        out.push('')
        const tag = item.forcedMode ? `\`/${item.forcedMode}\` ` : ''
        out.push(tag + item.text)
        out.push('')
        break
      }

      case 'assistant-text':
        assistantBuffer += item.text
        break

      case 'tool-call':
        out.push(`> tool: \`${item.name}\``)
        out.push('> ```json')
        for (const line of jsonStringify(item.args).split('\n')) {
          out.push(`> ${line}`)
        }
        out.push('> ```')
        out.push('')
        break

      case 'tool-result':
        out.push(`> result of \`${item.name}\``)
        out.push('> ```json')
        for (const line of jsonStringify(item.result).split('\n')) {
          out.push(`> ${line}`)
        }
        out.push('> ```')
        out.push('')
        break

      case 'approval': {
        const path = String(item.payload.path ?? '')
        const statusLabel =
          item.status === 'approved' && !item.resultError
            ? '✓ applied'
            : item.status === 'approved' && item.resultError
              ? `✗ failed: ${item.resultError}`
              : item.status === 'rejected'
                ? '✗ rejected'
                : '… pending'
        out.push(`> 📝 \`${item.toolName}\` ${path} — ${statusLabel}`)
        if (item.toolName === 'apply_edit') {
          const oldText = String(item.payload.old_text ?? '')
          const newText = String(item.payload.new_text ?? '')
          out.push('> ```diff')
          for (const line of oldText.split('\n')) out.push(`> - ${line}`)
          for (const line of newText.split('\n')) out.push(`> + ${line}`)
          out.push('> ```')
        } else if (
          (item.toolName === 'write_file' || item.toolName === 'create_file') &&
          item.payload.content !== undefined
        ) {
          const content = String(item.payload.content ?? '')
          out.push('> ```')
          for (const line of content.split('\n')) out.push(`> ${line}`)
          out.push('> ```')
        }
        out.push('')
        break
      }

      case 'plan': {
        const statusSuffix =
          item.status === 'dismissed'
            ? ' (dismissed / 已取消)'
            : item.status === 'awaiting'
              ? ' (awaiting approval)'
              : ''
        out.push(`### Plan (${item.steps.length} steps)${statusSuffix}`)
        out.push('')
        item.steps.forEach((rawStep, i) => {
          const step = rawStep as {
            id?: string
            title?: string
            why?: string
            files?: string[]
          }
          out.push(`${i + 1}. ${step.title ?? '(no title)'}`)
          if (step.why) out.push(`   - *why:* ${step.why}`)
          if (step.files && step.files.length > 0) {
            out.push(`   - *files:* ${step.files.join(', ')}`)
          }
        })
        out.push('')
        break
      }

      case 'route': {
        const decision = item.decision as { agent?: string; reason?: string }
        const label =
          decision.agent === 'plan'
            ? 'via Plan → Build'
            : decision.agent === 'build'
              ? 'via Build'
              : 'via ?'
        out.push(`*${label}${decision.reason ? ` — ${decision.reason}` : ''}*`)
        out.push('')
        break
      }

      case 'phase-divider':
        out.push('---')
        out.push('')
        break

      case 'error':
        out.push(`> ⚠ ${item.message}`)
        out.push('')
        break

      case 'truncated':
        out.push(`*— ${item.count} earlier messages truncated —*`)
        out.push('')
        break

      // UI-only / skipped:
      case 'finish':
      case 'plan-usage':
        break
    }
  }
  flushAssistant()

  // Trim trailing blank lines for a tidy file.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n') + '\n'
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
