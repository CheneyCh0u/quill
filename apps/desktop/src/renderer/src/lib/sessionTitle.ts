const MAX = 24

/**
 * Session title = first user prompt, whitespace collapsed, capped at 24
 * chars. Empty when the session has no user message yet — the UI renders
 * that as「新会话」. Shared shape with web (items carry kind + text).
 */
export function deriveSessionTitle(items: Array<{ kind: string; text?: string }>): string {
  const first = items.find((i) => i.kind === 'user' && typeof i.text === 'string')
  if (!first?.text) return ''
  const collapsed = first.text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX ? collapsed.slice(0, MAX) + '…' : collapsed
}
