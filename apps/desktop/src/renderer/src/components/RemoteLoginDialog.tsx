import { useEffect, useState } from 'react'
import { ipc, switchToRemote } from '../lib/ipc'
import { useApp } from '../state/app'

type Props = {
  /** Prefill URL from last connection (if any). */
  initialUrl?: string
  onClose: () => void
}

/**
 * "Connect to remote server" modal. Posts to <url>/api/auth/login with
 * the password, stashes the returned token via the main-process keychain
 * store, swaps ipc.vault to a Bearer-authenticated RemoteVault, then asks
 * AppContext to open the workspace from the server's root.
 *
 * On failure the modal stays open with an inline error so the user can
 * fix the URL/password without losing what they typed.
 */
export function RemoteLoginDialog({ initialUrl, onClose }: Props): JSX.Element {
  const { openRemoteAt } = useApp()
  const [url, setUrl] = useState(initialUrl ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Normalize URL: strip trailing slash so we can safely append `/api/...`.
  function normalize(raw: string): string {
    return raw.replace(/\/+$/, '')
  }

  async function handleConnect(): Promise<void> {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setError('请输入服务器 URL')
      return
    }
    if (!password) {
      setError('请输入密码')
      return
    }
    setBusy(true)
    setError(null)
    const base = normalize(trimmedUrl)
    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })
      if (res.status === 401) {
        setError('密码错误')
        return
      }
      if (!res.ok) {
        setError(`登录失败：${res.status} ${res.statusText}`)
        return
      }
      const body = (await res.json()) as { ok?: boolean; token?: string }
      if (!body.token) {
        setError('服务端未返回 token；可能是旧版本服务，需升级')
        return
      }
      // Persist + switch vault + open workspace.
      await ipc.remote.setUrl(base)
      await ipc.remote.setToken(body.token)
      switchToRemote({
        url: base,
        getToken: () => ipc.remote.getToken()
      })
      await openRemoteAt(base)
      onClose()
    } catch (err) {
      setError(`连接失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-[var(--ink)]/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[460px] rounded-[12px] bg-[var(--paper)] border border-[var(--rule)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--rule)]">
          <h3 className="font-display text-[18px] text-[var(--ink)]" style={{ fontWeight: 500 }}>
            连接远程 vault
          </h3>
          <p className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] mt-1">
            用 Quill 自部署服务作为 vault 来源。文件读写都走 HTTP API。
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-[var(--ink)] mb-1">
              服务器 URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (error) setError(null)
              }}
              placeholder="https://quill.example.com"
              autoFocus
              className="no-drag w-full px-3 py-1.5 rounded-md bg-[var(--paper)] text-[13px] font-mono text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/50"
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-[var(--ink)] mb-1">
              访问密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void handleConnect()
              }}
              placeholder="••••••••"
              className="no-drag w-full px-3 py-1.5 rounded-md bg-[var(--paper)] text-[13px] font-mono text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/50"
            />
          </div>

          {error && (
            <div className="font-serif-zh italic text-[12px] text-[var(--accent)]">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-[var(--paper-dim)] border-t border-[var(--rule)] flex items-center gap-2">
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="no-drag px-3 py-1.5 rounded-md text-[12px] text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={() => void handleConnect()}
            disabled={busy}
            className="no-drag px-4 py-1.5 rounded-md bg-[var(--accent)] text-[var(--paper)] text-[12.5px] font-medium hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? '连接中…' : '连接'}
          </button>
        </div>
      </div>
    </div>
  )
}
