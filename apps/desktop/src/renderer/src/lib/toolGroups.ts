/**
 * Transcript 渲染前的工具行归组（#130）：连续的已完成调用合成一个
 * tool-group（渲染层默认折叠成「N 个工具调用」），其余条目原样透传。
 * 规则：
 * - tool-call + 对应 tool-result 视为一次完成的调用，进组（args 配对带上）
 * - 未解析的 tool-call（正在运行/被取消）不进组，独立透传
 * - 任何非工具条目（文本、审批卡…）都会切断连续性
 *
 * 纯函数 — AgentPanel 用 useMemo 包一层即可。
 */

export type GroupableItem =
  | { kind: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { kind: 'tool-result'; toolCallId: string; name: string; result: unknown }
  | { kind: string }

export type ToolGroupEntry = {
  toolCallId: string
  name: string
  result: unknown
  args: unknown
}

export type DisplayEntry<T> =
  | { kind: 'passthrough'; item: T; index: number }
  | { kind: 'tool-group'; entries: ToolGroupEntry[] }

export function groupToolItems<T extends GroupableItem>(items: T[]): DisplayEntry<T>[] {
  const resolved = new Set<string>()
  const argsById = new Map<string, unknown>()
  for (const it of items) {
    if (it.kind === 'tool-result') resolved.add((it as { toolCallId: string }).toolCallId)
    if (it.kind === 'tool-call') {
      const c = it as { toolCallId: string; args: unknown }
      argsById.set(c.toolCallId, c.args)
    }
  }

  const out: DisplayEntry<T>[] = []
  let group: ToolGroupEntry[] = []
  const flush = (): void => {
    if (group.length > 0) {
      out.push({ kind: 'tool-group', entries: group })
      group = []
    }
  }

  items.forEach((item, index) => {
    if (item.kind === 'tool-call') {
      const id = (item as { toolCallId: string }).toolCallId
      // 已完成的调用行由它的结果行代表 — 直接吞掉。
      if (resolved.has(id)) return
      // 运行中/未解析：独立展示，不进组。
      flush()
      out.push({ kind: 'passthrough', item, index })
      return
    }
    if (item.kind === 'tool-result') {
      const r = item as { toolCallId: string; name: string; result: unknown }
      group.push({
        toolCallId: r.toolCallId,
        name: r.name,
        result: r.result,
        args: argsById.get(r.toolCallId)
      })
      return
    }
    flush()
    out.push({ kind: 'passthrough', item, index })
  })
  flush()
  return out
}

/** 组头摘要：唯一名称按出现顺序，重复的带 ×N。 */
export function summarizeGroup(entries: ToolGroupEntry[]): string {
  const counts = new Map<string, number>()
  for (const e of entries) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' · ')
}
