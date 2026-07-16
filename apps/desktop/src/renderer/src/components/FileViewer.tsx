import { useEffect, useState } from 'react'
import type { ViewableKind } from '@quill/shared-types'
import { ipc } from '../lib/ipc'

/**
 * 只读查看器（#132）：图片与 PDF。字节走 vault.readBinary（本地 = IPC，
 * remote = resource 端点 + 鉴权头），包成 Blob URL 后交给浏览器原生渲染
 * （<img> / Chromium 内建 PDF viewer）——零第三方依赖。
 */

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf'
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

export function FileViewer({ path, kind }: { path: string; kind: ViewableKind }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setUrl(null)
    setError(null)
    ipc.vault
      .readBinary(path)
      .then((bytes) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) }))
        setUrl(objectUrl)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-[var(--accent)] font-serif-zh italic">
        无法读取文件：{error}
      </div>
    )
  }
  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-[var(--ink-faint)] font-serif-zh italic">
        加载中…
      </div>
    )
  }
  if (kind === 'pdf') {
    return <iframe src={url} title={path} className="w-full h-full border-0 bg-[var(--paper-dim)]" />
  }
  return (
    <div className="h-full overflow-auto flex items-center justify-center p-6 bg-[var(--paper-dim)]">
      <img src={url} alt={path} className="max-w-full max-h-full object-contain shadow-md rounded-sm" />
    </div>
  )
}
