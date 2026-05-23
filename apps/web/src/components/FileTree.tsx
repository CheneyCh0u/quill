import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import type { FileNode } from '@quill/shared-types'
import type { VaultProvider } from '@quill/vault-adapter'
import {
  detectCollisions,
  isMarkdownFile,
  planUpload,
  uploadFiles,
  type UploadItem,
  type UploadResult
} from '../lib/upload'

type TreeProps = {
  vault: VaultProvider
  selectedPath: string | null
  onSelect: (node: FileNode) => void
  /** Notify parent that a path was renamed so it can update the open editor. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** Notify parent that a path was deleted so it can close the editor. */
  onPathDeleted?: (path: string) => void
}

/** Imperative API exposed via ref — Vault calls refresh() after agent
 *  runs so server-side file changes show up in the tree without a reload. */
export type FileTreeHandle = {
  /** Re-fetch the root + every currently-expanded directory. Skips
   *  unmounted subtrees (collapsed dirs that weren't loaded). */
  refresh(): Promise<void>
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

export const FileTree = forwardRef<FileTreeHandle, TreeProps>(function FileTree(
  { vault, selectedPath, onSelect, onPathRenamed, onPathDeleted },
  ref
): JSX.Element {
  const [root, setRoot] = useState<NodeState>({ status: 'loading' })
  // Dirs we've expanded; null means "should be expanded but not loaded yet".
  const [expanded, setExpanded] = useState<Record<string, NodeState>>({})
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [actionsForPath, setActionsForPath] = useState<string | null>(null)
  // Upload UI state. uploadTargetRef remembers which directory the next
  // file-picker pick targets — set before triggering input.click().
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<string>('')
  const [pendingCollisions, setPendingCollisions] = useState<{
    destDir: string
    nonColliding: UploadItem[]
    colliding: UploadItem[]
  } | null>(null)
  const [uploadStatus, setUploadStatus] = useState<
    | null
    | { phase: 'uploading'; done: number; total: number }
    | { phase: 'done'; results: UploadResult[] }
  >(null)

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

  // Expose imperative refresh() so Vault can ask us to re-fetch after an
  // out-of-band write (e.g. agent finished a tool run). We mirror
  // `expanded` into a ref so refresh sees the latest set without us
  // re-binding the imperative handle on every state change.
  const expandedRef = useRef(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  useImperativeHandle(
    ref,
    () => ({
      async refresh() {
        const dirs = ['', ...Object.keys(expandedRef.current)]
        // Refresh in parallel — independent fetches, no ordering needed.
        await Promise.all(dirs.map((d) => reloadDir(d)))
      }
    }),
    [reloadDir]
  )

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
        isMarkdown: true,
        isText: true
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

  function triggerUpload(destDir: string): void {
    uploadTargetRef.current = destDir
    setActionsForPath(null)
    // Reset value so picking the same file twice in a row still fires
    // onChange — browsers de-dupe identical paths otherwise.
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  async function performUpload(items: UploadItem[]): Promise<void> {
    if (items.length === 0) {
      setPendingCollisions(null)
      return
    }
    setPendingCollisions(null)
    setUploadStatus({ phase: 'uploading', done: 0, total: items.length })
    const results = await uploadFiles(vault, items, (done, total) => {
      setUploadStatus({ phase: 'uploading', done, total })
    })
    setUploadStatus({ phase: 'done', results })
    // Refresh every dir we touched (group by parent so we only re-fetch
    // each affected dir once).
    const dirs = new Set(items.map((i) => parentOf(i.destPath)))
    await Promise.all([...dirs].map((d) => reloadDir(d)))
    // Auto-clear the "done" toast after 3s.
    window.setTimeout(() => {
      setUploadStatus((cur) => (cur && cur.phase === 'done' ? null : cur))
    }, 3000)
  }

  async function onFilesPicked(files: File[]): Promise<void> {
    const destDir = uploadTargetRef.current
    // Filter to markdown files. accept="" hints the picker but isn't
    // enforced, so the user could still pick a .txt; quietly drop it.
    const accepted = files.filter(isMarkdownFile)
    if (accepted.length === 0) {
      window.alert('请选择 .md / .markdown 文件')
      return
    }
    const colliding = await detectCollisions(vault, destDir, accepted)
    const collidingNames = new Set(colliding.map((c) => c.file.name))
    const nonColliding = accepted
      .filter((f) => !collidingNames.has(f.name))
      .map((f) => ({
        file: f,
        destPath: destDir ? `${destDir}/${f.name}` : f.name
      }))
    if (colliding.length === 0) {
      await performUpload(planUpload(destDir, accepted))
      return
    }
    setPendingCollisions({ destDir, nonColliding, colliding })
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
              ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
              : 'hover:bg-[var(--paper-dim)] text-[var(--ink-soft)]'
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
            <span className="w-3 text-[var(--ink-faint)] text-xs shrink-0">
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
              className="opacity-0 group-hover/row:opacity-100 transition-opacity px-2 text-[var(--ink-faint)] hover:text-[var(--ink-soft)]"
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
              ...(node.isDirectory
                ? [{ label: '上传到这里', onClick: () => triggerUpload(node.path) }]
                : []),
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
        <span className="text-xs text-[var(--ink-faint)] uppercase tracking-wider">
          Vault
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void newFile()}
            title="新建文件"
            className="text-sm text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-1.5 py-0.5"
          >
            📄+
          </button>
          <button
            type="button"
            onClick={() => void newFolder()}
            title="新建文件夹"
            className="text-sm text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-1.5 py-0.5"
          >
            📁+
          </button>
          <button
            type="button"
            onClick={() => triggerUpload(currentDir())}
            title="上传 .md 文件"
            className="text-sm text-[var(--ink-faint)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] rounded px-1.5 py-0.5"
          >
            📤
          </button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.mdown,.mkd,text/markdown"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length === 0) return
          void onFilesPicked(files)
        }}
      />
      {root.status === 'loading' ? (
        <div className="text-xs text-[var(--ink-faint)] p-3">加载中…</div>
      ) : root.status === 'error' ? (
        <div className="text-xs text-[var(--accent)] p-3">加载失败：{root.message}</div>
      ) : (
        <nav className="flex-1 flex flex-col py-1 scroll-thin overflow-y-auto">
          {root.entries.map((e) => renderRow(e, 0))}
        </nav>
      )}

      {uploadStatus && <UploadStatusBar status={uploadStatus} />}

      {pendingCollisions && (
        <CollisionDialog
          destDir={pendingCollisions.destDir}
          nonColliding={pendingCollisions.nonColliding}
          colliding={pendingCollisions.colliding}
          onCancel={() => setPendingCollisions(null)}
          onSkipColliding={() => void performUpload(pendingCollisions.nonColliding)}
          onOverwriteAll={() =>
            void performUpload([
              ...pendingCollisions.nonColliding,
              ...pendingCollisions.colliding
            ])
          }
        />
      )}
    </div>
  )
})

function UploadStatusBar({
  status
}: {
  status:
    | { phase: 'uploading'; done: number; total: number }
    | { phase: 'done'; results: UploadResult[] }
}): JSX.Element {
  if (status.phase === 'uploading') {
    return (
      <div className="px-3 py-1.5 text-xs text-[var(--ink-soft)] border-t border-[var(--rule-soft)] bg-[var(--paper-dim)]">
        上传中 {status.done}/{status.total}…
      </div>
    )
  }
  const ok = status.results.filter((r) => r.ok).length
  const fail = status.results.length - ok
  return (
    <div
      className={[
        'px-3 py-1.5 text-xs border-t border-[var(--rule-soft)]',
        fail > 0 ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--ink-soft)] bg-[var(--paper-dim)]'
      ].join(' ')}
      title={status.results.filter((r) => !r.ok).map((r) => `${r.destPath}: ${r.error}`).join('\n')}
    >
      ✓ 上传 {ok} 个{fail > 0 ? `，失败 ${fail} 个` : ''}
    </div>
  )
}

function CollisionDialog({
  destDir,
  nonColliding,
  colliding,
  onCancel,
  onSkipColliding,
  onOverwriteAll
}: {
  destDir: string
  nonColliding: UploadItem[]
  colliding: UploadItem[]
  onCancel: () => void
  onSkipColliding: () => void
  onOverwriteAll: () => void
}): JSX.Element {
  const dirLabel = destDir || '根目录'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--ink)]/30 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[var(--paper)] border border-[var(--rule)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--rule)]">
          <h3 className="font-display text-lg text-[var(--ink)]" style={{ fontWeight: 500 }}>
            文件已存在
          </h3>
          <p className="text-xs text-[var(--ink-faint)] mt-1">
            目标目录：<span className="font-mono">{dirLabel}</span>
          </p>
        </div>
        <div className="px-5 py-3 space-y-3 text-sm">
          <p className="text-[var(--ink-soft)]">
            以下 {colliding.length} 个文件在目标目录中已存在：
          </p>
          <ul className="font-mono text-xs text-[var(--ink)] bg-[var(--paper-dim)] rounded p-2 max-h-32 overflow-y-auto">
            {colliding.map((c) => (
              <li key={c.file.name}>· {c.file.name}</li>
            ))}
          </ul>
          {nonColliding.length > 0 && (
            <p className="text-xs text-[var(--ink-faint)]">
              另有 {nonColliding.length} 个文件不冲突，将正常上传。
            </p>
          )}
        </div>
        <div className="px-5 py-3 bg-[var(--paper-dim)] border-t border-[var(--rule)] flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-xs text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] rounded"
          >
            取消
          </button>
          <div className="flex-1" />
          {nonColliding.length > 0 && (
            <button
              type="button"
              onClick={onSkipColliding}
              className="px-3 py-1 text-xs text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] rounded border border-[var(--rule)]"
            >
              仅传不冲突的（{nonColliding.length}）
            </button>
          )}
          <button
            type="button"
            onClick={onOverwriteAll}
            className="px-3 py-1 rounded bg-[var(--accent)] text-[var(--paper)] text-xs font-medium hover:opacity-90"
          >
            全部覆盖
          </button>
        </div>
      </div>
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
      className="bg-[var(--paper)] border border-[var(--accent)] rounded px-1 py-0 text-sm flex-1 min-w-0"
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
    <div className="absolute right-2 top-full z-30 mt-0.5 bg-[var(--paper)] border border-[var(--rule)] rounded shadow-md py-1 min-w-28">
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
              ? 'text-[var(--accent)] hover:bg-[var(--accent-soft)]'
              : 'text-[var(--ink-soft)] hover:bg-[var(--paper-dim)]'
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
        className="text-xs text-[var(--ink-faint)] px-2 py-1"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        …
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div
        className="text-xs text-[var(--accent)] px-2 py-1"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {state.message}
      </div>
    )
  }
  return <div>{state.entries.map((e) => render(e, depth))}</div>
}
