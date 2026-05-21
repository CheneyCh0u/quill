import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { FileNode } from '../types'

type Props = {
  nodes: FileNode[]
  currentPath: string | null
  dirty: boolean
  onSelect: (path: string) => void
}

export function FileTree({ nodes, currentPath, dirty, onSelect }: Props) {
  return (
    <ul className="text-[13px] px-2">
      {nodes.map((n) => (
        <FileTreeNode
          key={n.path}
          node={n}
          depth={0}
          currentPath={currentPath}
          dirty={dirty}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

type NodeProps = {
  node: FileNode
  depth: number
  currentPath: string | null
  dirty: boolean
  onSelect: (path: string) => void
}

function FileTreeNode({ node, depth, currentPath, dirty, onSelect }: NodeProps) {
  const [open, setOpen] = useState(depth === 0)
  const padLeft = 6 + depth * 12
  const isCurrent = node.path === currentPath

  if (node.isDirectory) {
    return (
      <li>
        <button
          onClick={() => setOpen((v) => !v)}
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
        {open && node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((c) => (
              <FileTreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                currentPath={currentPath}
                dirty={dirty}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  if (node.isMarkdown) {
    return (
      <li>
        <button
          onClick={() => onSelect(node.path)}
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
      </li>
    )
  }

  return (
    <li>
      <div
        style={{ paddingLeft: padLeft + 16 }}
        className="flex items-center gap-1.5 py-1 pr-2 text-[var(--ink-ghost)] select-none cursor-default"
        title="只支持打开 .md 文件"
      >
        <span className="text-[10px] shrink-0">▪</span>
        <span className="truncate">{node.name}</span>
      </div>
    </li>
  )
}
