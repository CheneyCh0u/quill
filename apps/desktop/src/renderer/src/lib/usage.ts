/**
 * Token usage normalization. AI SDK shapes drift over versions:
 *   v6 finish chunks: { inputTokens, outputTokens, totalTokens, ... }
 *   v3/v4 / some providers: { promptTokens, completionTokens, totalTokens }
 * Some fields are missing or non-numeric in edge cases (errored runs,
 * streaming aborts). Normalize to a fixed `{ input, output, total }` shape
 * so the renderer's accumulator stays simple.
 */

export type Usage = { input: number; output: number; total: number }

function asPositiveNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/**
 * Pull token counts out of whatever shape the SDK / provider sent. Returns
 * undefined if nothing recognizable is in there — callers should treat that
 * as "no data this turn", not as zero (zero is a real outcome too).
 */
export function coerceUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const input =
    asPositiveNumber(r.inputTokens) ??
    asPositiveNumber(r.promptTokens) ??
    undefined
  const output =
    asPositiveNumber(r.outputTokens) ??
    asPositiveNumber(r.completionTokens) ??
    undefined
  const total = asPositiveNumber(r.totalTokens)
  // Nothing meaningful → treat as missing.
  if (input === undefined && output === undefined && total === undefined) {
    return undefined
  }
  const i = input ?? 0
  const o = output ?? 0
  return { input: i, output: o, total: total ?? i + o }
}

export function sumUsage(parts: Array<Usage | undefined>): Usage {
  let input = 0
  let output = 0
  let total = 0
  for (const p of parts) {
    if (!p) continue
    input += p.input
    output += p.output
    total += p.total
  }
  return { input, output, total }
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}
