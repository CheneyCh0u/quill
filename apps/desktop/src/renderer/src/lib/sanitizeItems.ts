import type { ConvItem } from './itemsToMessages'

/**
 * Normalize items loaded from disk. The agent run that wrote them may have
 * been killed mid-stream (Quill quit, OS crash, …) so in-flight statuses
 * are meaningless on resume:
 *
 * - approval with status='pending' → rejected + "session ended" error so the
 *   UI shows it as a write that didn't happen
 * - plan with status='streaming'   → complete (we kept whatever steps
 *   materialized before the interruption)
 *
 * Idempotent: running it on already-clean items is a no-op.
 */
export function sanitizeItems(items: ConvItem[]): ConvItem[] {
  return items.map((item) => {
    if (item.kind === 'approval' && item.status === 'pending') {
      return { ...item, status: 'rejected' as const, resultError: 'session ended' }
    }
    if (item.kind === 'plan' && item.status === 'streaming') {
      return { ...item, status: 'complete' as const }
    }
    return item
  })
}
