import type { Usage } from './usage'

/**
 * Decide whether the conversation is close enough to the model's context
 * window that we should run a compression pass before the next turn.
 *
 * Heuristic: the next call's input ≈ last call's (input + output) + new
 * prompt. If `input + output` is already past `threshold * contextTokens`
 * the next turn risks overflowing. 0.85 is the default headroom budget —
 * roughly 15% reserved for the new user prompt + tool calls + tool
 * results before the agent's response.
 *
 * Returns false when usage is missing, contextTokens is 0 (unknown model),
 * or we're still safely below threshold.
 *
 * Mirror of apps/desktop/src/renderer/src/lib/compressionTrigger.ts.
 */
export function shouldCompress(
  lastUsage: Usage | undefined,
  contextTokens: number,
  threshold = 0.85
): boolean {
  if (!lastUsage) return false
  if (!contextTokens || contextTokens <= 0) return false
  if (threshold <= 0 || threshold > 1) return false
  return lastUsage.input + lastUsage.output >= threshold * contextTokens
}
