import { useCallback, useEffect, useState } from 'react'
import { CloudOff, Folder, Loader2, X } from 'lucide-react'
import { ipc } from '../../lib/ipc'
import { usePrefs, type AutoSyncInterval } from '../../state/prefs'
import { PillGroup, Row, Toggle } from './controls'
import type { SyncSpace } from '../../types'

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

      <SyncSection serverConfigured={!!savedUrl && hasToken} />
    </div>
  )
}

const INTERVAL_OPTIONS: Array<{ value: AutoSyncInterval; label: string }> = [
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' }
]

/**
 * Folder-workspace cloud sync settings. The auto-sync switch + interval
 * are device-level prefs (localStorage, picked up by the main window via
 * the storage event); the space list reads the server registry.
 */
function SyncSection({ serverConfigured }: { serverConfigured: boolean }) {
  const { prefs, setPref } = usePrefs()
  const [spaces, setSpaces] = useState<SyncSpace[] | null>(null)
  const [spacesError, setSpacesError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const loadSpaces = useCallback(async () => {
    if (!serverConfigured) return
    setSpacesError(null)
    try {
      setSpaces(await ipc.sync.spaces())
    } catch (err) {
      setSpaces([])
      setSpacesError(err instanceof Error ? err.message : String(err))
    }
  }, [serverConfigured])

  useEffect(() => {
    void loadSpaces()
  }, [loadSpaces])

  const handleRemove = useCallback(
    async (id: string) => {
      setRemoving(id)
      try {
        await ipc.sync.removeSpace(id)
        await loadSpaces()
      } catch (err) {
        setSpacesError(err instanceof Error ? err.message : String(err))
      } finally {
        setRemoving(null)
      }
    },
    [loadSpaces]
  )

  return (
    <div className="mt-10">
      <h3 className="font-display text-[20px] text-[var(--ink)] mb-1" style={{ fontWeight: 500 }}>
        同步
      </h3>
      <p className="font-serif-zh italic text-[12.5px] text-[var(--ink-faint)] mb-4">
        文件夹工作区 ↔ 云端 vault
      </p>

      <Row label="自动同步" hint="仅推拉无冲突的改动">
        <div className="pt-1">
          <Toggle checked={prefs.autoSync} onChange={(v) => setPref('autoSync', v)} />
        </div>
      </Row>

      <Row label="同步间隔" hint="检查并同步的周期">
        <PillGroup
          options={INTERVAL_OPTIONS}
          value={prefs.autoSyncIntervalMin}
          onChange={(v) => setPref('autoSyncIntervalMin', v)}
        />
        <p className="font-serif-zh italic text-[11.5px] text-[var(--ink-faint)] mt-2">
          冲突永远不会被自动覆盖，需要在主窗口的同步面板里手动处理。
        </p>
      </Row>

      <Row label="同步空间" hint="记录在服务器，跨设备可见">
        {!serverConfigured ? (
          <p className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] pt-1.5">
            配置并连接服务器后可见。
          </p>
        ) : spaces === null ? (
          <p className="flex items-center gap-2 text-[12px] text-[var(--ink-faint)] pt-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> 加载中…
          </p>
        ) : spaces.length === 0 ? (
          <p className="font-serif-zh italic text-[12px] text-[var(--ink-faint)] pt-1.5">
            还没有文件夹开启同步。在主窗口状态栏点击同步图标即可开启。
          </p>
        ) : (
          <div className="space-y-1.5">
            {spaces.map((s) => (
              <div
                key={s.id}
                className="px-3 py-2 rounded-md border border-[var(--rule-soft)] bg-[var(--paper-dim)] flex items-center gap-2.5"
              >
                <Folder className="w-3.5 h-3.5 text-[var(--ink-faint)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-[var(--ink)] truncate">
                    {s.name}{' '}
                    <span className="font-mono text-[10.5px] text-[var(--ink-faint)]">
                      → /{s.remotePath}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => void handleRemove(s.id)}
                  disabled={removing !== null}
                  title="解除同步记录（不删任何文件）"
                  className="p-1 rounded text-[var(--ink-ghost)] hover:text-[var(--accent)] disabled:opacity-50 transition"
                >
                  {removing === s.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                </button>
              </div>
            ))}
            <p className="font-serif-zh italic text-[11px] text-[var(--ink-faint)] pt-1">
              解除同步只移除服务器上的记录，本地与云端文件都不会被删除。
            </p>
          </div>
        )}
        {spacesError && (
          <p className="font-serif-zh italic text-[11.5px] text-[var(--accent)] mt-1.5 break-all">
            {spacesError}
          </p>
        )}
      </Row>
    </div>
  )
}
