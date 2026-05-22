import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode } from '@quill/shared-types'
import type { VaultProvider } from '@quill/vault-adapter'

type TreeProps = {
  vault: VaultProvider
  selectedPath: string | null
  onSelect: (node: FileNode) => void
  /** Notify parent that a path was renamed so it can update the open editor. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** Notify parent that a path was deleted so it can close the editor. */
  onPathDeleted?: (path: string) => void
}

type Loaded = { status: 'loaded'; entries: FileNode[] }
type Loading = { status: 'loading' }
type Errored = { status: 'error'; message: string }
type NodeState = Loaded | Loading | Errored

function sortEntries(entries: FileNode[]): FileNode[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

export function FileTree({
  vault,
  selectedPath,
  onSelect,
  onPathRenamed,
  onPathDeleted
}: TreeProps): JSX.Element {
  const [root, setRoot] = useState<NodeState>({ status: 'loading' })
  // Dirs we've expanded; null means "should be expanded but not loaded yet".
  const [expanded, setExpanded] = useState<Record<string, NodeState>>({})
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [actionsForPath, setActionsForPath] = useState<string | null>(null)

  // Reload helper: re-fetches a single directory's children. Empty string = root.
  const reloadDir = useCallback(
    async (dir: string): Promise<void> => {
      try {
        const entries = sortEntries(await vault.list(dir))
        if (dir === '') {
          setRoot({ status: 'loaded', entries })
        } else {
          setExpanded((prev) => ({ ...prev, [dir]: { status: 'loaded', entries } }))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (dir === '') setRoot({ status: 'error', message })
        else
          setExpanded((prev) => ({ ...prev, [dir]: { status: 'error', message } }))
      }
    },
    [vault]
  )

  useEffect(() => {
    void reloadDir('')
  }, [reloadDir])

  async function toggle(node: FileNode): Promise<void> {
    if (expanded[node.path]) {
      const next = { ...expanded }
      delete next[node.path]
      setExpanded(next)
      return
    }
    setExpanded((prev) => ({ ...prev, [node.path]: { status: 'loading' } }))
    await reloadDir(node.path)
  }

  // Ask the user for a name (prompt for v0; replace with a nicer modal later).
  function promptForName(message: string, defaultValue = ''): string | null {
    const value = window.prompt(message, defaultValue)
    if (value === null) return null
    const trimmed = value.trim()
    return trimmed.length === 0 ? null : trimmed
  }

  // Find the "create target" directory: the selected file's parent if any,
  // else the root. Lets the + buttons feel intuitive when a file is open.
  function currentDir(): string {
    if (!selectedPath) return ''
    return parentOf(selectedPath)
  }

  async function newFile(): Promise<void> {
    const name = promptForName('文件名（可含 / 创建嵌套路径）：')
    if (!name) return
    const dir = currentDir()
    const path = dir ? `${dir}/${name}` : name
    const finalPath = MD_EXT.test(path) ? path : `${path}.md`
    try {
      await vault.write(finalPath, '')
      await reloadDir(parentOf(finalPath))
      // Auto-open the new file so the user starts editing immediately.
      onSelect({
        name: finalPath.split('/').pop() ?? finalPath,
        path: finalPath,
        isDirectory: false,
        isMarkdown: true
      })
    } catch (err) {
      window.alert(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function newFolder(): Promise<void> {
    const name = promptForName('文件夹名（可含 / 创建嵌套目录）：')
    if (!name) return
    const dir = currentDir()
    const path = dir ? `${dir}/${name}` : name
    try {
      await vault.mkdir(path)
      await reloadDir(parentOf(path))
      // Auto-expand the parent so the new folder is visible.
      if (parentOf(path) !== '' && !expanded[parentOf(path)]) {
        await reloadDir(parentOf(path))
        setExpanded((prev) => ({
          ...prev,
          [parentOf(path)]: prev[parentOf(path)] ?? { status: 'loading' }
        }))
      }
    } catch (err) {
      window.alert(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function beginRename(node: FileNode): void {
    setRenamingPath(node.path)
    setRenameValue(node.name)
    setActionsForPath(null)
  }

  async function commitRename(node: FileNode): Promise<void> {
    const newName = renameValue.trim()
    setRenamingPath(null)
    if (!newName || newName === node.name) return
    const parent = parentOf(node.path)
    const newPath = parent ? `${parent}/${newName}` : newName
    try {
      await vault.rename(node.path, newPath)
      await reloadDir(parent)
      onPathRenamed?.(node.path, newPath)
    } catch (err) {
      window.alert(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function remove(node: FileNode): Promise<void> {
    setActionsForPath(null)
    const ok = window.confirm(
      node.isDirectory
        ? `删除文件夹 "${node.name}" 及其全部内容？此操作不可撤销。`
        : `删除文件 "${node.name}"？`
    )
    if (!ok) return
    try {
      if (node.isDirectory) {
        await vault.deleteDir(node.path, true)
      } else {
        await vault.delete(node.path)
      }
      await reloadDir(parentOf(node.path))
      onPathDeleted?.(node.path)
    } catch (err) {
      window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function renderRow(node: FileNode, depth: number): JSX.Element {
    const isSelected = node.path === selectedPath
    const isExpanded = !!expanded[node.path]
    const isMd = node.isMarkdown
    const isRenaming = renamingPath === node.path
    const showActions = actionsForPath === node.path
    return (
      <div key={node.path} className="group/row relative">
        <div
          className={[
            'w-full flex items-center gap-1 text-sm rounded transition-colors',
            isSelected
              ? 'bg-[--accent-soft] text-[--ink]'
              : 'hover:bg-[--paper-dim] text-[--ink-soft]'
          ].join(' ')}
        >
          <button
            type="button"
            onClick={() => {
              if (isRenaming) return
              if (node.isDirectory) void toggle(node)
              else if (isMd) onSelect(node)
            }}
            disabled={!node.isDirectory && !isMd}
            className={[
              'flex-1 flex items-center gap-1 text-left px-2 py-1 min-w-0',
              !node.isDirectory && !isMd ? 'opacity-50 cursor-default' : ''
            ].join(' ')}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <span className="w-3 text-[--ink-faint] text-xs shrink-0">
              {node.isDirectory ? (isExpanded ? '▾' : '▸') : ''}
            </span>
            {isRenaming ? (
              <RenameInput
                value={renameValue}
                onChange={setRenameValue}
                onCommit={() => void commitRename(node)}
                onCancel={() => setRenamingPath(null)}
              />
            ) : (
              <span className="truncate">{node.name}</span>
            )}
          </button>
          {!isRenaming && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setActionsForPath((p) => (p === node.path ? null : node.path))
              }}
              className="opacity-0 group-hover/row:opacity-100 transition-opacity px-2 text-[--ink-faint] hover:text-[--ink-soft]"
              aria-label="文件操作"
            >
              ⋯
            </button>
          )}
        </div>
        {showActions && (
          <RowMenu
            onClose={() => setActionsForPath(null)}
            actions={[
              { label: '重命名', onClick: () => beginRename(node) },
              { label: '删除', onClick: () => void remove(node), danger: true }
            ]}
          />
        )}
        {node.isDirectory && isExpanded && (
          <ChildList state={expanded[node.path]} depth={depth + 1} render={renderRow} />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-2 pt-2 pb-1">
        <span className="text-xs text-[--ink-faint] uppercase tracking-wider">
          Vault
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void newFile()}
            title="新建文件"
            className="text-sm text-[--ink-faint] hover:text-[--ink] hover:bg-[--paper-soft] rounded px-1.5 py-0.5"
          >
            📄+
          </button>
          <button
            type="button"
            onClick={() => void newFolder()}
            title="新建文件夹"
            className="text-sm text-[--ink-faint] hover:text-[--ink] hover:bg-[--paper-soft] rounded px-1.5 py-0.5"
          >
            📁+
          </button>
        </div>
      </header>
      {root.status === 'loading' ? (
        <div className="text-xs text-[--ink-faint] p-3">加载中…</div>
      ) : root.status === 'error' ? (
        <div className="text-xs text-[--accent] p-3">加载失败：{root.message}</div>
      ) : (
        <nav className="flex-1 flex flex-col py-1 scroll-thin overflow-y-auto">
          {root.entries.map((e) => renderRow(e, 0))}
        </nav>
      )}
    </div>
  )
}

function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={onCommit}
      className="bg-[--paper] border border-[--accent] rounded px-1 py-0 text-sm flex-1 min-w-0"
    />
  )
}

function RowMenu({
  actions,
  onClose
}: {
  actions: Array<{ label: string; onClick: () => void; danger?: boolean }>
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onAnyClick = (): void => onClose()
    // Defer to next tick so the click that opened us doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('click', onAnyClick), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('click', onAnyClick)
    }
  }, [onClose])
  return (
    <div className="absolute right-2 top-full z-30 mt-0.5 bg-[--paper] border border-[--rule] rounded shadow-md py-1 min-w-28">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            a.onClick()
          }}
          className={[
            'w-full text-left px-3 py-1 text-sm transition-colors',
            a.danger
              ? 'text-[--accent] hover:bg-[--accent-soft]'
              : 'text-[--ink-soft] hover:bg-[--paper-dim]'
          ].join(' ')}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}

function ChildList({
  state,
  depth,
  render
}: {
  state: NodeState
  depth: number
  render: (n: FileNode, d: number) => JSX.Element
}): JSX.Element {
  if (state.status === 'loading') {
    return (
      <div
        className="text-xs text-[--ink-faint] px-2 py-1"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        …
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div
        className="text-xs text-[--accent] px-2 py-1"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {state.message}
      </div>
    )
  }
  return <div>{state.entries.map((e) => render(e, depth))}</div>
}
