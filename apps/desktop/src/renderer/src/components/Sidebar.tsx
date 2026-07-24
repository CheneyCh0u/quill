import { useCallback, useState } from 'react'
import { PanelLeftClose, FolderOpen, X, Cloud } from 'lucide-react'
import { useApp } from '../state/app'
import { FileTree } from './FileTree'
import { CloudWorkspaceSwitcher } from './CloudWorkspaceSwitcher'
import { RefreshButton } from './RefreshButton'

export function Sidebar() {
  const {
    state,
    dirty,
    toggleSidebar,
    openFileAt,
    openFolder,
    closeWorkspace,
    reloadWorkspaceTree
  } = useApp()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError(false)
    try {
      await reloadWorkspaceTree()
    } catch (err) {
      console.error('workspace refresh failed', err)
      setRefreshError(true)
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, reloadWorkspaceTree])

  if (!state.workspace) return null
  const inRemote = state.workspace.kind === 'remote'

  return (
    <aside className="w-64 shrink-0 border-r border-[var(--rule)] bg-[var(--paper-dim)] flex flex-col">
      <div className="px-3 py-3 flex items-start gap-1 border-b border-[var(--rule)] shrink-0">
        <div className="flex-1 min-w-0 mr-1">
          {inRemote ? (
            <>
              <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] flex items-center gap-1">
                {refreshError ? (
                  <span aria-live="polite" className="text-[var(--accent)]">
                    刷新失败
                  </span>
                ) : (
                  <>
                    <Cloud className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">remote · {state.workspace.rootName}</span>
                  </>
                )}
              </div>
              <CloudWorkspaceSwitcher />
            </>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
                {refreshError ? (
                  <span aria-live="polite" className="text-[var(--accent)]">
                    刷新失败
                  </span>
                ) : (
                  'workspace'
                )}
              </div>
              <div
                className="font-display text-[14px] text-[var(--ink)] truncate mt-0.5"
                title={state.workspace.rootPath}
              >
                {state.workspace.rootName}
              </div>
            </>
          )}
        </div>
        <RefreshButton
          label={refreshError ? '重试刷新文件树' : '刷新文件树'}
          refreshing={refreshing}
          onClick={() => void handleRefresh()}
        />
        <button
          onClick={openFolder}
          className="no-drag p-1 rounded-md hover:bg-[var(--paper-soft)] text-[var(--ink-faint)] hover:text-[var(--ink)] transition"
          title="打开其他文件夹"
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={closeWorkspace}
          className="no-drag p-1 rounded-md hover:bg-[var(--paper-soft)] text-[var(--ink-faint)] hover:text-[var(--ink)] transition"
          title="关闭文件夹"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={toggleSidebar}
          className="no-drag p-1 rounded-md hover:bg-[var(--paper-soft)] text-[var(--ink-faint)] hover:text-[var(--ink)] transition"
          title="折叠侧栏"
        >
          <PanelLeftClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-auto py-2">
        <FileTree
          nodes={state.workspace.tree}
          rootParentPath={state.workspace.kind === 'local' ? state.workspace.rootPath : ''}
          currentPath={state.currentFile?.path ?? null}
          dirty={dirty}
          onSelect={(p) => void openFileAt(p)}
        />
      </div>
    </aside>
  )
}
