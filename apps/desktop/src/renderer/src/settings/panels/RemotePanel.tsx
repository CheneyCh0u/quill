import { useCallback, useEffect, useState } from 'react'
import { CloudOff, Loader2 } from 'lucide-react'
import { ipc } from '../../lib/ipc'

/**
 * Settings panel for the saved remote-vault connection.
 *
 * Settings runs in its own Electron window, so this panel can't touch
 * the main window's *active* vault — it only mutates the persisted URL +
 * token. The next time the user clicks "连接远程" or the footer cloud
 * icon in the main window, those updated credentials are picked up.
 */
function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function RemotePanel() {
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [hasToken, setHasToken] = useState(false)
  const [url, setUrl] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'save' | 'disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [u, t] = await Promise.all([ipc.remote.getUrl(), ipc.remote.getToken()])
    setSavedUrl(u)
    setHasToken(!!t)
    setUrl(u ?? '')
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleSave = useCallback(async (): Promise<void> => {
    const base = normalizeUrl(url)
    if (!base) {
      setError('请输入服务器 URL')
      return
    }
    if (!password) {
      setError('请输入访问密码')
      return
    }
    setBusy('save')
    setError(null)
    setNotice(null)
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
      await ipc.remote.setUrl(base)
      await ipc.remote.setToken(body.token)
      setPassword('')
      setNotice('已保存。回到主窗口点击云图标即可连接。')
      await reload()
    } catch (err) {
      setError(`连接失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }, [url, password, reload])

  const handleDisconnect = useCallback(async (): Promise<void> => {
    setBusy('disconnect')
    setError(null)
    setNotice(null)
    try {
      await ipc.remote.clear()
      setPassword('')
      setNotice('已断开。已保存的 URL 和 token 都被清除。')
      await reload()
    } finally {
      setBusy(null)
    }
  }, [reload])

  return (
    <div className="max-w-[520px]">
      <h2
        className="font-display text-[28px] text-[var(--ink)] mb-1"
        style={{ fontWeight: 500 }}
      >
        远程
      </h2>
      <p className="font-serif-zh italic text-[13px] text-[var(--ink-faint)] mb-6">
        Quill 自部署服务连接
      </p>

      <div className="mb-6 px-4 py-3 rounded-md bg-[var(--paper-soft)] border border-[var(--rule-soft)]">
        <div className="flex items-center gap-2 text-[12px] text-[var(--ink-soft)]">
          <span className="text-[var(--ink-faint)]">当前已保存</span>
          {savedUrl ? (
            <span className="font-mono text-[var(--ink)] truncate">{savedUrl}</span>
          ) : (
            <span className="font-serif-zh italic text-[var(--ink-faint)]">
              尚未配置
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--ink-faint)]">
          <span>session token：</span>
          {hasToken ? (
            <span className="text-[var(--ink-soft)]">已保存</span>
          ) : (
            <span className="font-serif-zh italic">未保存</span>
          )}
        </div>
      </div>

      <div className="space-y-4">
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
              if (e.key === 'Enter' && busy === null) void handleSave()
            }}
            placeholder="••••••••"
            className="no-drag w-full px-3 py-1.5 rounded-md bg-[var(--paper)] text-[13px] font-mono text-[var(--ink)] border border-[var(--rule)] focus:outline-none focus:border-[var(--accent)]/50"
          />
          <p className="font-serif-zh italic text-[11.5px] text-[var(--ink-faint)] mt-1">
            保存时会向服务端登录一次以验证凭据。密码不会持久化，仅保留 session
            token。
          </p>
        </div>

        {error && (
          <div className="font-serif-zh italic text-[12px] text-[var(--accent)]">
            {error}
          </div>
        )}
        {notice && !error && (
          <div className="font-serif-zh italic text-[12px] text-[var(--ink-faint)]">
            {notice}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={() => void handleSave()}
            disabled={busy !== null}
            className="no-drag px-4 py-1.5 rounded-md bg-[var(--accent)] text-[var(--paper)] text-[12.5px] font-medium hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {savedUrl ? '保存并重新登录' : '保存并连接'}
          </button>
          {(savedUrl || hasToken) && (
            <button
              onClick={() => void handleDisconnect()}
              disabled={busy !== null}
              className="no-drag px-3 py-1.5 rounded-md text-[12.5px] text-[var(--ink-soft)] border border-[var(--rule)] hover:bg-[var(--paper-soft)] hover:text-[var(--ink)] transition disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy === 'disconnect' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CloudOff className="w-3.5 h-3.5" />
              )}
              断开
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
