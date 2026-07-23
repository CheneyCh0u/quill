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

export type RefreshableFile = {
  path: string | null
  content: string
  buffer: string
}

export type FileRefreshDependencies = {
  getCurrentFile: () => RefreshableFile | null
  read: (path: string) => Promise<string>
  confirmConflict: () => Promise<boolean>
  apply: (path: string, content: string) => void
}

export type FileRefreshResult = 'unchanged' | 'reloaded' | 'cancelled' | 'stale'

export async function refreshFileFromDisk(
  deps: FileRefreshDependencies
): Promise<FileRefreshResult> {
  const initial = deps.getCurrentFile()
  if (!initial?.path) return 'unchanged'

  const path = initial.path
  const diskContent = await deps.read(path)
  const current = deps.getCurrentFile()
  if (!current || current.path !== path) return 'stale'

  const decision = decideFileRefresh(current.content, current.buffer, diskContent)
  if (decision === 'unchanged') return 'unchanged'
  if (decision === 'conflict' && !(await deps.confirmConflict())) return 'cancelled'
  if (deps.getCurrentFile()?.path !== path) return 'stale'

  deps.apply(path, diskContent)
  return 'reloaded'
}
