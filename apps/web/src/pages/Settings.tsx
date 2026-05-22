import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  providersApi,
  type CatalogEntry,
  type ConfiguredProvider
} from '../lib/providers-api'
import { UnauthorizedError } from '@quill/vault-adapter'

const PROVIDER_LABELS: Record<string, string> = {
  kimi: 'Kimi · Coding Plan',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  glm: '智谱 GLM',
  qwen: '通义千问 Qwen'
}

/** 262144 → "262K", 1_000_000 → "1.0M". Mirrors the desktop formatter so
 *  context-window annotations match across clients. */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M'
  return Math.round(tokens / 1000) + 'K'
}

export function Settings(): JSX.Element {
  const navigate = useNavigate()
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [configured, setConfigured] = useState<ConfiguredProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [modal, setModal] = useState<{ provider: CatalogEntry; existing: boolean } | null>(null)

  const reload = useCallback(async () => {
    try {
      const [cat, conf] = await Promise.all([
        providersApi.catalog(),
        providersApi.list()
      ])
      setCatalog(cat)
      setConfigured(conf)
      setLoading(false)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        navigate('/login', { replace: true })
        return
      }
      setLoadErr(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [navigate])

  useEffect(() => {
    void reload()
  }, [reload])

  const configuredMap = new Map(configured.map((c) => [c.id, c]))

  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--paper)]">
      <header className="h-12 flex items-center gap-3 px-3 border-b border-[var(--rule-soft)]">
        <Link
          to="/"
          className="text-[var(--ink-soft)] hover:text-[var(--ink)] text-sm px-2 py-1"
        >
          ← 返回
        </Link>
        <span className="font-display text-lg text-[var(--ink)]">设置</span>
      </header>
      <main className="flex-1 overflow-y-auto scroll-thin">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <h2 className="font-display text-2xl text-[var(--ink)] mb-1" style={{ fontWeight: 500 }}>
            大模型供应商
          </h2>
          <p className="font-serif-zh italic text-sm text-[var(--ink-faint)] mb-6">
            AI Providers · 配置 API key 后即可在 agent 面板里使用
          </p>

          {loadErr && (
            <div className="text-sm text-[var(--accent)] mb-4">{loadErr}</div>
          )}
          {loading ? (
            <div className="text-sm text-[var(--ink-faint)]">加载中…</div>
          ) : catalog.length === 0 ? (
            <div className="text-sm text-[var(--ink-faint)]">
              没有可配置的 provider（catalog 为空）。
            </div>
          ) : (
            <ul className="space-y-1">
              {catalog.map((p) => {
                const conf = configuredMap.get(p.id)
                return (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 py-3 px-3 rounded-md hover:bg-[var(--paper-dim)] transition"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--ink)]">
                          {PROVIDER_LABELS[p.id] ?? p.id}
                        </span>
                        {conf && (
                          <span className="text-[10px] uppercase tracking-wider text-[var(--accent)] font-medium">
                            ✓ 已配置
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-[var(--ink-faint)] truncate mt-0.5">
                        {conf
                          ? `${conf.models[0] ?? p.defaultModelId} · ${p.baseURL}`
                          : `默认 ${p.defaultModelId} · ${p.baseURL}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setModal({ provider: p, existing: !!conf })}
                      className="px-3 py-1 rounded text-xs text-[var(--ink-soft)] hover:text-[var(--ink)] hover:bg-[var(--paper-soft)] transition"
                    >
                      {conf ? '编辑' : '配置'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <p className="font-serif-zh italic text-xs text-[var(--ink-faint)] mt-6 leading-relaxed">
            API key 以 0600 权限写入 server 的{' '}
            <code className="font-mono not-italic">/data/state/providers.json</code>
            ，对应主机上的 <code className="font-mono not-italic">./state/providers.json</code>。
            重启容器 / 重 build 镜像都不会丢。
          </p>
        </div>
      </main>

      {modal && (
        <ProviderModal
          provider={modal.provider}
          existing={configuredMap.get(modal.provider.id) ?? null}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

type ModalProps = {
  provider: CatalogEntry
  existing: ConfiguredProvider | null
  onClose: () => void
  onSaved: () => void
}

function ProviderModal({ provider, existing, onClose, onSaved }: ModalProps): JSX.Element {
  const editing = !!existing
  const [apiKey, setApiKey] = useState('')
  const initialModel = existing?.models[0] ?? provider.defaultModelId
  const [model, setModel] = useState(initialModel)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)

  async function handleSave(): Promise<void> {
    setError(null)
    if (!model) {
      setError('Model 不能为空')
      return
    }
    const trimmed = apiKey.trim()
    if (!editing && !trimmed) {
      setError('请输入 API Key')
      return
    }
    setBusy('save')
    try {
      await providersApi.upsert({
        id: provider.id,
        api_key: trimmed || undefined,
        model
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function handleRemove(): Promise<void> {
    setBusy('remove')
    try {
      await providersApi.remove(provider.id)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--ink)]/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[var(--paper)] border border-[var(--rule)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--rule)]">
          <h3 className="font-display text-lg text-[var(--ink)]" style={{ fontWeight: 500 }}>
            {editing ? '编辑' : '配置'} {PROVIDER_LABELS[provider.id] ?? provider.id}
          </h3>
          <div className="font-mono text-[11px] text-[var(--ink-faint)] mt-1 truncate">
            {provider.baseURL}
          </div>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--ink)] mb-1">
              API Key
              {editing && (
                <span className="font-serif-zh italic text-[10px] text-[var(--ink-faint)] ml-2">
                  留空则保留原 key
                </span>
              )}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                if (error) setError(null)
              }}
              placeholder={editing ? '••••••••' : 'sk-...'}
              autoFocus
              className="w-full px-3 py-2 rounded bg-[var(--paper-dim)] border border-[var(--rule)] text-sm font-mono outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--ink)] mb-1">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--paper-dim)] border border-[var(--rule)] text-sm outline-none focus:border-[var(--accent)]"
            >
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                  {m.contextTokens > 0 ? ` · ${formatContext(m.contextTokens)}` : ''}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="text-xs text-[var(--accent)]">{error}</div>
          )}
        </div>
        <div className="px-5 py-3 bg-[var(--paper-dim)] border-t border-[var(--rule)] flex items-center gap-2">
          {editing && (
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={busy !== null}
              className="px-3 py-1 text-xs text-[var(--ink-faint)] hover:text-[var(--accent)] disabled:opacity-40"
            >
              {busy === 'remove' ? '删除中…' : '删除'}
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className="px-3 py-1 text-xs text-[var(--ink-soft)] hover:bg-[var(--paper-soft)] rounded"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy !== null}
            className="px-4 py-1 rounded bg-[var(--ink)] text-[var(--paper)] text-xs font-medium hover:opacity-90 disabled:opacity-40"
          >
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
