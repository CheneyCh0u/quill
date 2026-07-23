export type FileRefreshDecision = 'unchanged' | 'reload' | 'conflict'

export function decideFileRefresh(
  knownContent: string,
  buffer: string,
  diskContent: string
): FileRefreshDecision {
  if (diskContent === knownContent) return 'unchanged'
  if (buffer === knownContent || buffer === diskContent) return 'reload'
  return 'conflict'
}
