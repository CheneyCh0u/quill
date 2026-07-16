import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FileText, FolderPlus } from 'lucide-react'
import type { FileNode } from '../types'
import { useApp } from '../state/app'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

type Props = {
  nodes: FileNode[]
  /**
   * Parent path for "create at root" actions. Local: workspace.rootPath
   * (absolute fs path). Remote: empty string (server treats '' as vault
   * root). The two formats share the same join logic via joinTreePath.
   */
  rootParentPath: string
  currentPath: string | null
  dirty: boolean
  onSelect: (path: string) => void
}

type Editing =
  | { kind: 'rename'; path: string; initial: string }
  | { kind: 'new'; parentPath: string; entry: 'file' | 'folder' }

type MenuState = {
  x: number
  y: number
  /** Right-clicked node, or null for empty-area / root menu. */
  node: FileNode | null
}

export function FileTree({
  nodes,
  rootParentPath,
  currentPath,
  dirty,
  onSelect
}: Props): React.JSX.Element {
  const { createFileInTree, createFolderInTree, deleteTreeNode, renameTreeNode, askConfirm } =
    useApp()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  // Single shared error string — only the row currently being edited can
  // produce one, so one slot is enough.
  const [editError, setEditError] = useState<string | null>(null)

  // Cancel pending edit / close menu when the visible tree changes — happens
  // after a successful create/rename/delete since the tree gets re-listed.
  useEffect(() => {
    setEditing(null)
    setEditError(null)
  }, [nodes])

  function openMenu(e: React.MouseEvent, node: FileNode | null): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, node })
  }

  function startCreate(parentPath: string, entry: 'file' | 'folder'): void {
    setEditing({ kind: 'new', parentPath, entry })
    setEditError(null)
  }

  function startRename(node: FileNode): void {
    setEditing({ kind: 'rename', path: node.path, initial: node.name })
    setEditError(null)
  }

  async function commitEdit(value: string): Promise<void> {
    if (!editing) return
    try {
      if (editing.kind === 'new') {
        if (editing.entry === 'file') {
          await createFileInTree(editing.parentPath, value)
        } else {
          await createFolderInTree(editing.parentPath, value)
        }
      } else {
        await renameTreeNode(editing.path, value)
      }
      // `editing` is cleared by the useEffect on `nodes` change after the
      // tree re-list, so no setEditing(null) needed here. Setting it here
      // anyway is harmless.
      setEditing(null)
      setEditError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setEditError(humanizeFsError(msg, editing.kind))
    }
  }

  async function handleDelete(node: FileNode): Promise<void> {
    const ok = await askConfirm({
      title: node.isDirectory ? '删除文件夹？' : '删除文件？',
      message: node.isDirectory
        ? `「${node.name}」及其中所有内容将被删除，此操作不可恢复。`
        : `「${node.name}」将被删除，此操作不可恢复。`,
      danger: true,
      confirmLabel: '删除'
    })
    if (!ok) return
    try {
      await deleteTreeNode(node.path, node.isDirectory)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('delete failed', err)
    }
  }

  function menuItemsFor(node: FileNode | null): ContextMenuItem[] {
    // Root / empty-area menu — only create actions apply.
    if (!node) {
      return [
        { label: '新建文件', onClick: () => startCreate(rootParentPath, 'file') },
        { label: '新建文件夹', onClick: () => startCreate(rootParentPath, 'folder') }
      ]
    }
    const parentForCreate = node.isDirectory ? node.path : parentOf(node.path)
    return [
      { label: '新建文件', onClick: () => startCreate(parentForCreate, 'file') },
      { label: '新建文件夹', onClick: () => startCreate(parentForCreate, 'folder') },
      { label: '重命名', onClick: () => startRename(node), divider: true },
      { label: '删除', onClick: () => void handleDelete(node), danger: true, divider: true }
    ]
  }

  return (
    <>
      <div
        // The wrapper soaks up empty-area right-clicks. Stop the bubbling
        // chain at FileTreeNode so a child click doesn't reach this handler.
        onContextMenu={(e) => openMenu(e, null)}
        className="min-h-full"
      >
        <ul className="text-[13px] px-2">
          {editing?.kind === 'new' && editing.parentPath === rootParentPath && (
            <NewEntryRow
              depth={0}
              entry={editing.entry}
              error={editError}
              onCommit={commitEdit}
              onCancel={() => {
                setEditing(null)
                setEditError(null)
              }}
            />
          )}
          {nodes.map((n) => (
            <FileTreeNode
              key={n.path}
              node={n}
              depth={0}
              currentPath={currentPath}
              dirty={dirty}
              onSelect={onSelect}
              onContextMenu={openMenu}
              editing={editing}
              editError={editError}
              onCommitEdit={commitEdit}
              onCancelEdit={() => {
                setEditing(null)
                setEditError(null)
              }}
            />
          ))}
        </ul>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

type NodeProps = {
  node: FileNode
  depth: number
  currentPath: string | null
  dirty: boolean
  onSelect: (path: string) => void
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
  editing: Editing | null
  editError: string | null
  onCommitEdit: (value: string) => Promise<void>
  onCancelEdit: () => void
}

function FileTreeNode({
  node,
  depth,
  currentPath,
  dirty,
  onSelect,
  onContextMenu,
  editing,
  editError,
  onCommitEdit,
  onCancelEdit
}: NodeProps): React.JSX.Element {
  // Auto-expand a directory when a "new entry" prompt targets it, so the
  // input row is actually visible to the user.
  const shouldAutoOpen =
    node.isDirectory &&
    editing?.kind === 'new' &&
    editing.parentPath === node.path
  const [open, setOpen] = useState(depth === 0 || shouldAutoOpen)
  useEffect(() => {
    if (shouldAutoOpen) setOpen(true)
  }, [shouldAutoOpen])

  const padLeft = 6 + depth * 12
  const isCurrent = node.path === currentPath
  const isRenamingThis = editing?.kind === 'rename' && editing.path === node.path

  if (node.isDirectory) {
    return (
      <li>
        {isRenamingThis ? (
          <RenameRow
            depth={depth}
            initial={editing.initial}
            error={editError}
            onCommit={onCommitEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            onContextMenu={(e) => onContextMenu(e, node)}
            style={{ paddingLeft: padLeft }}
            className="no-drag w-full flex items-center gap-1 py-1 pr-2 rounded-md hover:bg-[var(--paper-soft)] text-[var(--ink)] transition"
          >
            <ChevronRight
              className={`w-3 h-3 shrink-0 transition-transform ${
                open ? 'rotate-90' : ''
              } text-[var(--ink-faint)]`}
            />
            <span className="truncate text-left flex-1">{node.name}</span>
          </button>
        )}
        {open && (
          <ul>
            {editing?.kind === 'new' && editing.parentPath === node.path && (
              <NewEntryRow
                depth={depth + 1}
                entry={editing.entry}
                error={editError}
                onCommit={onCommitEdit}
                onCancel={onCancelEdit}
              />
            )}
            {node.children?.map((c) => (
              <FileTreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                currentPath={currentPath}
                dirty={dirty}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                editing={editing}
                editError={editError}
                onCommitEdit={onCommitEdit}
                onCancelEdit={onCancelEdit}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  if (node.isText || node.isViewable) {
    return (
      <li>
        {isRenamingThis ? (
          <RenameRow
            depth={depth}
            initial={editing.initial}
            error={editError}
            onCommit={onCommitEdit}
            onCancel={onCancelEdit}
            indentExtra={16}
          />
        ) : (
          <button
            onClick={() => onSelect(node.path)}
            onContextMenu={(e) => onContextMenu(e, node)}
            style={{
              paddingLeft: padLeft + 16,
              boxShadow: isCurrent ? 'inset 2px 0 0 var(--accent)' : undefined
            }}
            className={`no-drag w-full flex items-center gap-1.5 py-1 pr-2 text-left rounded-md transition ${
              isCurrent
                ? 'bg-[var(--paper-soft)] text-[var(--ink)] font-medium'
                : 'hover:bg-[var(--paper-soft)] text-[var(--ink-soft)] hover:text-[var(--ink)]'
            }`}
          >
            <span className="text-[10px] shrink-0 text-[var(--ink-faint)]">▸</span>
            <span className="truncate flex-1">{node.name}</span>
            {isCurrent && dirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
            )}
          </button>
        )}
      </li>
    )
  }

  // Unsupported file type — still allow context menu (delete / rename).
  return (
    <li>
      <div
        onContextMenu={(e) => onContextMenu(e, node)}
        style={{ paddingLeft: padLeft + 16 }}
        className="flex items-center gap-1.5 py-1 pr-2 text-[var(--ink-ghost)] select-none cursor-default"
        title="不支持的文件类型"
      >
        <span className="text-[10px] shrink-0">▪</span>
        <span className="truncate">{node.name}</span>
      </div>
    </li>
  )
}

type EditRowProps = {
  depth: number
  initial?: string
  error: string | null
  onCommit: (value: string) => Promise<void>
  onCancel: () => void
  /** Extra left padding for file rows (matches the file-icon indent). */
  indentExtra?: number
}

function RenameRow(props: EditRowProps): React.JSX.Element {
  return <EditRow {...props} icon={<FileText className="w-3 h-3 text-[var(--ink-faint)]" />} />
}

type NewEntryRowProps = Omit<EditRowProps, 'initial' | 'indentExtra'> & {
  entry: 'file' | 'folder'
}

function NewEntryRow({ entry, ...rest }: NewEntryRowProps): React.JSX.Element {
  const icon =
    entry === 'folder' ? (
      <FolderPlus className="w-3 h-3 text-[var(--ink-faint)]" />
    ) : (
      <FileText className="w-3 h-3 text-[var(--ink-faint)]" />
    )
  return <EditRow {...rest} initial="" icon={icon} />
}

function EditRow({
  depth,
  initial = '',
  error,
  onCommit,
  onCancel,
  indentExtra = 0,
  icon
}: EditRowProps & { icon: React.ReactNode }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const padLeft = 6 + depth * 12 + indentExtra
  // Re-entrancy guard: blur fires after Enter on some platforms; without
  // this both would call onCommit/onCancel and double-submit.
  const submittedRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Select the base name (before the last dot) when renaming a file —
    // less typing for the common case of changing the name but keeping
    // the extension. New-entry rows have empty initial so this no-ops.
    const dot = initial.lastIndexOf('.')
    if (dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initial])

  return (
    <div style={{ paddingLeft: padLeft }} className="py-1 pr-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submittedRef.current = true
              void onCommit(value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              submittedRef.current = true
              onCancel()
            }
          }}
          onBlur={() => {
            if (submittedRef.current) return
            submittedRef.current = true
            onCancel()
          }}
          className="no-drag flex-1 min-w-0 px-1.5 py-0.5 text-[13px] font-mono bg-[var(--paper)] border border-[var(--accent)]/50 rounded-sm focus:outline-none focus:border-[var(--accent)]"
        />
      </div>
      {error && (
        <div className="font-serif-zh italic text-[11px] text-[var(--accent)] mt-1 pl-5">
          {error}
        </div>
      )}
    </div>
  )
}

function parentOf(path: string): string {
  const lastFwd = path.lastIndexOf('/')
  const lastBack = path.lastIndexOf('\\')
  const idx = Math.max(lastFwd, lastBack)
  return idx > 0 ? path.slice(0, idx) : ''
}

function humanizeFsError(msg: string, kind: 'new' | 'rename'): string {
  if (msg === 'TARGET_EXISTS' || msg.includes('TARGET_EXISTS')) {
    return kind === 'new' ? '已存在同名条目' : '目标名已被占用'
  }
  // server returns its own messages (e.g. "directory not empty") — pass
  // through after a generic prefix.
  return `操作失败：${msg}`
}
