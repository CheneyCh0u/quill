import { useEffect, useState } from 'react'
import type { ViewableKind } from '@quill/shared-types'
import type { RemoteVault } from '@quill/vault-adapter'

/**
 * 只读查看器（#132）：图片与 PDF。字节走 vault.readBinary（resource 端点
 * + cookie 鉴权），Blob URL 交给浏览器原生渲染 — 零第三方依赖。与桌面端
 * FileViewer 同构。
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

export function FileViewer({
  vault,
  path,
  kind
}: {
  vault: RemoteVault
  path: string
  kind: ViewableKind
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setUrl(null)
    setError(null)
    vault
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
  }, [vault, path])

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--accent)]">
        无法读取文件:{error}
      </div>
    )
  }
  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--ink-faint)]">
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
